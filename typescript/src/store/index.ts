// The session transcript store: feed it every frame the stream client
// delivers (and nothing else) and it maintains the renderable state of one
// session — the session snapshot, the committed record log, the ephemeral
// delta overlay, the resume cursor, and the derived chat-turn grouping.
// Framework-free: `subscribe`/`getSnapshot` are shaped for React's
// useSyncExternalStore, but any renderer can poll the snapshot.

import type { Session, SessionRecord, StreamFrame } from '../types';
import type { ChatTurn } from './chatTurns';
import { groupRecordsToChatTurns } from './chatTurns';

export * from './chatTurns';
export * from './derive';
export * from './layout';
export * from './ledger';
export * from './activity';
export type { MessageProgress, MessageTiming, WorkPhase } from './progress';
export * from './lifecycle';
export * from './transcript';
export { claudePayload } from './claude';
export { codexSubagentThreads, isCodexSubagentRecord } from './codexAppServer';
export type { StreamFrame } from '../types';

// Permanent closure: the session can take no more messages.
export function isConversationOver(session: Session): boolean {
  return session.status === 'closed';
}

export interface SessionTranscriptSnapshot {
  // The public session, resent whole on any change.
  session: Session | null;
  // The committed record log, ordered by feed_seq, replay + live.
  records: readonly SessionRecord[];
  // Every message id the server has recorded on this stream: a `message`
  // record landed, or a record carried the id as its `message_id`. An
  // optimistic chip whose id lands here is the server's to render, so the
  // local copy retires.
  acknowledgedMessageIds: ReadonlySet<string>;
  // The in-progress assistant response streamed via `delta` frames — cleared
  // when the committed record lands (it supersedes the partial text).
  liveText: string;
  // Latest readable reasoning-summary prefix. Ephemeral replacement state,
  // retained across tool records and cleared when the agent writes or stops.
  liveSummary: string;
  // Cumulative output-token count for the in-progress response, or null when
  // nothing is streaming.
  liveOutputTokens: number | null;
  // When we last heard anything over the socket (epoch ms), including the
  // keepalive heartbeat — "alive but quiet" vs "we've lost the connection". Null
  // until the first frame.
  lastEventAt: number | null;
  // The session is closed for good (a session frame with status `closed`).
  conversationOver: boolean;
}

// Seed a store from REST results — the fetched session plus its stored
// records page — as synthetic frames through the same ingest path the live
// stream uses, so the first paint is instant and a streamSession started from
// `store.cursor` resumes past the seeded history instead of replaying it.
// Every REST-then-stream client needs exactly this dance; it lives here so
// none of them hand-build frames.
export function seedTranscriptStore(
  store: SessionTranscriptStore,
  seed: {
    session: Session;
    records: readonly SessionRecord[];
  }
): void {
  store.ingest({ type: 'session', session: seed.session });
  const ordered = [...seed.records].sort((a, b) => a.feed_seq - b.feed_seq);
  if (ordered.length) store.ingest({ type: 'records', records: ordered });
}

const EMPTY_SNAPSHOT: SessionTranscriptSnapshot = {
  session: null,
  records: [],
  acknowledgedMessageIds: new Set(),
  liveText: '',
  liveSummary: '',
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
  // The resume cursor: the highest feed_seq received via records frames. Only
  // records advance it — never session frames. streamSession tracks its own
  // copy; this one seeds a NEW streamSession call (e.g. a page-level
  // reconnect after unmount) from already-held state.
  private cursorSeq = 0;
  // Derived-turn cache, keyed on the records array identity.
  private turnsFor: readonly SessionRecord[] | null = null;
  private turnsSession: Session | null = null;
  private turnsCache: ChatTurn[] = [];
  private summaryMessageId: string | null = null;

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
    if (
      this.turnsFor !== records ||
      this.turnsSession !== this.snapshot.session
    ) {
      this.turnsCache = groupRecordsToChatTurns(records, this.snapshot.session);
      this.turnsFor = records;
      this.turnsSession = this.snapshot.session;
    }
    return this.turnsCache;
  };

  // Ingest one frame from the stream client. Unknown frame types stamp
  // liveness and change nothing else.
  ingest = (rawFrame: StreamFrame): void => {
    const prev = this.snapshot;
    const next: SessionTranscriptSnapshot = {
      ...prev,
      lastEventAt: Date.now(),
    };

    const frame = rawFrame;
    switch (frame.type) {
      case 'records': {
        // The cursor advances on every record in the frame — including ones a
        // renderer shows as nothing. Guard against overlap anyway (a
        // server replaying from an older cursor after our state advanced).
        const fresh = frame.records.filter((r) => r.feed_seq > this.cursorSeq);
        if (fresh.length === 0) break;
        this.cursorSeq = fresh[fresh.length - 1].feed_seq;
        next.records = [...prev.records, ...fresh];
        let acknowledgedNew = false;
        for (const record of fresh) {
          if (record.message_id != null) {
            this.acknowledged.add(record.message_id);
            acknowledgedNew = true;
          }
          if (record.source === 'lifecycle') {
            // The reasoning preview belongs to one message: another message
            // starting, or its own message ending, retires it.
            if (
              (record.record_type === 'message_started' &&
                record.message_id !== this.summaryMessageId) ||
              (record.record_type === 'message_ended' &&
                record.message_id === this.summaryMessageId)
            )
              next.liveSummary = '';
            if (record.record_type === 'message') {
              const payload = record.payload as Record<string, unknown>;
              if (typeof payload.id === 'string') {
                this.acknowledged.add(payload.id);
                acknowledgedNew = true;
              }
            }
          }
        }
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
        // Nothing running means no reasoning to preview.
        if (frame.session.status !== 'running') next.liveSummary = '';
        break;
      }
      case 'delta': {
        if (frame.kind === 'thinking') {
          if (next.conversationOver) break;
          this.summaryMessageId = frame.message_id;
          if (frame.text != null) next.liveSummary = frame.text;
          break;
        }
        // Unknown kinds are ignored.
        if (frame.kind !== 'text') break;
        if (frame.text != null) {
          next.liveText = prev.liveText + frame.text;
          next.liveSummary = '';
        }
        if (frame.output_tokens != null)
          next.liveOutputTokens = frame.output_tokens;
        break;
      }
      case 'error': {
        next.liveSummary = '';
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
