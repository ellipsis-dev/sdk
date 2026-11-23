import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSessionSettled,
  SessionHandle,
  type MessageEnded,
  type SessionsApi,
} from '../src/core/sessionHandle';
import type {
  SessionRecord,
  SessionStatus,
  SessionStreamFrame,
} from '../src/types';

type Session = Awaited<ReturnType<SessionsApi['get']>>['session'];
type RecordsPage = Awaited<ReturnType<SessionsApi['records']>>;

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/golden_stream.json', import.meta.url),
    'utf8'
  )
) as { frames: SessionStreamFrame[] };
const first = fixture.frames[0];
if (first.type !== 'session') throw new Error('missing fixture session');
const base = first.session as unknown as Session;
const endedRecords = fixture.frames.flatMap((frame) =>
  frame.type === 'records'
    ? frame.records.filter((r) => r.record_type === 'message_ended')
    : []
);
if (endedRecords.length < 2) throw new Error('fixture has no message_ended');

const session = (status: SessionStatus): Session => ({
  ...base,
  status,
  error: status === 'idle' ? { reason: 'error', detail: null } : null,
});
const ended = (messageId: string, status: string): SessionRecord =>
  ({
    ...endedRecords[0],
    id: `rec_${messageId}`,
    message_id: messageId,
    payload: { ...endedRecords[0].payload, message_id: messageId, status },
  }) as SessionRecord;
// A one-page records result: what the generated `sessions.records` returns.
const page = (items: SessionRecord[]): RecordsPage =>
  ({
    items,
    hasMore: false,
    nextCursor: null,
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  }) as unknown as RecordsPage;
const api = (
  get: SessionsApi['get'],
  over: Partial<SessionsApi> = {}
): SessionsApi => ({
  get,
  stop: vi.fn(),
  sendMessage: vi.fn(),
  records: vi.fn().mockResolvedValue(page([])),
  sessionStreamTicket: vi
    .fn()
    .mockResolvedValue({ ws_url: 'wss://stream.test/s', ticket: 'tick et' }),
  ...over,
});

// The runtime's WebSocket, driven by hand: `stream()` opens one per
// connection, and the test plays the server on it.
class FakeWebSocket {
  static opened: FakeWebSocket[] = [];
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.opened.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  close(): void {
    this.closed = true;
  }
  serve(frame: unknown): void {
    for (const listener of this.listeners.message ?? [])
      listener({ data: JSON.stringify(frame) });
  }
  end(code: number): void {
    for (const listener of this.listeners.close ?? []) listener({ code });
  }
}

// The socket `stream()` opened, once its ticket has been fetched.
const socket = async (index = 0): Promise<FakeWebSocket> => {
  await vi.waitFor(() =>
    expect(FakeWebSocket.opened.length).toBeGreaterThan(index)
  );
  return FakeWebSocket.opened[index];
};
const record = (feedSeq: number): SessionRecord =>
  ({
    ...endedRecords[0],
    id: `rec_${feedSeq}`,
    feed_seq: feedSeq,
  }) as SessionRecord;

afterEach(() => {
  FakeWebSocket.opened = [];
  vi.unstubAllGlobals();
});

