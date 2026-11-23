// The session lifecycle sugar: a handle over one agent session. Hand-written
// by design (the start -> stream -> message -> stop flow is an ergonomics
// judgment, not a projection of the spec). Everything the handle does rides
// the generated core. `stream()` rides `@ellipsis-dev/sdk/stream` over the
// ticket door and the runtime's own WebSocket; a caller with another door
// (a bearer header, the `ws` package) drives that stream client itself.

import type { components } from '../generated/openapi';
import {
  adaptWebSocket,
  streamSession,
  StreamUnavailableError,
  type StreamFrame,
} from '../stream/index';
import type { Page } from './pagination';

type S = components['schemas'];

// The statuses in which every message sent to the session has been answered.
// A request is finished when the session reaches one of these, never when it
// merely goes quiet.
const SETTLED_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'closed',
]);

export function isSessionSettled(status: string): boolean {
  return SETTLED_SESSION_STATUSES.has(status);
}

export const DEFAULT_POLL_INTERVAL_MS = 3_000;

// How a message ended: the `message_ended` record's payload.
export type MessageEnded = S['MessageEndedPayload'];

// The slice of the generated sessions namespace the handle needs — structural,
// so the sugar never imports the generated class (which would be circular).
export interface SessionsApi {
  get(sessionId: string): Promise<S['SessionResponse']>;
  stop(sessionId: string): Promise<S['SessionResponse']>;
  sendMessage(
    sessionId: string,
    options: {
      message: string;
      images?: S['ImageAttachment'][];
      idempotency_key?: string | null;
    }
  ): Promise<S['SessionMessageResponse']>;
  records(
    sessionId: string,
    options?: {
      cursor?: string | null;
      limit?: number | null;
      message_id?: string | null;
    }
  ): Promise<Page<S['SessionRecord'], S['SessionRecordsListResponse']>>;
  sessionStreamTicket(sessionId: string): Promise<S['StreamTicketResponse']>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionHandle {
  readonly id: string;
  // The latest session snapshot this handle saw.
  session: S['Session'];
  // The message `wait()` waits on: the last one sent through `send()`, else
  // the session's latest message.
  messageId: string | null = null;

  constructor(
    private readonly sessions: SessionsApi,
    session: S['Session']
  ) {
    this.id = session.id;
    this.session = session;
  }

  async refresh(): Promise<S['Session']> {
    this.session = (await this.sessions.get(this.id)).session;
    return this.session;
  }

  // Poll until the session is idle or closed, then return how the awaited
  // message ended: its `message_ended` record's payload. Null when the
  // session has no message.
  async wait(
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<MessageEnded | null> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline =
      options.timeoutMs == null ? null : Date.now() + options.timeoutMs;
    for (;;) {
      const session = await this.refresh();
      if (isSessionSettled(session.status)) break;
      if (deadline != null && Date.now() >= deadline) {
        throw new Error(
          `session ${this.id} not settled after ${options.timeoutMs}ms`
        );
      }
      await sleep(pollIntervalMs);
    }
    let ended: MessageEnded | null = null;
    const page = await this.sessions.records(this.id, {
      message_id: this.messageId,
    });
    for await (const record of page) {
      if (record.kind !== 'platform' || record.record_type !== 'message_ended')
        continue;
      if (this.messageId == null || record.message_id === this.messageId)
        ended = record.payload;
    }
    return ended;
  }

  // Send a message to the session; `wait()` then waits for it to be
  // answered. `images` ride the message as content blocks the model sees.
  async send(
    message: string,
    options: { images?: S['ImageAttachment'][]; idempotencyKey?: string } = {}
  ): Promise<S['SessionMessageResponse']> {
    const response = await this.sessions.sendMessage(this.id, {
      message,
      images: options.images,
      idempotency_key: options.idempotencyKey,
    });
    this.messageId = response.message.id;
    return response;
  }

  async stop(): Promise<S['Session']> {
    this.session = (await this.sessions.stop(this.id)).session;
    return this.session;
  }

  // Yield this session's records as they are written, each once and in
  // order, until every message sent to it has been answered: the session is
  // idle or closed. A record is one entry in the session's log: a message, a
  // step the agent took, how a message ended.
  //
  // It reads the session's WebSocket, reconnecting and resuming on its own,
  // and yields only the records. The stream's other frames (the whole
  // session and timeline resent on every change, heartbeats, partial text a
  // record replaces) are not yielded; `streamSession` in
  // `@ellipsis-dev/sdk/stream` hands over every frame. Each connection opens
  // with a fresh stream ticket on the runtime's global WebSocket (browsers,
  // Node 22+, Bun, Deno). Throws StreamUnavailableError with the server's
  // message when the stream fails.
  //
  // The session frame that says the session settled arrives before the last
  // records of that change, so the stream stops at that frame and the records
  // it had not sent yet are read over REST.
  async *stream(
    options: { afterSeq?: number; maxReconnects?: number } = {}
  ): AsyncGenerator<S['SessionRecord'], void, void> {
    const abort = new AbortController();
    const queue: StreamFrame[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const outcome = streamSession({
      sessionId: this.id,
      openSocket: async ({ query }) => {
        const { ws_url, ticket } = await this.sessions.sessionStreamTicket(
          this.id
        );
        return adaptWebSocket(
          new WebSocket(
            `${ws_url}?ticket=${encodeURIComponent(ticket)}${query ? `&${query}` : ''}`
          )
        );
      },
      onFrame: (frame) => {
        queue.push(frame);
        wake?.();
      },
      afterSeq: options.afterSeq,
      maxReconnects: options.maxReconnects,
      signal: abort.signal,
    }).finally(() => {
      finished = true;
      wake?.();
    });
    // A caller that stops early never awaits the outcome; its failure then
    // has nowhere to go and must not surface as an unhandled rejection.
    outcome.catch(() => {});

    let lastFeedSeq = options.afterSeq ?? 0;
    let settled = false;
    try {
      while (!settled) {
        const frame = queue.shift();
        if (frame === undefined) {
          if (finished) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        if (frame.type === 'records') {
          // A reconnect can resend records the loop has yielded.
          for (const record of frame.records as S['SessionRecord'][]) {
            if (record.feed_seq <= lastFeedSeq) continue;
            lastFeedSeq = record.feed_seq;
            yield record;
          }
        } else if (frame.type === 'error') {
          break;
        } else if (frame.type === 'session') {
          settled = isSessionSettled(frame.session.status);
        }
      }
    } finally {
      abort.abort();
    }
    // Throws what the stream client threw: StreamUnavailableError,
    // StreamAuthError.
    const result = await outcome;
    if (result.type === 'error')
      throw new StreamUnavailableError(result.message);
    if (!settled) return;

    await this.refresh();
    const unseen: S['SessionRecord'][] = [];
    for await (const record of await this.sessions.records(this.id)) {
      if (record.feed_seq > lastFeedSeq) unseen.push(record);
    }
    unseen.sort((a, b) => a.feed_seq - b.feed_seq);
    yield* unseen;
  }
}
