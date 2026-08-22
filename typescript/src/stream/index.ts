// The session stream WebSocket client (protocol v3, server -> client, one
// JSON frame per message):
//
//   snapshot:       { type, protocol, earliest_feed_seq, session, messages }
//   records_append: { type, records }          — raw session records, by feed_seq
//   messages:       { type, messages }         — the OPEN inbox slice (LWW)
//   session:        { type, session }          — the lean session, resent on change
//   delta:          { type, agent_turn_id, kind, text?, output_tokens? }
//   heartbeat:      { type, ts }
//   done:           { type }                    — conversation over; close 1000 follows
//   error:          { type, message }           — curated copy; close 1011 follows
//
// Delivery classes: records_append is cursored append-only — the ONE resume
// cursor (`after_seq` = the highest feed_seq seen in records_append frames;
// messages/session frames NEVER advance it). session/messages are
// last-writer-wins snapshots; delta/heartbeat are fire-and-forget; done/error
// are terminal. Unknown frame types (and unknown source/record_type/kind
// values) MUST be ignored — additive server changes are not a protocol break.
//
// Transport is injected (`openSocket`), so the same reconnect/resume machinery
// serves every door: a browser opens the ticket-authed dashboard socket, a
// terminal or server opens the bearer-authed socket.

import type { Session, SessionRecord, StreamFrame } from '../types';

export type { StreamFrame };

// The one protocol version this client speaks; sent as `?protocol=` on the
// handshake and echoed by the snapshot frame.
export const SESSION_STREAM_PROTOCOL_VERSION = 3;

// Close codes — the published contract (§3.5).
export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_UNSUPPORTED_PROTOCOL_VERSION = 1002;
export const WS_CLOSE_NO_PROTOCOL = 1003;
export const WS_CLOSE_AUTH_FAILED = 1008;
export const WS_CLOSE_SERVER_ERROR = 1011;
export const WS_CLOSE_OVER_CAPACITY = 1013;

// The display word for a session: the server-derived surface status
// (working/waiting/sleeping/starting/closed/…) when present, else the raw
// per-execution status. Shared by every frame consumer so the stream and a
// REST poll can never disagree about the word.
export function sessionStatusWord(session: Session): string {
  return session.surface?.status ?? session.status;
}

// How streamSession() finished. `done`/`error` are normal terminal outcomes
// (`status` is the last session frame's derived word); `aborted` means the
// caller cancelled via the AbortSignal.
export type StreamOutcome =
  | { type: 'done'; status: string; exitStatus: string | null }
  | { type: 'error'; message: string }
  | { type: 'aborted' };

// Thrown when streaming isn't usable (the endpoint is missing, the protocol
// is unsupported, or reconnects are exhausted) — the caller should fall back
// to REST polling.
export class StreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamUnavailableError';
  }
}

// Thrown when the server rejects the credential for this session. Polling
// would fail the same way, so this is not a fallback case.
export class StreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamAuthError';
  }
}

// Minimal socket surface streamSession() depends on, so any WebSocket
// implementation (browser, `ws`, Bun) adapts in a few lines and tests can
// drive the reconnect/resume logic without a real server.
export interface StreamSocket {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
  onError(cb: (err: Error) => void): void;
  close(): void;
}

// The injected transport: open one socket for this session, resuming after
// `afterSeq`. `query` is the prebuilt handshake query string
// (`protocol=3&after_seq=N`) — append it to whatever URL the door uses (plus
// door-specific auth: a `?ticket=`, a bearer header). May be async (the
// dashboard door fetches a short-lived ticket per connection).
export type OpenSocket = (args: {
  sessionId: string;
  afterSeq: number;
  query: string;
}) => StreamSocket | Promise<StreamSocket>;

