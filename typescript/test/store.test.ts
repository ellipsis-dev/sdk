// The store replays the vendored golden fixture — the frame sequence the
// backend's test_sdk_golden_fixture.py recorded from the REAL server loop —
// so server and client agree on real emissions or CI fails.
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
  SessionFrame,
  SessionRecord,
  SessionStreamFrame,
} from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/golden_stream.json'), 'utf8')
) as { frames: SessionStreamFrame[]; close_code: number };

const frameTypes = fixture.frames.map((f) => f.type);
const firstRecord = fixture.frames.flatMap((frame) =>
  frame.type === 'records' ? frame.records : []
)[0];
const sessionFrames = fixture.frames.filter(
  (f): f is SessionFrame => f.type === 'session'
);
const opening = sessionFrames[0];
const closing = sessionFrames[sessionFrames.length - 1];

describe('golden fixture replay', () => {
  it('covers the protocol’s delivery classes and ends closed', () => {
    // The recorded scenario: the session, record replay (the opening
    // message, its start, the agent's steps, a queued follow-up), the first
    // message ending and the follow-up starting AS RECORDS, a session frame
    // once the agent starts on the message, a live answer (echo record,
    // delta, reply), the message_ended record and the idle session frame,
    // the session_closed record and the closing session frame, then a
    // normal close. If the server loop's
    // emissions change sequence, the backend regenerates this fixture and the
    // diff spells out what a client must handle.
    expect(frameTypes).toEqual([
      'session',
      'records',
      'records',
      'session',
      'records',
      'delta',
      'records',
      'records',
      'session',
      'records',
      'session',
    ]);
    expect(sessionFrames.map((f) => f.session.status)).toEqual([
      'running',
      'running',
      'idle',
      'closed',
    ]);
    expect(sessionFrames.map((f) => f.session.error)).toEqual([
      null,
      null,
      null,
      null,
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
      byStage[frame.type] ??= store.getSnapshot();
      if (frame.type === 'delta') {
        // The delta overlays until the committed record supersedes it.
        expect(store.getSnapshot().liveText).toBe('On it — ');
        expect(store.getSnapshot().liveOutputTokens).toBe(4);
      }
    }

    const final = store.getSnapshot();
    // The first frame seeded the session.
    expect(byStage.session.session?.id).toBe('session_GOLDEN');
    expect(byStage.session.session?.status).toBe('running');
    expect(byStage.session.records).toEqual([]);

    // Records accumulated across every records frame, and the cursor is the
    // highest feed_seq.
    expect(final.records.map((r) => r.feed_seq)).toEqual([
      2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(store.cursor).toBe(13);
    // Both messages started and ended on the feed; the session closed last.
    expect(
      final.records
        .filter((r) => r.source === 'lifecycle')
        .map((r) => [r.record_type, r.message_id])
    ).toEqual([
      ['message', 'message_GOLDEN_0'],
      ['message_started', 'message_GOLDEN_0'],
      ['message', 'message_GOLDEN_1'],
      ['message_ended', 'message_GOLDEN_0'],
      ['message_started', 'message_GOLDEN_1'],
      ['message_ended', 'message_GOLDEN_1'],
      ['session_closed', null],
    ]);
    // A message record names its message in the payload and the envelope.
    const message = final.records.find(
      (r) => r.kind === 'platform' && r.record_type === 'message'
    );
    expect(message?.kind === 'platform' && message.payload.id).toBe(
      message?.message_id
    );

    // The committed reply superseded the delta overlay.
    expect(final.liveText).toBe('');
    expect(final.liveOutputTokens).toBeNull();

    // Every message id the feed carried is acknowledged, so an optimistic
    // chip keyed on it retires.
    expect(final.acknowledgedMessageIds).toEqual(
      new Set(['message_GOLDEN_0', 'message_GOLDEN_1'])
    );
    const echo = final.records.find(
      (r) => r.source === 'claude_code' && r.record_type === 'user'
    );
    expect(echo?.message_id).toBe('message_GOLDEN_1');

    // The closing session frame carried the end state before the close.
    expect(final.session?.status).toBe('closed');
    expect(final.conversationOver).toBe(true);
    expect(notified).toBe(fixture.frames.length);
  });

  it('groups the golden records into chat turns', () => {
    const store = new SessionTranscriptStore();
    for (const frame of fixture.frames) store.ingest(frame);

    const turns = store.chatTurns();
    expect(turns.map((t) => [t.role, t.messageId])).toEqual([
      ['user', 'message_GOLDEN_0'],
      ['assistant', 'message_GOLDEN_0'],
      ['user', 'message_GOLDEN_1'],
      ['assistant', 'message_GOLDEN_1'],
      ['lifecycle', undefined],
    ]);
    // Each message stands where its record landed; the replayed assistant
    // records share one turn (no result event closed it); the reply opens a
    // fresh agent turn. Answered messages draw nothing; the closed session
    // draws one row.
    expect(turns[0].nodes[0]).toMatchObject({
      kind: 'user',
      text: 'Do something',
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
    expect(turns[4].nodes).toMatchObject([
      { kind: 'lifecycle', recordType: 'session_closed' },
    ]);
    expect(turns.map((t) => t.progress?.phase)).toEqual([
      null,
      undefined,
      null,
      undefined,
      undefined,
    ]);
    // Memoized per records batch: same array in, same result out.
    expect(store.chatTurns()).toBe(turns);
  });
});

describe('seedTranscriptStore', () => {
  it('seeds from REST results exactly like the stream replay', () => {
    // Build the REST shape from the golden fixture, then check the seeded
    // store matches one fed the equivalent frames directly.
    const records = fixture.frames
      .filter((f) => f.type === 'records')
      .flatMap((f) => (f as { records: SessionRecord[] }).records);

    const seeded = new SessionTranscriptStore();
    seedTranscriptStore(seeded, {
      session: opening.session,
      // Reversed on purpose: REST pages are re-sorted by feed_seq.
      records: [...records].reverse(),
    });

    const snap = seeded.getSnapshot();
    expect(snap.session?.id).toBe(opening.session.id);
    expect(snap.records.map((r) => r.feed_seq)).toEqual(
      records.map((r) => r.feed_seq).sort((a, b) => a - b)
    );
    expect(snap.acknowledgedMessageIds).toEqual(
      new Set(['message_GOLDEN_0', 'message_GOLDEN_1'])
    );
    // The cursor advanced past the seeded history, so a streamSession started
    // from it resumes rather than replaying.
    expect(seeded.cursor).toBe(Math.max(...records.map((r) => r.feed_seq)));
  });

  it('seeds a recordless session from the session alone', () => {
    const store = new SessionTranscriptStore();
    seedTranscriptStore(store, { session: opening.session, records: [] });
    expect(store.getSnapshot().session?.id).toBe(opening.session.id);
    expect(store.cursor).toBe(0);
  });
});

describe('store edge behavior', () => {
  const lifecycle = (
    feed_seq: number,
    record_type: string,
    payload: Record<string, unknown>,
    message_id: string | null = typeof payload.message_id === 'string'
      ? payload.message_id
      : null
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
      message_id,
    }) as SessionRecord;

  it('ignores overlapping records and unknown frame types', () => {
    const store = new SessionTranscriptStore();
    for (const frame of fixture.frames) store.ingest(frame);
    const before = store.getSnapshot().records;

    // A replay overlapping the cursor adds nothing.
    store.ingest(fixture.frames[1]);
    expect(store.getSnapshot().records).toHaveLength(before.length);

    // Unknown frames stamp liveness and change nothing else.
    const prevEventAt = store.getSnapshot().lastEventAt;
    store.ingest({ type: 'jubilee', anything: true } as unknown as StreamFrame);
    const after = store.getSnapshot();
    expect(after.records).toHaveLength(before.length);
    expect(after.lastEventAt).not.toBeNull();
    expect(prevEventAt).not.toBeNull();
  });

  it('acknowledges message ids from message records and record envelopes', () => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'records',
      records: [
        lifecycle(1, 'message', { id: 'm1', index: 0, body: 'go' }, 'm1'),
      ],
    });
    expect(store.getSnapshot().acknowledgedMessageIds).toEqual(new Set(['m1']));
    store.ingest({
      type: 'records',
      records: [lifecycle(2, 'message_started', { message_id: 'm1' })],
    });
    store.ingest({
      type: 'records',
      records: [lifecycle(3, 'message_requeued', { message_id: 'm1' })],
    });
    expect(store.getSnapshot().acknowledgedMessageIds).toEqual(new Set(['m1']));
    // Old record types in historical feeds change nothing and never throw.
    store.ingest({
      type: 'records',
      records: [
        lifecycle(4, 'session_idle', {}),
        lifecycle(5, 'sandbox_ready', { repositories: [] }),
        lifecycle(6, 'message_delivered', { message_id: 'm2' }),
      ],
    });
    expect(store.getSnapshot().acknowledgedMessageIds).toEqual(
      new Set(['m1', 'm2'])
    );
    expect(store.cursor).toBe(6);
  });

  it('ignores unknown delta kinds', () => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'delta',
      message_id: null,
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
        message_id: 'message_1',
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
      .flatMap((f) => (f.type === 'records' ? f.records : []))
      .find((r) => r.source === 'claude_code');
    if (!record) throw new Error('fixture');
    store.ingest({
      type: 'records',
      records: [lifecycle(1, 'message_started', { message_id: 'message_1' })],
    });
    // The stream may deliver the summary before the same message's start
    // record.
    expect(store.getSnapshot().liveSummary).toBe(
      '**Inspecting the mock server**'
    );
    store.ingest({
      type: 'records',
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
      message_id: 'message_1',
    });
    expect(store.getSnapshot()).toMatchObject({
      liveSummary: '',
      liveText: 'Found it',
      liveOutputTokens: 4,
    });
  });

  it('keeps the live summary while the session is running', () => {
    const store = new SessionTranscriptStore();
    store.ingest(opening);
    store.ingest({
      type: 'delta',
      kind: 'thinking',
      text: 'Checking tests',
      output_tokens: null,
      message_id: 'message_GOLDEN_1',
    });
    // Cost updates resend the session whole with the status still running.
    store.ingest({ type: 'session', session: opening.session });
    expect(store.getSnapshot().liveSummary).toBe('Checking tests');
  });

  it.each([
    'message_ended',
    'message_started',
    'session closed',
    'session idle',
    'error',
  ])('clears the live summary on %s', (event) => {
    const store = new SessionTranscriptStore();
    store.ingest({
      type: 'delta',
      kind: 'thinking',
      text: 'Checking tests',
      output_tokens: null,
      message_id: 'message_1',
    });
    if (event === 'session closed') store.ingest(closing);
    else if (event === 'session idle')
      store.ingest({
        type: 'session',
        session: { ...opening.session, status: 'idle' },
      });
    else if (event === 'error')
      store.ingest({ type: 'error', message: 'Disconnected' });
    else
      store.ingest({
        type: 'records',
        records: [
          lifecycle(1, event, {
            message_id: event === 'message_started' ? 'message_2' : 'message_1',
            ...(event === 'message_ended' ? { status: 'completed' } : {}),
          }),
        ],
      });
    expect(store.getSnapshot().liveSummary).toBe('');
  });

  it('does not preview reasoning once the session is closed', () => {
    const store = new SessionTranscriptStore();
    store.ingest(closing);
    store.ingest({
      type: 'delta',
      kind: 'thinking',
      text: 'Checking tests',
      output_tokens: null,
      message_id: 'message_1',
    });
    expect(store.getSnapshot().liveSummary).toBe('');
  });
});

describe('isConversationOver', () => {
  const session = (status: string): Session =>
    ({ status, error: null }) as unknown as Session;

  it('is over only once the session is closed, whatever its error', () => {
    for (const status of ['queued', 'preparing', 'running', 'idle'])
      expect(isConversationOver(session(status))).toBe(false);
    expect(isConversationOver(session('closed'))).toBe(true);
    expect(
      isConversationOver({
        ...session('closed'),
        error: { reason: 'stopped', detail: null },
      })
    ).toBe(true);
  });
});
