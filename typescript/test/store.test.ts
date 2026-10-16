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
import type {
  Session,
  SessionRecord,
  SessionStreamFrame,
  SnapshotFrame,
} from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/golden_stream.json'), 'utf8')
) as { frames: SessionStreamFrame[]; close_code: number };

const frameTypes = fixture.frames.map((f) => f.type);
const firstRecord = fixture.frames.flatMap((frame) =>
  frame.type === 'records_append' ? frame.records : []
)[0];

describe('golden fixture replay', () => {
  it('covers the protocol’s delivery classes and ends closed', () => {
    // The recorded scenario: snapshot, record replay, the running turn
    // ending and the queued message's turn starting AS RECORDS (turn_ended,
    // turn_started, message_delivered — there is no mutable messages frame),
    // a session frame once the agent starts on the message, a live turn (echo
    // record, delta, reply), the turn_ended and session_closed records, the
    // closing session frame, done. If the server loop's emissions change
    // sequence, the backend regenerates this fixture and the diff spells out
    // what a client must handle.
    expect(frameTypes).toEqual([
      'snapshot',
      'records_append',
      'records_append',
      'session',
      'records_append',
      'delta',
      'records_append',
      'records_append',
      'session',
      'done',
    ]);
    const sessions = fixture.frames.flatMap((frame) =>
      frame.type === 'session' ? [frame.session] : []
    );
    expect(sessions.map((s) => s.turn?.status)).toEqual([
      'running',
      'completed',
    ]);
    expect(sessions.map((s) => s.conversation.state)).toEqual([
      'open',
      'closed',
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

    // Records accumulated across every records_append, and the cursor is the
    // highest feed_seq (the queued inbox row consumed a feed_seq for its
    // transcript placement, so the record log skips it).
    expect(final.records.map((r) => r.feed_seq)).toEqual([
      1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(store.cursor).toBe(12);
    // Both turns started and ended on the feed; the conversation closed last.
    expect(
      final.records
        .filter((r) => r.source === 'lifecycle')
        .map((r) => [r.record_type, r.turn_id])
    ).toEqual([
      ['turn_started', 'turn_golden_0'],
      ['message_received', 'turn_golden_1'],
      ['turn_ended', 'turn_golden_0'],
      ['turn_started', 'turn_golden_1'],
      ['message_delivered', 'turn_golden_1'],
      ['turn_ended', 'turn_golden_1'],
      ['session_closed', null],
    ]);
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

    // The queued message was acknowledged twice over — the delivery lifecycle
    // record AND the user-echo record's back-reference — so an optimistic chip
    // keyed on its id retires.
    expect(final.acknowledgedMessageIds.has('message_GOLDEN_1')).toBe(true);
    const echo = final.records.find(
      (r) => r.source === 'claude_code' && r.session_message_id != null
    );
    expect(echo?.session_message_id).toBe('message_GOLDEN_1');
    expect(echo?.turn_id).toBe('turn_golden_1');

    // The closing session frame carried the end state before done (§3.3).
    expect(final.session?.conversation.state).toBe('closed');
    expect(final.session?.turn?.status).toBe('completed');
    expect(final.conversationOver).toBe(true);
    expect(notified).toBe(fixture.frames.length);
  });

  it('groups the golden records into chat turns', () => {
    const store = new SessionTranscriptStore();
    for (const frame of fixture.frames) store.ingest(frame);

    const turns = store.chatTurns();
    expect(turns.map((t) => t.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'lifecycle',
    ]);
    // The replayed assistant records share one open turn (no result event
    // closed it); the human message stands alone where its message_received
    // record landed; the reply opens a fresh agent turn. Completed turns draw
    // nothing; the closed conversation draws one row.
    expect(turns[0].nodes).toHaveLength(2);
    expect(turns[1].nodes[0]).toMatchObject({
      kind: 'user',
      text: 'please also update the docs',
    });
    expect(turns[2].nodes[0]).toMatchObject({
      kind: 'assistant',
      text: 'Docs updated.',
    });
    expect(turns[3].nodes).toMatchObject([
      { kind: 'lifecycle', recordType: 'session_closed' },
    ]);
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
    store.ingest({ ...snapshot, earliest_feed_seq: 10 } as StreamFrame);
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
    store.ingest({ type: 'jubilee', anything: true } as unknown as StreamFrame);
    const after = store.getSnapshot();
    expect(after.records).toHaveLength(before.length);
    expect(after.lastEventAt).not.toBeNull();
    expect(prevEventAt).not.toBeNull();
  });

  it('projects the inbox from message records, following each requeue', () => {
    const store = new SessionTranscriptStore();
    const lifecycle = (
      feed_seq: number,
      record_type: string,
      payload: Record<string, unknown>
    ): SessionRecord =>
      ({
        ...firstRecord,
        id: `rec_${feed_seq}`,
        kind: 'platform',
        record_format: 'ellipsis_lifecycle@1',
        source: 'lifecycle',
        record_type,
        payload,
        feed_seq,
        turn_id: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      }) as SessionRecord;
    store.ingest({
      type: 'records_append',
      records: [
        lifecycle(1, 'message_received', {
          message_id: 'm1',
          body: 'go',
          turn_id: 't1',
        }),
      ],
    });
    expect(store.getSnapshot().messages).toMatchObject([
      { id: 'm1', status: 'pending', turn_id: 't1', images: [] },
    ]);
    store.ingest({
      type: 'records_append',
      records: [
        lifecycle(2, 'message_delivered', { message_id: 'm1', turn_id: 't1' }),
      ],
    });
    expect(store.getSnapshot().messages).toEqual([]);
    store.ingest({
      type: 'records_append',
      records: [
        lifecycle(3, 'message_requeued', {
          message_id: 'm1',
          turn_id: 't1',
          requeued_turn_id: 't2',
        }),
      ],
    });
    expect(store.getSnapshot().messages).toMatchObject([
      { id: 'm1', status: 'pending', turn_id: 't2' },
    ]);
    // Old record types in historical feeds change nothing and never throw.
    store.ingest({
      type: 'records_append',
      records: [
        lifecycle(4, 'session_idle', {}),
        lifecycle(5, 'sandbox_ready', { repositories: [] }),
      ],
    });
    expect(store.getSnapshot().messages).toHaveLength(1);
    expect(store.cursor).toBe(5);
  });

  it('ignores unknown delta kinds', () => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'delta',
      turn_id: null,
      kind: 'future-kind',
      text: 'secret plan',
      output_tokens: 9,
    });
    expect(store.getSnapshot().liveText).toBe('');
    expect(store.getSnapshot().liveOutputTokens).toBeNull();
  });

  it('replaces summary snapshots independently of assistant text and tool records', () => {
    const store = new SessionTranscriptStore();
    const summary = (text: string | null) =>
      store.ingest({
        type: 'delta',
        turn_id: 'turn_1',
        kind: 'thinking',
        text,
        output_tokens: null,
      });
    summary('**Inspecting');
    summary('**Inspecting the mock server**');
    summary(null);
    expect(store.getSnapshot().liveSummary).toBe(
      '**Inspecting the mock server**'
    );
    expect(store.getSnapshot().liveText).toBe('');
    const record = fixture.frames
      .flatMap((f) => (f.type === 'records_append' ? f.records : []))
      .find((r) => r.source === 'claude_code');
    if (!record) throw new Error('fixture');
    store.ingest({
      type: 'records_append',
      records: [
        {
          ...record,
          kind: 'platform',
          record_format: 'ellipsis_lifecycle@1',
          feed_seq: 1,
          source: 'lifecycle',
          record_type: 'turn_started',
          payload: { turn_id: 'turn_1', turn_index: 0 },
          turn_id: 'turn_1',
        } as SessionRecord,
      ],
    });
    // The stream may deliver the summary before the same turn's start record.
    expect(store.getSnapshot().liveSummary).toBe(
      '**Inspecting the mock server**'
    );
    store.ingest({
      type: 'records_append',
      records: [{ ...record, feed_seq: 2 }],
    });
    expect(store.getSnapshot().liveSummary).toBe(
      '**Inspecting the mock server**'
    );
    summary('');
    expect(store.getSnapshot().liveSummary).toBe('');
    summary('Checking tests');
    store.ingest({
      type: 'delta',
      kind: 'text',
      text: 'Found it',
      output_tokens: 4,
      turn_id: 'turn_1',
    });
    expect(store.getSnapshot()).toMatchObject({
      liveSummary: '',
      liveText: 'Found it',
      liveOutputTokens: 4,
    });
  });

  it('keeps the live summary while its turn is running', () => {
    const store = new SessionTranscriptStore();
    const snapshot = fixture.frames[0] as SnapshotFrame;
    store.ingest(snapshot);
    store.ingest({
      type: 'delta',
      kind: 'thinking',
      text: 'Checking tests',
      output_tokens: null,
      turn_id: snapshot.session.turn?.id ?? null,
    });
    // Cost updates resend the session whole with the turn still running.
    store.ingest({ type: 'session', session: snapshot.session });
    expect(store.getSnapshot().liveSummary).toBe('Checking tests');
  });

  it.each([
    'turn_ended',
    'turn_started',
    'snapshot',
    'done',
    'error',
    'turn final',
  ])('clears the live summary on %s', (event) => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'delta',
      kind: 'thinking',
      text: 'Checking tests',
      output_tokens: null,
      turn_id: 'turn_1',
    });
    const snapshot = fixture.frames[0] as SnapshotFrame;
    if (event === 'snapshot') store.ingest(snapshot);
    else if (event === 'done') store.ingest({ type: 'done' });
    else if (event === 'error')
      store.ingest({ type: 'error', message: 'Disconnected' });
    else if (event === 'turn final') {
      if (!snapshot.session.turn) throw new Error('fixture session turn');
      store.ingest({
        type: 'session',
        session: {
          ...snapshot.session,
          turn: { ...snapshot.session.turn, id: 'turn_1', status: 'completed' },
        },
      });
    } else
      store.ingest({
        type: 'records_append',
        records: [
          {
            ...firstRecord,
            kind: 'platform',
            record_format: 'ellipsis_lifecycle@1',
            source: 'lifecycle',
            record_type: event,
            payload: {
              turn_id: event === 'turn_started' ? 'turn_2' : 'turn_1',
              turn_index: 0,
              ...(event === 'turn_ended' ? { status: 'completed' } : {}),
            },
            feed_seq: 1,
            turn_id: event === 'turn_started' ? 'turn_2' : 'turn_1',
          } as SessionRecord,
        ],
      });
    expect(store.getSnapshot().liveSummary).toBe('');
  });
});

describe('isConversationOver', () => {
  const session = (state: 'open' | 'closed', status: string): Session =>
    ({ conversation: { state }, turn: { status } }) as unknown as Session;

  it('an open conversation stays open whatever its latest turn did', () => {
    expect(isConversationOver(session('open', 'completed'))).toBe(false);
    expect(isConversationOver(session('open', 'failed'))).toBe(false);
    expect(isConversationOver(session('closed', 'completed'))).toBe(true);
    expect(isConversationOver(session('closed', 'stopped'))).toBe(true);
  });
});