// The v3 handshake query (§3.1): `?protocol=` is REQUIRED — a server that
// doesn't see it closes 1003; an unknown version closes 1002 with the
// supported list in the reason. after_seq is omitted at 0 (full replay).
export function streamQuery(afterSeq: number): string {
  const base = `protocol=${SESSION_STREAM_PROTOCOL_VERSION}`;
  return afterSeq > 0 ? `${base}&after_seq=${afterSeq}` : base;
}

// Server heartbeat cadence is 20s; if we hear nothing for ~2x that the socket
// is presumed dead and we reconnect (the protocol's own liveness rule).
const HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RECONNECTS = 5;

// ----------------------------- pure helpers --------------------------------

export type CloseKind = 'normal' | 'auth' | 'unsupported' | 'retry';

export function classifyCloseCode(code: number): CloseKind {
  switch (code) {
    case WS_CLOSE_NORMAL:
      return 'normal';
    case WS_CLOSE_AUTH_FAILED:
    case 4401: // dashboard ticket door: bad/expired ticket
    case 4403: // dashboard ticket door: not this customer's session
      return 'auth';
    case WS_CLOSE_UNSUPPORTED_PROTOCOL_VERSION:
    case WS_CLOSE_NO_PROTOCOL: // shouldn't happen — we always send ?protocol=
      return 'unsupported';
    default:
      // 1011 server error, 1013 over capacity, 1006 abnormal, etc.
      return 'retry';
  }
}

