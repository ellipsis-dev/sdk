// The session lifecycle sugar: a handle over one agent session. Hand-written
// by design (the start -> stream -> message -> stop flow is an ergonomics
// judgment, not a projection of the spec). Everything the handle does rides
// the generated core; live streaming stays in `@ellipsis-dev/sdk/stream`
// (inject its outcome via handle.id — the stream client is transport-injected
// and works against any door).

import type { components } from '../generated/openapi';

type S = components['schemas'];

// The statuses a turn never leaves. A request is finished when the turn that
// answers it reaches one of these — never when the session goes quiet.
const FINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'stopped',
  'cancelled',
]);

export function isTurnFinal(status: string): boolean {
  return FINAL_TURN_STATUSES.has(status);
}

export const DEFAULT_POLL_INTERVAL_MS = 3_000;

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
  turns: {
    get(sessionId: string, turnId: string): Promise<S['SessionTurnResponse']>;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionHandle {
  readonly id: string;
  // The latest session snapshot this handle saw.
  session: S['Session'];
  // The turn `wait()` waits on: the session's turn after `run()`, then the
  // turn each `send()` creates. Null until the session has a message.
  turnId: string | null;

  constructor(
    private readonly sessions: SessionsApi,
    session: S['Session']
  ) {
    this.id = session.id;
    this.session = session;
    this.turnId = session.turn?.id ?? null;
  }

  async refresh(): Promise<S['Session']> {
    this.session = (await this.sessions.get(this.id)).session;
    return this.session;
  }

  // Poll until the awaited turn reaches a final status (completed, failed,
  // stopped, cancelled) or the conversation closes, and return that turn.
  // Returns null at once when the session has no turn to wait on.
  async wait(
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<S['SessionTurn'] | null> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline =
      options.timeoutMs == null ? null : Date.now() + options.timeoutMs;
    for (;;) {
      const session = await this.refresh();
      const turnId = this.turnId;
      if (turnId == null) return null;
      // The session carries the running turn, else the latest one; a turn a
      // later turn displaced is fetched on its own.
      const turn =
        session.turn?.id === turnId
          ? session.turn
          : (await this.sessions.turns.get(this.id, turnId)).turn;
      if (isTurnFinal(turn.status) || session.conversation.state === 'closed')
        return turn;
      if (deadline != null && Date.now() >= deadline) {
        throw new Error(
          `turn ${turnId} of session ${this.id} not final after ${options.timeoutMs}ms`
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  // Post a message into the session. The returned turn is the one that will
  // answer it, and the one `wait()` waits on from now. `images` ride the
  // message as content blocks the model sees on that turn.
  async send(
    message: string,
    options: { images?: S['ImageAttachment'][]; idempotencyKey?: string } = {}
  ): Promise<S['SessionMessageResponse']> {
    const response = await this.sessions.sendMessage(this.id, {
      message,
      images: options.images,
      idempotency_key: options.idempotencyKey,
    });
    this.turnId = response.turn.id;
    return response;
  }

  async stop(): Promise<S['Session']> {
    this.session = (await this.sessions.stop(this.id)).session;
    return this.session;
  }
}
