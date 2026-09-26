import type { SessionRecord } from '../types';
import { claudePayload } from './claude';

// Where a message's work is: waiting for its turn, its environment being
// prepared, its agent starting, or the agent at work.
export type WorkPhase = 'queued' | 'preparing' | 'starting' | 'working';

export interface TurnTiming {
  id: string;
  startedAt: string | null;
  completedAt: string | null;
}

// Message progress follows platform turn ownership, independently of whether
// a native item has produced anything the transcript can render yet. `phase`
// is null once the turn answering the message ended.
export interface MessageProgress {
  phase: WorkPhase | null;
  turns: TurnTiming[];
}

export function messageProgress(
  records: readonly SessionRecord[]
): Map<string, MessageProgress> {
  const messages = new Map<string, MessageProgress>();
  // Messages whose turn has not started, by the turn answering them (null
  // when the feed did not say).
  const pending = new Map<string, string | null>();
  const turns = new Map<
    string,
    { timing: TurnTiming; phase: WorkPhase | null; messages: Set<string> }
  >();
  // Whether an agent process is up in the current environment: a turn that
  // starts under a running agent is at work at once, one that starts in a
  // fresh environment first waits for the agent to boot.
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
  };
  // Pending messages follow the preparation of the turn answering them; a
  // record that names no turn speaks for every pending message.
  const setPending = (turnId: string | null, phase: WorkPhase): void => {
    for (const [id, turn] of pending) {
      if (turnId == null || turn == null || turn === turnId)
        messages.get(id)!.phase = phase;
    }
  };

  for (const record of records) {
    if (record.kind === 'platform') {
      const p: Record<string, unknown> = record.payload;
      const messageId = typeof p.message_id === 'string' ? p.message_id : null;
      const turnId = typeof p.turn_id === 'string' ? p.turn_id : record.turn_id;
      switch (record.record_type) {
        case 'message_received':
          if (messageId && !messages.has(messageId)) {
            messages.set(messageId, { phase: 'queued', turns: [] });
            // Its turn may already be under way (a message recorded after
            // its turn started).
            if (turnId && turns.has(turnId)) attach(messageId, turnId);
            else pending.set(messageId, turnId ?? null);
          }
          break;
        case 'message_delivered':
          if (messageId && turnId) attach(messageId, turnId);
          break;
        case 'message_requeued':
          if (messageId && messages.has(messageId)) {
            const requeued =
              typeof p.requeued_turn_id === 'string'
                ? p.requeued_turn_id
                : null;
            pending.set(messageId, requeued);
            messages.get(messageId)!.phase = 'queued';
          }
          break;
        case 'environment_phase':
        case 'environment_output':
          ready = false;
          setPending(turnId ?? null, 'preparing');
          break;
        case 'environment_ready':
          ready = false;
          setPending(turnId ?? null, 'starting');
          break;
        case 'turn_started':
          if (turnId) {
            getTurn(turnId).timing.startedAt = record.created_at;
            for (const [id, turn] of pending) {
              if (turn === turnId) attach(id, turnId);
            }
          }
          break;
        case 'turn_ended':
          if (turnId) {
            const turn = getTurn(turnId);
            turn.timing.completedAt = record.created_at;
            turn.phase = null;
            for (const id of turn.messages) {
              if (!pending.has(id)) messages.get(id)!.phase = null;
            }
            // A turn that ended before it started took its messages nowhere.
            for (const [id, pendingTurn] of pending) {
              if (pendingTurn === turnId) {
                pending.delete(id);
                messages.get(id)!.phase = null;
              }
            }
          }
          break;
        case 'session_closed':
          ready = false;
          for (const id of pending.keys()) messages.get(id)!.phase = null;
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