// Exponential backoff, capped. Deterministic (no jitter) so it's easy to test.
export function nextReconnectDelayMs(attempt: number): number {
  const base = 500;
  const max = 8_000;
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

export interface ReconnectDecision {
  action: 'reconnect' | 'fallback' | 'fail-auth';
  delayMs?: number;
}

// Decide what to do after a connection ends without a terminal frame. Pure, so
// the reconnect/resume/fallback policy is unit-tested directly. `attempt`
// counts CONSECUTIVE failed connections — the caller resets it once a
// connection delivers a frame, so a long-lived stream that hiccups every few
// hours never exhausts its budget.
export function decideReconnect(params: {
  closeKind?: CloseKind;
  everReceivedFrame: boolean;
  attempt: number;
  maxReconnects: number;
}): ReconnectDecision {
  const { closeKind, everReceivedFrame, attempt, maxReconnects } = params;
  if (closeKind === 'auth') return { action: 'fail-auth' };
  if (closeKind === 'unsupported') return { action: 'fallback' };
  // Retryable: a transport error, an abnormal close, or a normal close that
  // arrived before the `done` frame. Be persistent once we've seen the server
  // actually stream (it clearly supports it); bail out fast otherwise so a
  // backend without the endpoint falls back promptly.
  const cap = everReceivedFrame ? maxReconnects : Math.min(2, maxReconnects);
  if (attempt >= cap) return { action: 'fallback' };
  return { action: 'reconnect', delayMs: nextReconnectDelayMs(attempt) };
}

// ------------------------------ connection ---------------------------------

type ConnResult =
  | { kind: 'done' }
  | { kind: 'frameError'; message: string }
  | { kind: 'closed'; code: number }
  | { kind: 'error'; err: Error }
  | { kind: 'aborted' };

// One WebSocket connection. Resolves when the stream reaches a terminal frame,
// the socket closes/errors, the heartbeat lapses, or the signal aborts.
function connectOnce(
  sock: StreamSocket,
  emit: (frame: StreamFrame) => void,
  signal?: AbortSignal
): Promise<ConnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ConnResult) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearTimeout(heartbeat);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.close();
      resolve(result);
    };
    const onAbort = () => finish({ kind: 'aborted' });
    const bumpHeartbeat = () => {
      if (heartbeat) clearTimeout(heartbeat);
      heartbeat = setTimeout(
        () => finish({ kind: 'error', err: new Error('heartbeat timeout') }),
        HEARTBEAT_TIMEOUT_MS
      );
    };

    if (signal) {
      if (signal.aborted) {
        finish({ kind: 'aborted' });
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    sock.onOpen(() => bumpHeartbeat());
    sock.onMessage((data) => {
      bumpHeartbeat();
      let frame: StreamFrame;
      try {
        frame = JSON.parse(data) as StreamFrame;
      } catch {
        return; // ignore non-JSON keepalives / garbage
      }
      emit(frame);
      if (frame.type === 'done') {
        finish({ kind: 'done' });
      } else if (frame.type === 'error') {
        finish({
          kind: 'frameError',
          message: (frame as { message?: string }).message ?? 'stream error',
        });
      }
    });
    sock.onClose((code) => finish({ kind: 'closed', code }));
    sock.onError((err) => finish({ kind: 'error', err }));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// ------------------------------ public API ---------------------------------

export interface StreamSessionOptions {
  sessionId: string;
  openSocket: OpenSocket;
  onFrame: (frame: StreamFrame) => void;
  afterSeq?: number;
  signal?: AbortSignal;
  maxReconnects?: number;
}

// Stream an agent session to completion, reconnecting with backoff and
// resuming from the last records_append feed_seq so a dropped socket loses no
// records (§3.4: ONLY records advance the cursor — session/messages snapshots
// are re-sent fresh on reconnect). Calls `onFrame` for every frame received.
// Resolves with the terminal outcome — `done`'s status/exitStatus come from
// the last session frame, which the server guarantees carries the end state
// before `done`. Throws StreamUnavailableError (caller should poll instead) /
// StreamAuthError.
export async function streamSession(
  opts: StreamSessionOptions
): Promise<StreamOutcome> {
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;

  let afterSeq = opts.afterSeq ?? 0;
  let everReceivedFrame = false;
  let attempt = 0;
  let lastStatusWord = '';
  let lastExitStatus: string | null = null;

  const emit = (frame: StreamFrame) => {
    everReceivedFrame = true;
    // A delivered frame proves this connection works — reset the consecutive-
    // failure counter so a later drop gets a fresh reconnect budget.
    attempt = 0;
    if (frame.type === 'records_append') {
      const records = (frame as { records: SessionRecord[] }).records;
      for (const record of records) {
        if (typeof record.feed_seq === 'number') {
          afterSeq = Math.max(afterSeq, record.feed_seq);
        }
      }
    } else if (frame.type === 'snapshot' || frame.type === 'session') {
      const session = (frame as { session: Session }).session;
      lastStatusWord = sessionStatusWord(session);
      lastExitStatus = session.exit_status ?? null;
    }
    opts.onFrame(frame);
  };

  for (;;) {
    if (opts.signal?.aborted) return { type: 'aborted' };
    let res: ConnResult;
    try {
      const sock = await opts.openSocket({
        sessionId: opts.sessionId,
        afterSeq,
        query: streamQuery(afterSeq),
      });
      res = await connectOnce(sock, emit, opts.signal);
    } catch (err) {
      // The transport couldn't even open a socket (ticket fetch failed, DNS,
      // …) — same retry/fallback policy as a dropped connection.
      res = {
        kind: 'error',
        err: err instanceof Error ? err : new Error(String(err)),
      };
    }

    if (res.kind === 'done') {
      return {
        type: 'done',
        status: lastStatusWord,
        exitStatus: lastExitStatus,
      };
    }
    if (res.kind === 'frameError')
      return { type: 'error', message: res.message };
    if (res.kind === 'aborted') return { type: 'aborted' };

    attempt++;
    const decision = decideReconnect({
      closeKind:
        res.kind === 'closed' ? classifyCloseCode(res.code) : undefined,
      everReceivedFrame,
      attempt,
      maxReconnects,
    });
    if (decision.action === 'fail-auth') {
      throw new StreamAuthError('not authorized to stream this session');
    }
    if (decision.action === 'fallback') {
      const why =
        res.kind === 'error'
          ? res.err.message
          : `stream closed (code ${res.code})`;
      throw new StreamUnavailableError(why);
    }
    await sleep(decision.delayMs ?? 0, opts.signal);
  }
}
