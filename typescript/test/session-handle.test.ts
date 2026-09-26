import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  isTurnFinal,
  SessionHandle,
  type SessionsApi,
} from '../src/core/sessionHandle';
import type { SessionStreamFrame } from '../src/types';

type Session = Awaited<ReturnType<SessionsApi['get']>>['session'];
type Turn = NonNullable<Session['turn']>;

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/golden_stream.json', import.meta.url),
    'utf8'
  )
) as { frames: SessionStreamFrame[] };
const snapshot = fixture.frames[0];
if (snapshot.type !== 'snapshot') throw new Error('missing fixture snapshot');
const base = snapshot.session as unknown as Session;
if (!base.turn) throw new Error('fixture session has no turn');
const baseTurn = base.turn;

const turn = (id: string, index: number, status: Turn['status']): Turn => ({
  ...baseTurn,
  id,
  index,
  status,
  reason: null,
  detail: null,
});
const session = (
  current: Turn | null,
  state: 'open' | 'closed' = 'open'
): Session => ({
  ...base,
  turn: current,
  conversation: { ...base.conversation, state },
});
const api = (
  get: SessionsApi['get'],
  over: Partial<SessionsApi> = {}
): SessionsApi => ({
  get,
  stop: vi.fn(),
  sendMessage: vi.fn(),
  turns: { get: vi.fn() },
  ...over,
});

describe('SessionHandle', () => {
  it('waits on the session turn until it reaches a final status', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ session: session(turn('turn_0', 0, 'pending')) })
      .mockResolvedValueOnce({ session: session(turn('turn_0', 0, 'running')) })
      .mockResolvedValueOnce({ session: session(turn('turn_0', 0, 'failed')) });
    const handle = new SessionHandle(
      api(get),
      session(turn('turn_0', 0, 'pending'))
    );
    expect(handle.turnId).toBe('turn_0');
    const result = await handle.wait({ pollIntervalMs: 0 });
    expect(result?.status).toBe('failed');
    expect(get).toHaveBeenCalledTimes(3);
    expect(handle.session.turn?.status).toBe('failed');
  });

  it('returns at once when the session has no turn', async () => {
    const get = vi.fn().mockResolvedValue({ session: session(null) });
    const handle = new SessionHandle(api(get), session(null));
    expect(await handle.wait({ pollIntervalMs: 0 })).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('switches the awaited turn to the one answering a sent message', async () => {
    const sent = turn('turn_1', 1, 'pending');
    const sendMessage = vi.fn().mockResolvedValue({
      message: { id: 'message_1', turn_id: 'turn_1' },
      turn: sent,
    });
    const get = vi
      .fn()
      .mockResolvedValue({ session: session(turn('turn_1', 1, 'completed')) });
    const handle = new SessionHandle(
      api(get, { sendMessage }),
      session(turn('turn_0', 0, 'completed'))
    );
    const response = await handle.send('more');
    expect(response.turn.id).toBe('turn_1');
    expect(handle.turnId).toBe('turn_1');
    expect(sendMessage).toHaveBeenCalledWith('session_GOLDEN', {
      message: 'more',
      images: undefined,
      idempotency_key: undefined,
    });
    expect((await handle.wait({ pollIntervalMs: 0 }))?.status).toBe(
      'completed'
    );
  });

  it('fetches the awaited turn on its own once a later turn displaced it', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ session: session(turn('turn_2', 2, 'running')) });
    const turnsGet = vi
      .fn()
      .mockResolvedValueOnce({ turn: turn('turn_1', 1, 'running') })
      .mockResolvedValueOnce({ turn: turn('turn_1', 1, 'completed') });
    const handle = new SessionHandle(
      api(get, { turns: { get: turnsGet } }),
      session(turn('turn_1', 1, 'pending'))
    );
    const result = await handle.wait({ pollIntervalMs: 0 });
    expect(result).toMatchObject({ id: 'turn_1', status: 'completed' });
    expect(turnsGet).toHaveBeenCalledWith('session_GOLDEN', 'turn_1');
    expect(turnsGet).toHaveBeenCalledTimes(2);
  });

  it('returns the awaited turn when the conversation closes under it', async () => {
    const get = vi.fn().mockResolvedValue({
      session: session(turn('turn_0', 0, 'pending'), 'closed'),
    });
    const handle = new SessionHandle(
      api(get),
      session(turn('turn_0', 0, 'pending'))
    );
    expect((await handle.wait({ pollIntervalMs: 0 }))?.status).toBe('pending');
  });

  it('times out naming the awaited turn', async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ session: session(turn('turn_0', 0, 'running')) });
    const handle = new SessionHandle(
      api(get),
      session(turn('turn_0', 0, 'running'))
    );
    await expect(
      handle.wait({ timeoutMs: 0, pollIntervalMs: 0 })
    ).rejects.toThrow('turn turn_0');
  });
});

describe('isTurnFinal', () => {
  it('is true for the four end statuses only', () => {
    for (const status of ['completed', 'failed', 'stopped', 'cancelled'])
      expect(isTurnFinal(status)).toBe(true);
    for (const status of ['pending', 'running', 'none'])
      expect(isTurnFinal(status)).toBe(false);
  });
});
