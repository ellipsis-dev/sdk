import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyCloseCode,
  decideReconnect,
  nextReconnectDelayMs,
  streamQuery,
  streamSession,
  StreamAuthError,
  StreamUnavailableError,
  type OpenSocket,
  type StreamFrame,
  type StreamSocket,
} from '../src/stream';

// A controllable in-memory socket so the reconnect/resume/fallback machinery
// can be driven deterministically with fake timers — no real server.
class FakeSocket implements StreamSocket {
  private openCb?: () => void;
  private msgCb?: (data: string) => void;
  private closeCb?: (code: number) => void;
  private errCb?: (err: Error) => void;
  closed = false;

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (code: number) => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errCb = cb;
  }
  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.openCb?.();
  }
  emitFrame(frame: StreamFrame): void {
    this.msgCb?.(JSON.stringify(frame));
  }
  emitClose(code: number): void {
    this.closeCb?.(code);
  }
  emitError(err: Error): void {
    this.errCb?.(err);
  }
}

function makeOpenSocket(): {
  openSocket: OpenSocket;
  sockets: { query: string; afterSeq: number; sock: FakeSocket }[];
} {
  const sockets: { query: string; afterSeq: number; sock: FakeSocket }[] = [];
  const openSocket: OpenSocket = ({ query, afterSeq }) => {
    const sock = new FakeSocket();
    sockets.push({ query, afterSeq, sock });
    return sock;
  };
  return { openSocket, sockets };
}

// ------------------------------ pure helpers --------------------------------

describe('pure helpers', () => {
  it('classifies WebSocket close codes', () => {
    expect(classifyCloseCode(1000)).toBe('normal');
    expect(classifyCloseCode(1008)).toBe('auth');
    expect(classifyCloseCode(4401)).toBe('auth'); // ticket door: bad ticket
    expect(classifyCloseCode(4403)).toBe('auth'); // ticket door: wrong customer
    expect(classifyCloseCode(1002)).toBe('unsupported'); // unknown protocol version
    expect(classifyCloseCode(1003)).toBe('unsupported'); // no ?protocol= param
    expect(classifyCloseCode(1011)).toBe('retry');
    expect(classifyCloseCode(1013)).toBe('retry'); // over capacity
    expect(classifyCloseCode(1006)).toBe('retry');
  });

  it('backs off exponentially up to a cap', () => {
    expect(nextReconnectDelayMs(1)).toBe(500);
    expect(nextReconnectDelayMs(2)).toBe(1000);
    expect(nextReconnectDelayMs(3)).toBe(2000);
    expect(nextReconnectDelayMs(99)).toBe(8000);
  });

  it('decides auth failures and unsupported closes without retrying', () => {
    const base = { everReceivedFrame: true, attempt: 1, maxReconnects: 5 };
    expect(
      decideReconnect({ ...base, closeKind: 'auth' as const }).action
    ).toBe('fail-auth');
    expect(
      decideReconnect({ ...base, closeKind: 'unsupported' as const }).action
    ).toBe('fallback');
  });

  it('retries persistently once streaming has worked, briefly otherwise', () => {
    expect(
      decideReconnect({
        closeKind: 'retry',
        everReceivedFrame: true,
        attempt: 4,
        maxReconnects: 5,
      }).action
    ).toBe('reconnect');
    expect(
      decideReconnect({
        closeKind: 'retry',
        everReceivedFrame: true,
        attempt: 5,
        maxReconnects: 5,
      }).action
    ).toBe('fallback');
    // Never connected: bail out after a couple of attempts so polling kicks in.
    expect(
      decideReconnect({
        everReceivedFrame: false,
        attempt: 1,
        maxReconnects: 5,
      }).action
    ).toBe('reconnect');
    expect(
      decideReconnect({
        everReceivedFrame: false,
        attempt: 2,
        maxReconnects: 5,
      }).action
    ).toBe('fallback');
  });

  it('builds the handshake query with the required protocol + optional cursor', () => {
    expect(streamQuery(0)).toBe('protocol=3');
    expect(streamQuery(7)).toBe('protocol=3&after_seq=7');
  });
});

// ---------------------------- streamSession ---------------------------------

// Minimal v2 frame builders (protocol §3.3). The session frame carries the
// lean wire session; only the fields streamSession reads are populated.
function sessionFrame(
  word: string,
  exitStatus: string | null = null
): StreamFrame {
  return {
    type: 'session',
    session: {
      id: 's',
      status: word,
      exit_status: exitStatus,
      surface: { session: null, run: null, status: word },
    },
  } as unknown as StreamFrame;
}

function recordsFrame(...feedSeqs: number[]): StreamFrame {
  return {
    type: 'records_append',
    records: feedSeqs.map((feed_seq) => ({
      id: `rec-${feed_seq}`,
      agent_session_id: 's',
      feed_seq,
      stream_seq: feed_seq,
      source: 'claude_code',
      record_type: 'assistant',
      record_format: 'claude_stream_json@2.0',
      payload: {},
      created_at: 'now',
    })),
  } as unknown as StreamFrame;
}

