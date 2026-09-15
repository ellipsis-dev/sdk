import type { SessionRecord } from '../types';
import { claudePayload } from './claude';

export type WorkPhase = 'queued' | 'waking' | 'starting' | 'working';

export interface TurnTiming {
  id: string;
  startedAt: string | null;
  completedAt: string | null;
}

// Message progress follows platform turn ownership, independently of whether
// a native item has produced anything the transcript can render yet.
export interface MessageProgress {
  phase: WorkPhase | null;
  turns: TurnTiming[];
}

export function messageProgress(
  records: readonly SessionRecord[]
): Map<string, MessageProgress> {
  const messages = new Map<string, MessageProgress>();
  const pending = new Set<string>();
  const turns = new Map<
    string,
    { timing: TurnTiming; phase: WorkPhase | null; messages: Set<string> }
  >();
  let starting: WorkPhase = 'queued';
  let ready = false;

  const getTurn = (id: string) => {
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        timing: { id, startedAt: null, completedAt: null },
        phase: ready ? 'working' : 'starting',
        messages: new Set<string>(),
      };
      turns.set(id, turn);
    }
    return turn;
  };
  const updatePending = () => {
    for (const id of pending) messages.get(id)!.phase = starting;
  };
  const attach = (messageId: string, turnId: string) => {
    const message = messages.get(messageId);
    if (!message) return;
    const turn = getTurn(turnId);
    if (!turn.messages.has(messageId)) {
      turn.messages.add(messageId);
      message.turns.push(turn.timing);
    }
    pending.delete(messageId);
    message.phase = turn.phase;
    starting = 'queued';
    updatePending();
  };

  for (const record of records) {
    if (record.kind === 'platform') {
      const p: Record<string, unknown> = record.payload;
      const messageId = typeof p.message_id === 'string' ? p.message_id : null;
      const turnId = typeof p.turn_id === 'string' ? p.turn_id : record.turn_id;
      switch (record.record_type) {
        case 'message_received':
          if (messageId && !messages.has(messageId)) {
            messages.set(messageId, { phase: starting, turns: [] });
            pending.add(messageId);
          }
          break;
        case 'message_delivered':
          if (messageId && turnId) attach(messageId, turnId);
          break;
        case 'message_requeued':
          if (messageId && messages.has(messageId)) {
            pending.add(messageId);
            messages.get(messageId)!.phase = 'queued';
          }
          break;
        case 'session_starting':
        case 'session_retrying':
          ready = false;
          starting =
            typeof p.wake_index === 'number' && p.wake_index > 0
              ? 'waking'
              : 'starting';
          updatePending();
          break;
        case 'session_resumed':
          starting = 'starting';
          updatePending();
          break;
        case 'turn_started':
          if (turnId) getTurn(turnId).timing.startedAt = record.created_at;
          break;
        case 'turn_completed':
        case 'turn_failed':
          if (turnId) {
            const turn = getTurn(turnId);
            turn.timing.completedAt = record.created_at;
            turn.phase = null;
            for (const id of turn.messages) {
              if (!pending.has(id)) messages.get(id)!.phase = null;
            }
          }
          starting = 'queued';
          break;
        case 'session_idle':
        case 'session_closed':
        case 'session_cancelled':
          ready = false;
          starting = 'queued';
          for (const id of pending) messages.get(id)!.phase = null;
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
      (claude != null &&
        (claude.kind === 'assistant' ||
          claude.kind === 'user' ||
          (claude.kind === 'system' && claude.subtype === 'init')));
    if (agentStarted) {
      ready = true;
      if (record.turn_id) {
        const turn = getTurn(record.turn_id);
        if (turn.timing.completedAt == null) {
          turn.timing.startedAt ??= record.created_at;
          turn.phase = 'working';
          for (const id of turn.messages) messages.get(id)!.phase = 'working';
        }
      }
    }
    if (record.session_message_id && record.turn_id) {
      attach(record.session_message_id, record.turn_id);
    }
  }
  return messages;
}
