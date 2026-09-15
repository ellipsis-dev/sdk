import { describe, expect, it, vi } from 'vitest';
import {
  isSettled,
  SessionHandle,
  type SessionsApi,
} from '../src/core/sessionHandle';
type Session = Awaited<ReturnType<SessionsApi['get']>>['session'];
import fixture from './fixtures/golden_stream.json';

const initial = fixture.frames.find((frame) => frame.type === 'snapshot')!
  .session as Session;

function session(status: Session['lifecycle']['status']): Session {
  return {
    ...initial,
    lifecycle: {
      ...initial.lifecycle,
      conversation: 'open',
      status,
      last_execution_result: {
        completion_reason: 'tool_call_failed',
        detail: 'Previous execution failed.',
      },
    },
  };
}

describe('session wait', () => {
  it('keeps polling a wake despite the previous execution result', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ session: session('starting') })
      .mockResolvedValueOnce({ session: session('idle') });
    const api: SessionsApi = {
      get,
      stop: vi.fn(),
      sendMessage: vi.fn(),
      records: vi.fn(),
    };
    const handle = new SessionHandle(api, session('starting'));
    expect((await handle.wait({ pollIntervalMs: 0 })).lifecycle.status).toBe(
      'idle'
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a warm waiting worker from a parked execution', () => {
    expect(isSettled(session('waiting'))).toBe(false);
    expect(isSettled(session('working'))).toBe(false);
    expect(isSettled(session('idle'))).toBe(true);
    expect(isSettled(session('failed'))).toBe(true);
  });
});