describe('streamSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits every frame and resolves on done with the last session word', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const frames: StreamFrame[] = [];
    const p = streamSession({
      sessionId: 's',
      openSocket,
      onFrame: (f) => frames.push(f),
    });
    await vi.advanceTimersByTimeAsync(0); // let the async openSocket resolve
    sockets[0].sock.emitOpen();
    sockets[0].sock.emitFrame(sessionFrame('working'));
    sockets[0].sock.emitFrame(recordsFrame(1));
    // The final session frame carries the end state, then done (§3.3).
    sockets[0].sock.emitFrame(sessionFrame('closed', 'completed'));
    sockets[0].sock.emitFrame({ type: 'done' });

    const outcome = await p;
    expect(outcome).toEqual({
      type: 'done',
      status: 'closed',
      exitStatus: 'completed',
    });
    expect(frames.map((f) => f.type)).toEqual([
      'session',
      'records_append',
      'session',
      'done',
    ]);
    expect(sockets[0].sock.closed).toBe(true);
  });

  it('reconnects after a drop and resumes from the last record feed_seq', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({ sessionId: 's', openSocket, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].query).toBe('protocol=3');
    sockets[0].sock.emitOpen();
    sockets[0].sock.emitFrame(recordsFrame(1, 2));
    // Only records advance the cursor (§3.4) — a session frame never does.
    sockets[0].sock.emitFrame(sessionFrame('working'));
    sockets[0].sock.emitClose(1011); // server error: retryable drop

    await vi.advanceTimersByTimeAsync(500); // backoff for attempt 1
    expect(sockets).toHaveLength(2);
    expect(sockets[1].afterSeq).toBe(2);
    expect(sockets[1].query).toBe('protocol=3&after_seq=2');

    sockets[1].sock.emitFrame(sessionFrame('closed', null));
    sockets[1].sock.emitFrame({ type: 'done' });
    const outcome = await p;
    expect(outcome).toEqual({
      type: 'done',
      status: 'closed',
      exitStatus: null,
    });
  });

  it('resets the failure budget once a connection delivers a frame', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({
      sessionId: 's',
      openSocket,
      onFrame: () => {},
      maxReconnects: 2,
    });
    // Two drops, each after a delivered frame: attempt resets each time, so
    // the stream survives past maxReconnects consecutive-failure budget.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      sockets[i].sock.emitFrame(recordsFrame(i + 1));
      sockets[i].sock.emitClose(1006);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(4);
    sockets[3].sock.emitFrame({ type: 'done' });
    await expect(p).resolves.toMatchObject({ type: 'done' });
  });

  it('surfaces a server error frame as an error outcome (not a fallback)', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({ sessionId: 's', openSocket, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].sock.emitFrame({ type: 'error', message: 'boom' });
    expect(await p).toEqual({ type: 'error', message: 'boom' });
  });

  it('falls back (throws StreamUnavailableError) on an unsupported close', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({ sessionId: 's', openSocket, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].sock.emitClose(1003);
    await expect(p).rejects.toBeInstanceOf(StreamUnavailableError);
  });

  it('falls back when the socket never connects after a couple of tries', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({ sessionId: 's', openSocket, onFrame: () => {} });
    const rejection = expect(p).rejects.toBeInstanceOf(StreamUnavailableError);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].sock.emitError(new Error('ECONNREFUSED'));
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    sockets[1].sock.emitError(new Error('ECONNREFUSED'));
    await rejection;
  });

  it('treats a failed openSocket (e.g. ticket fetch) as a retryable error', async () => {
    let calls = 0;
    const { openSocket, sockets } = makeOpenSocket();
    const flaky: OpenSocket = (args) => {
      calls++;
      if (calls === 1) throw new Error('ticket fetch failed');
      return openSocket(args);
    };
    const p = streamSession({
      sessionId: 's',
      openSocket: flaky,
      onFrame: () => {},
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(1);
    sockets[0].sock.emitFrame({ type: 'done' });
    await expect(p).resolves.toMatchObject({ type: 'done' });
  });

  it('fails hard (StreamAuthError) on an auth-rejected close', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const p = streamSession({ sessionId: 's', openSocket, onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].sock.emitClose(1008);
    await expect(p).rejects.toBeInstanceOf(StreamAuthError);
  });

  it('aborts cleanly via the signal', async () => {
    const { openSocket, sockets } = makeOpenSocket();
    const controller = new AbortController();
    const p = streamSession({
      sessionId: 's',
      openSocket,
      onFrame: () => {},
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].sock.emitFrame(sessionFrame('working'));
    controller.abort();
    await expect(p).resolves.toEqual({ type: 'aborted' });
    expect(sockets[0].sock.closed).toBe(true);
  });
});
