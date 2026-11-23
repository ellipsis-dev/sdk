import type { SessionRecord } from '../types';
import { claudePayload } from './claude';

// Where a message's work is: waiting for a worker, its environment being
// prepared, its agent starting, or the agent at work.
export type WorkPhase = 'queued' | 'preparing' | 'starting' | 'working';

export interface MessageTiming {
  startedAt: string | null;
  completedAt: string | null;
}

// Message progress follows the platform's message records, independently of
// whether a native item has produced anything the transcript can render yet.
// `phase` is null once the message ended.
export interface MessageProgress {
  phase: WorkPhase | null;
  timing: MessageTiming;
}

export function messageProgress(
  records: readonly SessionRecord[]
): Map<string, MessageProgress> {
  const messages = new Map<string, MessageProgress>();
  // Messages the agent has not started on yet.
  const pending = new Set<string>();
  // Whether an agent process is up in the current environment: a message
  // that starts under a running agent is at work at once, one that starts in
  // a fresh environment first waits for the agent to boot.
  let ready = false;

  const get = (id: string) => {
    let message = messages.get(id);
    if (!message) {
      message = {
        phase: 'queued',
        timing: { startedAt: null, completedAt: null },
      };
      messages.set(id, message);
    }
    return message;
  };
  // Pending messages follow the preparation of the environment; a record
  // that names no message speaks for every pending message.
  const setPending = (messageId: string | null, phase: WorkPhase): void => {
    for (const id of pending) {
      if (messageId == null || messageId === id) get(id).phase = phase;
    }
  };

  for (const record of records) {
    const recordMessageId = record.message_id ?? null;
    if (record.kind === 'platform') {
      const p: Record<string, unknown> = { ...record.payload };
      const messageId =
        typeof p.message_id === 'string'
          ? p.message_id
          : typeof p.id === 'string' && record.record_type === 'message'
            ? p.id
            : recordMessageId;
      switch (record.record_type) {
        case 'message':
          if (messageId && !messages.has(messageId)) {
            get(messageId);
            pending.add(messageId);
          }
          break;
        case 'message_requeued':
          if (messageId && messages.has(messageId)) {
            pending.add(messageId);
            const message = get(messageId);
            message.phase = 'queued';
            message.timing.startedAt = null;
            message.timing.completedAt = null;
          }
          break;
        case 'environment_phase':
        case 'environment_output':
          ready = false;
          setPending(recordMessageId, 'preparing');
          break;
        case 'environment_ready':
          ready = false;
          setPending(recordMessageId, 'starting');
          break;
        case 'message_started':
          if (messageId) {
            const message = get(messageId);
            message.timing.startedAt = record.created_at;
            message.phase = ready ? 'working' : 'starting';
            pending.delete(messageId);
          }
          break;
        case 'message_ended':
          if (messageId) {
            const message = get(messageId);
            message.timing.completedAt = record.created_at;
            message.phase = null;
            pending.delete(messageId);
          }
          break;
        case 'session_closed':
          ready = false;
          for (const id of pending) get(id).phase = null;
          pending.clear();
          break;
      }
      continue;
    }

    // A warning/config notification proves only that the process exists.
    // Codex's native turn start proves that initialization and resume finished.
    const claude = claudePayload(record);
    const agentStarted =
      (record.kind === 'codex_app_server' &&
        record.payload.method === 'turn/started') ||
      (record.kind === 'codex' && record.payload.type === 'turn.started') ||
      (record.kind === 'gemini' && record.payload.type === 'init') ||
      (claude != null &&
        (claude.kind === 'assistant' ||
          claude.kind === 'user' ||
          (claude.kind === 'system' && claude.subtype === 'init')));
    if (agentStarted) {
      ready = true;
      if (recordMessageId) {
        const message = get(recordMessageId);
        if (message.timing.completedAt == null) {
          message.timing.startedAt ??= record.created_at;
          message.phase = 'working';
          pending.delete(recordMessageId);
        }
      }
    }
  }
  return messages;
}
