import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
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
  ...over,
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

describe('isSessionSettled', () => {
  it('is true for idle and closed only', () => {
    for (const status of ['idle', 'closed'])
      expect(isSessionSettled(status)).toBe(true);
    for (const status of ['queued', 'preparing', 'running', 'none'])
      expect(isSessionSettled(status)).toBe(false);
  });
});