describe('SessionHandle', () => {
  it('polls the session until it settles, then returns how the message ended', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ session: session('queued') })
      .mockResolvedValueOnce({ session: session('running') })
      .mockResolvedValueOnce({ session: session('idle') });
    const records = vi
      .fn()
      .mockResolvedValue(page([ended('message_0', 'failed')]));
    const handle = new SessionHandle(api(get, { records }), session('queued'));
    expect(handle.messageId).toBeNull();
    const result = await handle.wait({ pollIntervalMs: 0 });
    expect(result?.status).toBe('failed');
    expect(result?.message_id).toBe('message_0');
    expect(get).toHaveBeenCalledTimes(3);
    expect(records).toHaveBeenCalledWith('session_GOLDEN', {
      message_id: null,
    });
    expect(handle.session.status).toBe('idle');
  });

  it('returns null when the session has no message', async () => {
    const get = vi.fn().mockResolvedValue({ session: session('idle') });
    const handle = new SessionHandle(api(get), session('idle'));
    expect(await handle.wait({ pollIntervalMs: 0 })).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('switches the awaited message to the one it sent', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message: {
        id: 'message_1',
        session_id: 'session_GOLDEN',
        index: 1,
        body: 'more',
        images: [],
        author: null,
        created_at: '2026-01-01T00:00:00+00:00',
      },
    });
    const get = vi.fn().mockResolvedValue({ session: session('idle') });
    const records = vi
      .fn()
      .mockResolvedValue(page([ended('message_1', 'completed')]));
    const handle = new SessionHandle(
      api(get, { sendMessage, records }),
      session('idle')
    );
    const response = await handle.send('more');
    expect(response.message.id).toBe('message_1');
    expect(handle.messageId).toBe('message_1');
    expect(sendMessage).toHaveBeenCalledWith('session_GOLDEN', {
      message: 'more',
      images: undefined,
      idempotency_key: undefined,
    });
    const result: MessageEnded | null = await handle.wait({
      pollIntervalMs: 0,
    });
    expect(result?.status).toBe('completed');
    expect(records).toHaveBeenCalledWith('session_GOLDEN', {
      message_id: 'message_1',
    });
  });

  it('returns the awaited message outcome, not a later one', async () => {
    const get = vi.fn().mockResolvedValue({ session: session('idle') });
    const records = vi
      .fn()
      .mockResolvedValue(
        page([ended('message_1', 'completed'), ended('message_2', 'failed')])
      );
    const handle = new SessionHandle(api(get, { records }), session('running'));
    expect(await handle.wait({ pollIntervalMs: 0 })).toMatchObject({
      message_id: 'message_2',
      status: 'failed',
    });
    handle.messageId = 'message_1';
    expect(await handle.wait({ pollIntervalMs: 0 })).toMatchObject({
      message_id: 'message_1',
      status: 'completed',
    });
  });

  it('settles at once when the session is closed', async () => {
    const get = vi.fn().mockResolvedValue({ session: session('closed') });
    const records = vi
      .fn()
      .mockResolvedValue(page([ended('message_0', 'cancelled')]));
    const handle = new SessionHandle(api(get, { records }), session('queued'));
    expect((await handle.wait({ pollIntervalMs: 0 }))?.status).toBe(
      'cancelled'
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('times out naming the session', async () => {
    const get = vi.fn().mockResolvedValue({ session: session('running') });
    const handle = new SessionHandle(api(get), session('running'));
    await expect(
      handle.wait({ timeoutMs: 0, pollIntervalMs: 0 })
    ).rejects.toThrow('session session_GOLDEN');
  });
});

describe('SessionHandle.stream', () => {
  it('yields each record once, in order, until the session settles, then the rest', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const get = vi.fn().mockResolvedValue({ session: session('idle') });
    const records = vi
      .fn()
      .mockResolvedValue(page([record(4), record(1), record(3), record(2)]));
    const handle = new SessionHandle(api(get, { records }), session('queued'));

    const received: number[] = [];
    const reading = (async () => {
      for await (const item of handle.stream()) received.push(item.feed_seq);
    })();
    const ws = await socket();
    expect(ws.url).toBe('wss://stream.test/s?ticket=tick%20et');
    // Everything but records is the stream's own business: the session and
    // timeline resent whole, heartbeats, partial text.
    ws.serve({ type: 'session', session: session('running') });
    ws.serve({ type: 'timeline', events: [] });
    ws.serve({ type: 'heartbeat', ts: '2026-01-01T00:00:00Z' });
    ws.serve({ type: 'delta', message_id: 'm', kind: 'text', text: 'par' });
    ws.serve({ type: 'records', records: [record(1), record(2)] });
    ws.serve({ type: 'records', records: [record(2)] });
    ws.serve({ type: 'session', session: session('idle') });
    ws.serve({ type: 'records', records: [record(9)] });
    await reading;

    expect(received).toEqual([1, 2, 3, 4]);
    expect(ws.closed).toBe(true);
    expect(handle.session.status).toBe('idle');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resumes after a dropped socket with a fresh ticket and repeats no record', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const get = vi.fn().mockResolvedValue({ session: session('closed') });
    const ticket = vi
      .fn()
      .mockResolvedValue({ ws_url: 'wss://stream.test/s', ticket: 't' });
    const handle = new SessionHandle(
      api(get, { sessionStreamTicket: ticket }),
      session('queued')
    );

    const received: number[] = [];
    const reading = (async () => {
      for await (const item of handle.stream()) received.push(item.feed_seq);
    })();
    const first = await socket(0);
    first.serve({ type: 'session', session: session('running') });
    first.serve({ type: 'records', records: [record(7)] });
    first.end(1011);
    const second = await socket(1);
    expect(second.url).toBe('wss://stream.test/s?ticket=t&after_seq=7');
    second.serve({ type: 'records', records: [record(7), record(8)] });
    second.serve({ type: 'session', session: session('closed') });
    await reading;

    expect(received).toEqual([7, 8]);
    expect(ticket).toHaveBeenCalledTimes(2);
  });

  it("throws the server's message when the stream fails", async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const get = vi.fn();
    const records = vi.fn();
    const handle = new SessionHandle(api(get, { records }), session('running'));

    const received: number[] = [];
    const reading = (async () => {
      for await (const item of handle.stream()) received.push(item.feed_seq);
    })();
    const ws = await socket();
    ws.serve({ type: 'records', records: [record(1)] });
    ws.serve({ type: 'error', message: 'stream failed' });

    await expect(reading).rejects.toThrow('stream failed');
    expect(received).toEqual([1]);
    expect(get).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
  });

  it('closes the socket when the caller stops reading', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const handle = new SessionHandle(api(vi.fn()), session('running'));

    const reading = (async () => {
      for await (const item of handle.stream()) {
        expect(item.feed_seq).toBe(1);
        break;
      }
    })();
    const ws = await socket();
    ws.serve({ type: 'records', records: [record(1), record(2)] });
    await reading;

    expect(ws.closed).toBe(true);
  });

  it('fails as the stream client does when the socket is refused', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const handle = new SessionHandle(api(vi.fn()), session('running'));

    const reading = (async () => {
      for await (const item of handle.stream()) void item;
    })();
    (await socket()).end(1008);

    await expect(reading).rejects.toThrow(
      'not authorized to stream this session'
    );
  });
});

describe('isSessionSettled', () => {
  it('is true for idle and closed only', () => {
    for (const status of ['idle', 'closed'])
      expect(isSessionSettled(status)).toBe(true);
    for (const status of ['queued', 'preparing', 'running', 'none'])
      expect(isSessionSettled(status)).toBe(false);
  });
});
