// The session lifecycle sugar: a handle over one agent session. Hand-written
// by design (the start -> stream -> message -> stop flow is an ergonomics
// judgment, not a projection of the spec). Everything the handle does rides
// the generated core; live streaming stays in `@ellipsis-dev/sdk/stream`
// (inject its outcome via handle.id — the stream client is transport-injected
// and works against any door).

import type { components } from '../generated/openapi';
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
}
