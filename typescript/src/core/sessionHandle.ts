// The session lifecycle sugar: a handle over one agent session. Hand-written
// by design (the start -> stream -> message -> stop flow is an ergonomics
// judgment, not a projection of the spec). Everything the handle does rides
// the generated core; live streaming stays in `@ellipsis-dev/sdk/stream`
// (inject its outcome via handle.id — the stream client is transport-injected
// and works against any door).

import type { components } from '../generated/openapi';

type S = components['schemas'];

// Statuses after which a session's execution will not progress without new
// input; `wait()` returns when one is reached.
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'error',
  'cancelled',
  'stopped',
]);

export const DEFAULT_POLL_INTERVAL_MS = 3_000;

// The slice of the generated sessions namespace the handle needs — structural,
// so the sugar never imports the generated class (which would be circular).
export interface SessionsApi {
  get(sessionId: string): Promise<S['SessionResponse']>;
  stop(sessionId: string): Promise<S['SessionResponse']>;
  sendMessage(
    sessionId: string,
    options: { message: string; idempotency_key?: string | null }
  ): Promise<S['SessionMessageResponse']>;
  records(
    sessionId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<unknown>;
}

// A keyed conversation parked between turns counts as settled: the execution
// finished and nothing runs until new input arrives.
export function isSettled(session: S['Session']): boolean {
  if (TERMINAL_STATUSES.has(session.status)) return true;
  return session.session_state === 'idle' || session.session_state === 'closed';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionHandle {
  readonly id: string;
  // The latest session snapshot this handle saw.
  session: S['Session'];

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

  // Poll until the session settles (terminal status, or a parked
  // conversation: state idle/closed).
  async wait(
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<S['Session']> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline =
      options.timeoutMs == null ? null : Date.now() + options.timeoutMs;
    for (;;) {
      const session = await this.refresh();
      if (isSettled(session)) return session;
      if (deadline != null && Date.now() >= deadline) {
        throw new Error(
          `session ${this.id} not terminal after ${options.timeoutMs}ms`
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  // Post into the session's inbox (delivered at the next turn boundary;
  // wakes a parked session).
  async send(
    message: string,
    options: { idempotencyKey?: string } = {}
  ): Promise<S['SessionMessage']> {
    const response = await this.sessions.sendMessage(this.id, {
      message,
      idempotency_key: options.idempotencyKey,
    });
    return response.message;
  }

  async stop(): Promise<S['Session']> {
    this.session = (await this.sessions.stop(this.id)).session;
    return this.session;
  }
}
