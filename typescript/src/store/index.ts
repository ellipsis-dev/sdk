// The session transcript store: feed it every frame the stream client
// delivers (and nothing else) and it maintains the renderable state of one
// session — the lean session snapshot, the committed record log, the open
// inbox slice, the ephemeral delta overlay, the resume cursor, and the
// derived chat-turn grouping. Framework-free: `subscribe`/`getSnapshot` are
// shaped for React's useSyncExternalStore, but any renderer can poll the
// snapshot.

import type {
  Session,
  SessionMessage,
  SessionRecord,
  SessionStreamFrame,
  StreamFrame,
} from '../types';
import type { ChatTurn } from './chatTurns';
import { groupRecordsToChatTurns } from './chatTurns';

export * from './chatTurns';
export * from './lifecycle';
export * from './transcript';
export type { StreamFrame } from '../types';

// Per-execution statuses that end a session which has no session_state.
const TERMINAL_SESSION_STATUSES = new Set([
  'completed',
  'error',
  'cancelled',
  'stopped',
]);

// Whether the conversation is over for good — the client-side mirror of the
// server's `done` frame, for close-time decisions. A durable (keyed) session's
// per-execution `status` hits a terminal value at the end of every turn while
// the conversation is still alive (session_state idle), so for keyed sessions
// "over" means the conversation closed; sessions without session_state fall
// back to terminal status.
export function isConversationOver(session: Session): boolean {
  if (session.session_state != null) {
    return session.session_state === 'closed';
  }
  return TERMINAL_SESSION_STATUSES.has(session.status);
}

export interface SessionTranscriptSnapshot {
  // The enriched public session (§4.1), resent whole on any change. The
  // heavy blobs (config snapshot, input/output, executions) are REST-only.
  session: Session | null;
  // The committed record log, ordered by feed_seq, replay + live.
  records: readonly SessionRecord[];
  // The OPEN inbox slice (§3.3): PENDING rows are queued messages; a row that
  // flipped to DELIVERED appears once so queued chips retire by id.
  messages: readonly SessionMessage[];
  // Every message id the server has acknowledged on this stream — inbox rows
  // seen in snapshot/messages frames plus user-echo records'
  // session_message_id back-references. An optimistic chip whose id lands
  // here is the server's to render, so the local copy retires (§4.2).
  acknowledgedMessageIds: ReadonlySet<string>;
  // True when the replayed history is truncated under the customer's log
  // retention (records before the snapshot's earliest_feed_seq expired), so a
  // transcript can say "earlier records expired" instead of passing retained
  // history off as complete history (§3.4).
  historyTruncated: boolean;
  // The in-progress assistant response streamed via `delta` frames — cleared
  // when the committed record lands (it supersedes the partial text).
  liveText: string;
  // Cumulative output-token count for the in-progress response, or null when
  // nothing is streaming.
  liveOutputTokens: number | null;
  // When we last heard anything over the socket (epoch ms), including the
  // idle heartbeat — "alive but quiet" vs "we've lost the connection". Null
  // until the first frame.
  lastEventAt: number | null;
  // The conversation is over for good (the server's `done` frame, or a
  // session frame carrying the end state).
  conversationOver: boolean;
}

const EMPTY_SNAPSHOT: SessionTranscriptSnapshot = {
  session: null,
  records: [],
  messages: [],
  acknowledgedMessageIds: new Set(),
  historyTruncated: false,
  liveText: '',
  liveOutputTokens: null,
  lastEventAt: null,
  conversationOver: false,
};

// The pre-first-frame snapshot; also the stable server-side snapshot for
// React's useSyncExternalStore SSR path.
export function emptySessionTranscriptSnapshot(): SessionTranscriptSnapshot {
  return EMPTY_SNAPSHOT;
}

export class SessionTranscriptStore {
  private snapshot: SessionTranscriptSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private acknowledged = new Set<string>();
  // The inbox projection (protocol v3): message_received/delivered/requeued
  // RECORDS drive it; the snapshot seeds the pending set at connect. Keyed by
  // message id so a requeue can restore a message the delivered record
  // removed from the pending view.
  private inbox = new Map<string, SessionMessage>();
  // The resume cursor: the highest feed_seq received via records_append. Only
  // records advance it (§3.4) — never messages/session frames. streamSession
  // tracks its own copy; this one seeds a NEW streamSession call (e.g. a
  // page-level reconnect after unmount) from already-held state.
  private cursorSeq = 0;
  // Derived-turn cache, keyed on the records array identity.
  private turnsFor: readonly SessionRecord[] | null = null;
  private turnsCache: ChatTurn[] = [];

