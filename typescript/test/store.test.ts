// The store replays the vendored golden fixture — the frame sequence the
// backend's test_sdk_golden_fixture.py recorded from the REAL server loop —
// so server and client agree on real emissions or CI fails (protocol §6).
// Sequencing/behavior only: frame shape is owned by the generated schema.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SessionTranscriptStore,
  isConversationOver,
  seedTranscriptStore,
  type StreamFrame,
} from '../src/store';
import type { Session, SessionRecord, SnapshotFrame } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/golden_stream.json'), 'utf8')
) as { frames: StreamFrame[]; close_code: number };

const frameTypes = fixture.frames.map((f) => f.type);

describe('golden fixture replay', () => {
  it('covers the protocol’s delivery classes and ends closed', () => {
    // The recorded scenario (protocol v3): snapshot, record replay, the
    // inbox state changes AS RECORDS (message_received/delivered — there is
    // no mutable messages frame), a live turn (echo record, delta, reply
    // record), the closing session frame, done. If the server loop's
    // emissions change shape-of-sequence, the backend test regenerates and
    // this spells out what a client must handle.
    expect(frameTypes).toEqual([
      'snapshot',
      'records_append',
      'records_append',
      'records_append',
      'delta',
      'records_append',
      'session',
      'done',
    ]);
    expect(fixture.close_code).toBe(1000);
  });

  it('drives the store through the full session lifecycle', () => {
    const store = new SessionTranscriptStore();
    let notified = 0;
    store.subscribe(() => notified++);

    const byStage: Record<string, ReturnType<typeof store.getSnapshot>> = {};
    for (const frame of fixture.frames) {
      store.ingest(frame);
      byStage[frame.type] = store.getSnapshot();
      if (frame.type === 'delta') {
        // The delta overlays until the committed record supersedes it.
        expect(store.getSnapshot().liveText).toBe('On it — ');
        expect(store.getSnapshot().liveOutputTokens).toBe(4);
      }
    }

    const final = store.getSnapshot();
    // The snapshot seeded session + the queued inbox row; replay was not
    // truncated (we started from 0 and the retention head is the first row).
    expect(byStage.snapshot.session?.id).toBe('session_GOLDEN');
    expect(byStage.snapshot.messages.map((m) => m.status)).toEqual(['pending']);
    expect(byStage.snapshot.historyTruncated).toBe(false);

    // Records accumulated across every records_append; feed_seq 1 is the
    // session_scheduled lifecycle record every insert emits, and the cursor
    // is the highest feed_seq (the delivered inbox row consumed a feed_seq
    // for its transcript placement, so the record log skips it).
    expect(final.records.map((r) => r.feed_seq)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(store.cursor).toBe(8);
    // The message lifecycle rode the feed: received then delivered, and the
    // pending projection is empty once the turn consumed it.
    expect(
      final.records
        .filter((r) => r.record_type.startsWith('message_'))
        .map((r) => r.record_type)
    ).toEqual(['message_received', 'message_delivered']);
    expect(final.messages).toEqual([]);

    // The committed reply superseded the delta overlay.
    expect(final.liveText).toBe('');
    expect(final.liveOutputTokens).toBeNull();

    // The queued message was acknowledged twice over — the messages-frame
    // flip AND the user-echo record's back-reference — so an optimistic chip
    // keyed on its id retires.
    expect(final.acknowledgedMessageIds.has('message_GOLDEN_1')).toBe(true);
    const echo = final.records.find((r) => r.session_message_id != null);
    expect(echo?.session_message_id).toBe('message_GOLDEN_1');
    expect(echo?.agent_turn_id).toBe('turn_golden_1');

    // The closing session frame carried the end state before done (§3.3).
    expect(final.session?.session_state).toBe('closed');
    expect(final.conversationOver).toBe(true);
    expect(notified).toBe(fixture.frames.length);
  });

  it('groups the golden records into chat turns', () => {
    const store = new SessionTranscriptStore();
    for (const frame of fixture.frames) store.ingest(frame);

    const turns = store.chatTurns();
    expect(turns.map((t) => t.role)).toEqual([
      'lifecycle',
      'assistant',
      'user',
      'assistant',
    ]);
    // The session_scheduled record opens the feed as a lifecycle turn; the
    // replayed assistant records share one open turn (no result event
    // closed it); the echoed human message stands alone; the reply opens a
    // fresh agent turn.
    expect(turns[0].nodes[0]).toMatchObject({
      kind: 'lifecycle',
      recordType: 'session_scheduled',
    });
    expect(turns[1].nodes).toHaveLength(2);
    expect(turns[2].nodes[0]).toMatchObject({
      kind: 'user',
      text: 'please also update the docs',
    });
    expect(turns[3].nodes[0]).toMatchObject({
      kind: 'assistant',
      text: 'Docs updated.',
    });
    // Memoized per records batch: same array in, same result out.
    expect(store.chatTurns()).toBe(turns);
  });
});

describe('seedTranscriptStore', () => {
  it('seeds from REST results exactly like the stream replay', () => {
    // Build the REST shape from the golden fixture, then check the seeded
    // store matches one fed the equivalent frames directly.
    const snapshot = fixture.frames[0] as SnapshotFrame;
    const records = fixture.frames
      .filter((f) => f.type === 'records_append')
      .flatMap((f) => (f as { records: SessionRecord[] }).records);

    const seeded = new SessionTranscriptStore();
    seedTranscriptStore(seeded, {
      session: snapshot.session,
      // Reversed on purpose: REST pages are re-sorted by feed_seq.
      records: [...records].reverse(),
      messages: snapshot.messages,
      earliestFeedSeq: snapshot.earliest_feed_seq,
    });

    const snap = seeded.getSnapshot();
    expect(snap.session?.id).toBe(snapshot.session.id);
    expect(snap.records.map((r) => r.feed_seq)).toEqual(
      records.map((r) => r.feed_seq).sort((a, b) => a - b)
    );
    expect(snap.historyTruncated).toBe(false);
    // The cursor advanced past the seeded history, so a streamSession started
    // from it resumes rather than replaying.
    expect(seeded.cursor).toBe(Math.max(...records.map((r) => r.feed_seq)));
  });

  it('seeds a recordless session from the snapshot alone', () => {
    const snapshot = fixture.frames[0] as SnapshotFrame;
    const store = new SessionTranscriptStore();
    seedTranscriptStore(store, { session: snapshot.session, records: [] });
    expect(store.getSnapshot().session?.id).toBe(snapshot.session.id);
    expect(store.cursor).toBe(0);
  });
});

describe('store edge behavior', () => {
  it('flags truncated history when resuming past the retention head', () => {
    const store = new SessionTranscriptStore();
    const snapshot = fixture.frames[0] as StreamFrame & {
      earliest_feed_seq: number | null;
    };
    store.ingest({ ...snapshot, earliest_feed_seq: 10 });
    expect(store.getSnapshot().historyTruncated).toBe(true);
  });

  it('ignores overlapping records and unknown frame types', () => {
    const store = new SessionTranscriptStore();
    for (const frame of fixture.frames) store.ingest(frame);
    const before = store.getSnapshot().records;

    // A replay overlapping the cursor adds nothing.
    store.ingest(fixture.frames[1]);
    expect(store.getSnapshot().records).toHaveLength(before.length);

    // Unknown frames stamp liveness and change nothing else (§3.6).
    const prevEventAt = store.getSnapshot().lastEventAt;
    store.ingest({ type: 'jubilee', anything: true } as StreamFrame);
    const after = store.getSnapshot();
    expect(after.records).toHaveLength(before.length);
    expect(after.lastEventAt).not.toBeNull();
    expect(prevEventAt).not.toBeNull();
  });

  it('ignores non-text delta kinds', () => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'delta',
      agent_turn_id: null,
      kind: 'thinking',
      text: 'secret plan',
      output_tokens: 9,
    });
    expect(store.getSnapshot().liveText).toBe('');
    expect(store.getSnapshot().liveOutputTokens).toBeNull();
  });
});

describe('isConversationOver', () => {
  const session = (over: Partial<Session>): Session =>
    ({ status: 'running', session_state: null, ...over }) as Session;

  it('keyed sessions close on session_state, not per-turn status', () => {
    expect(
      isConversationOver(
        session({ status: 'completed', session_state: 'idle' })
      )
    ).toBe(false);
    expect(
      isConversationOver(
        session({ status: 'completed', session_state: 'closed' })
      )
    ).toBe(true);
  });

  it('state-less (laptop) sessions fall back to terminal status', () => {
    expect(isConversationOver(session({ status: 'running' }))).toBe(false);
    expect(isConversationOver(session({ status: 'stopped' }))).toBe(true);
  });
});