  get cursor(): number {
    return this.cursorSeq;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SessionTranscriptSnapshot => this.snapshot;

  // The chat-turn grouping of the current record log (memoized per
  // records_append batch) — what a chat-style transcript renders.
  chatTurns = (): ChatTurn[] => {
    const records = this.snapshot.records;
    if (this.turnsFor !== records) {
      this.turnsCache = groupRecordsToChatTurns(records);
      this.turnsFor = records;
    }
    return this.turnsCache;
  };

  // The current pending set, in feed order — what queued chips render.
  private pendingMessages = (): SessionMessage[] =>
    [...this.inbox.values()]
      .filter((m) => m.status === 'pending')
      .sort((a, b) => (a.feed_seq ?? 0) - (b.feed_seq ?? 0));

  // Fold one lifecycle record into the inbox projection; returns whether the
  // pending view changed. Unknown fields/types are ignored (§3.6).
  private applyMessageRecord = (record: SessionRecord): boolean => {
    const payload = record.payload as Record<string, unknown>;
    const messageId =
      typeof payload.message_id === 'string' ? payload.message_id : null;
    switch (record.record_type) {
      case 'message_received': {
        if (messageId == null || this.inbox.has(messageId)) return false;
        this.inbox.set(messageId, {
          id: messageId,
          session_id: record.session_id,
          feed_seq: record.feed_seq,
          status: 'pending',
          body: typeof payload.body === 'string' ? payload.body : '',
          author: typeof payload.author === 'string' ? payload.author : null,
          sender_attribution_type:
            typeof payload.sender_attribution_type === 'string'
              ? payload.sender_attribution_type
              : null,
          sender_attribution_id:
            typeof payload.sender_attribution_id === 'string'
              ? payload.sender_attribution_id
              : null,
          created_at: record.created_at,
          delivered_at: null,
          delivered_turn_id: null,
        } as SessionMessage);
        return true;
      }
      case 'message_delivered': {
        const existing = messageId != null ? this.inbox.get(messageId) : null;
        if (!existing || existing.status !== 'pending') return false;
        this.inbox.set(messageId!, {
          ...existing,
          status: 'delivered',
          delivered_at: record.created_at,
          delivered_turn_id:
            typeof payload.turn_id === 'string' ? payload.turn_id : null,
        } as SessionMessage);
        return true;
      }
      case 'message_requeued': {
        const existing = messageId != null ? this.inbox.get(messageId) : null;
        if (!existing || existing.status === 'pending') return false;
        this.inbox.set(messageId!, {
          ...existing,
          status: 'pending',
          delivered_at: null,
          delivered_turn_id: null,
        } as SessionMessage);
        return true;
      }
      default:
        return false;
    }
  };

  // Ingest one frame from the stream client. Unknown frame types stamp
  // liveness and change nothing else (§3.6).
  ingest = (rawFrame: StreamFrame): void => {
    const prev = this.snapshot;
    const next: SessionTranscriptSnapshot = {
      ...prev,
      lastEventAt: Date.now(),
    };

    // The open StreamFrame union can't discriminate on `type` (its forward-
    // compat catch-all matches every literal); narrowing through the closed
    // union is safe because an actually-unknown type value falls to the
    // default arm at runtime.
    const frame = rawFrame as SessionStreamFrame;
    switch (frame.type) {
      case 'snapshot': {
        next.session = frame.session;
        for (const message of frame.messages) {
          this.inbox.set(message.id, message);
          this.acknowledged.add(message.id);
        }
        next.messages = this.pendingMessages();
        next.acknowledgedMessageIds = new Set(this.acknowledged);
        next.conversationOver = isConversationOver(frame.session);
        // Truncation is visible, never silent (§3.4): our replay resumes from
        // the cursor; anything older than the retention head expired.
        next.historyTruncated =
          frame.earliest_feed_seq != null &&
          this.cursorSeq < frame.earliest_feed_seq - 1;
        break;
      }
      case 'records_append': {
        // The cursor advances on every record in the frame — including ones a
        // renderer shows as nothing (§3.4). Guard against overlap anyway (a
        // server replaying from an older cursor after our state advanced).
        const fresh = frame.records.filter((r) => r.feed_seq > this.cursorSeq);
        if (fresh.length === 0) break;
        this.cursorSeq = fresh[fresh.length - 1].feed_seq;
        next.records = [...prev.records, ...fresh];
        let acknowledgedNew = false;
        let inboxChanged = false;
        for (const record of fresh) {
          if (record.session_message_id != null) {
            this.acknowledged.add(record.session_message_id);
            acknowledgedNew = true;
          }
          // Inbox state changes ride the feed as message_* records
          // (protocol v3) — there is no mutable messages frame.
          if (record.source === 'lifecycle') {
            inboxChanged = this.applyMessageRecord(record) || inboxChanged;
            if (
              record.record_type === 'message_received' ||
              record.record_type === 'message_delivered'
            ) {
              const payload = record.payload as Record<string, unknown>;
              if (typeof payload.message_id === 'string') {
                this.acknowledged.add(payload.message_id);
                acknowledgedNew = true;
              }
            }
          }
        }
        if (inboxChanged) next.messages = this.pendingMessages();
        if (acknowledgedNew) {
          next.acknowledgedMessageIds = new Set(this.acknowledged);
        }
        // The committed record(s) supersede the partial text we've been
        // showing, so drop the live overlay.
        next.liveText = '';
        next.liveOutputTokens = null;
        break;
      }
      case 'session': {
        next.session = frame.session;
        next.conversationOver = isConversationOver(frame.session);
        break;
      }
      case 'delta': {
        // Unknown kinds ("thinking" is reserved) are ignored per §3.6.
        if (frame.kind !== 'text') break;
        if (frame.text != null) next.liveText = prev.liveText + frame.text;
        if (frame.output_tokens != null)
          next.liveOutputTokens = frame.output_tokens;
        break;
      }
      case 'done': {
        next.conversationOver = true;
        break;
      }
      default:
        // heartbeat, error (terminal copy is surfaced by the stream client's
        // outcome), and unknown future frames: liveness only.
        break;
    }

    this.snapshot = next;
    for (const listener of this.listeners) listener();
  };
}
