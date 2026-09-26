import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../src/types';
import {
  entryBody,
  entrySeconds,
  groupRecordsToChatTurns,
  splitLedger,
} from '../src/store';

const epoch = Date.parse('2026-09-11T18:56:58.250Z');
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const record = (
  seconds: number,
  recordType: string,
  payload: Record<string, unknown>,
  native = false,
  turnId: string | null = null
): SessionRecord =>
  ({
    id: `r:${seconds}`,
    session_id: 'session',
    turn_id: turnId,
    session_message_id: null,
    feed_seq: seconds * 1000,
    source: native ? 'codex' : 'lifecycle',
    kind: native ? 'codex_app_server' : 'platform',
    record_type: recordType,
    record_format: native ? 'codex_app_server@1' : 'ellipsis_lifecycle@1',
    created_at: at(seconds),
    payload,
    tools: null,
    tokens_info: null,
    cost: null,
    duration: null,
    model: null,
  }) as SessionRecord;
const native = (
  seconds: number,
  method: string,
  params: Record<string, unknown> = {},
  turnId = 'turn'
) => record(seconds, method, { method, params }, true, turnId);
// A message gets its turn the moment it is received.
const received = (seconds: number, id = 'message', turnId = 'turn') =>
  record(
    seconds,
    'message_received',
    { message_id: id, body: 'propose options', turn_id: turnId },
    false,
    turnId
  );
// Environment records carry the turn they prepare for.
const environment = (
  seconds: number,
  recordType: string,
  payload: Record<string, unknown>,
  turnId = 'turn'
) => record(seconds, recordType, payload, false, turnId);
const started = (seconds: number, id = 'turn') =>
  record(seconds, 'turn_started', { turn_id: id, turn_index: 1 }, false, id);
const delivered = (seconds: number, messageId = 'message', turnId = 'turn') =>
  record(seconds, 'message_delivered', {
    message_id: messageId,
    turn_id: turnId,
  });
const ended = (
  seconds: number,
  id = 'turn',
  status = 'completed',
  detail: string | null = null
) =>
  record(
    seconds,
    'turn_ended',
    { turn_id: id, turn_index: 1, status, reason: null, detail },
    false,
    id
  );
const entries = (records: SessionRecord[]) =>
  splitLedger(groupRecordsToChatTurns(records)).entries;
const body = (records: SessionRecord[], now: number, live = true) =>
  entryBody(entries(records).at(-1)!, { live, now: epoch + now * 1000 });

// Relative timings from a production cold start: the environment is ready 4s
// after the message lands and the platform turn starts right after; native
// start follows by 2.1s, and the first displayable item arrives almost 10s
// after that.
const cold = [
  received(0),
  environment(1.481, 'environment_phase', {
    phase: 'restore',
    status: 'started',
  }),
  environment(5.501, 'environment_ready', {
    repositories: [],
    duration_ms: 4020,
  }),
  started(5.526),
  delivered(5.546),
  native(7.289, 'configWarning', { summary: 'configuration warning' }),
  native(7.65, 'turn/started', {
    turn: { id: 'native-turn', status: 'inProgress', items: [] },
  }),
  native(15.391, 'item/completed', {
    item: {
      id: 'thought',
      type: 'reasoning',
      summary: ['Considering options'],
      content: [],
    },
  }),
  native(31.346, 'item/completed', {
    item: {
      id: 'answer',
      type: 'agentMessage',
      text: 'Here are the options.',
      phase: 'final_answer',
    },
  }),
  native(31.44, 'turn/completed', {
    turn: { id: 'native-turn', status: 'completed', items: [] },
  }),
  ended(31.475),
];

describe('message progress from lifecycle and native records', () => {
  it('keeps one stable work row through preparation, startup, work and replay', () => {
    const phases = [
      [2, 'Preparing environment'],
      [3, 'Starting agent'],
      [6, 'Starting agent'],
      [7, 'Working'],
      [8, 'Working'],
    ] as const;
    for (const [length, label] of phases) {
      const result = body(cold.slice(0, length), 20);
      expect(result.items.map((item) => item.text)).toEqual(
        length === 8 ? [label, 'Considering options'] : [label]
      );
      expect(result.items[0]).toMatchObject({
        key: 'work:msg:message',
        loading: true,
      });
      expect(
        [...result.members.values()].flat().some((item) => item.loading)
      ).toBe(false);
    }
    expect(body(cold.slice(0, 2), 2).seconds).toBeNull();
    expect(body(cold.slice(0, 6), 8).seconds).toBeCloseTo(2.474);
    // The clock advances even though nothing can render yet.
    expect(body(cold.slice(0, 7), 11.75).seconds).toBeCloseTo(6.224);
    expect(body(cold.slice(0, 8), 20).seconds).toBeCloseTo(14.474);
    const settled = body(cold, 100, false);
    expect(settled.items.map((item) => item.text)).toEqual([
      'Worked for 26s',
      'Here are the options.',
    ]);
    expect(settled.seconds).toBeCloseTo(25.949);
    expect(settled.items[0].key).toBe('work:msg:message');
    expect(body(cold, 200, false)).toEqual(settled);
    // A late session status frame cannot revive a completed turn.
    expect(body(cold, 200).items.some((item) => item.loading)).toBe(false);
  });

  it('starts a warm follow-up immediately and times only its own turn', () => {
    const records = [
      ...cold,
      received(40, 'followup', 'turn2'),
      started(41, 'turn2'),
      delivered(41.1, 'followup', 'turn2'),
      native(41.2, 'turn/started', {}, 'turn2'),
    ];
    const [first, second] = entries(records);
    expect(first.progress?.phase).toBeNull();
    expect(second.progress?.phase).toBe('working');
    expect(entrySeconds(first, epoch + 45000)).toBeCloseTo(25.949);
    expect(entrySeconds(second, epoch + 45000)).toBe(4);
    expect(body(records, 45).items.map((item) => item.text)).toEqual([
      'Working',
    ]);
  });

  it('advances without an environment_ready record', () => {
    const records = cold.filter((r) => r.record_type !== 'environment_ready');
    expect(body(records.slice(0, 4), 6).items[0].text).toBe('Starting agent');
    expect(body(records.slice(0, 6), 10).items[0].text).toBe('Working');
  });

  it('stops a failed turn clock before any native content arrives', () => {
    const records = [
      ...cold.slice(0, 5),
      ended(9, 'turn', 'failed', 'The agent exited unexpectedly.'),
    ];
    const result = body(records, 100);
    expect(result.items.some((item) => item.loading)).toBe(false);
    expect(result.seconds).toBeCloseTo(3.474);
    expect(result.items.at(-1)?.text).toBe('The agent exited unexpectedly.');
    expect(entries(records)[0].cancelled).toBe(true);
  });

  it('keeps a cancellation before the turn started visible and stops the clock', () => {
    const records = [
      ...cold.slice(0, 2),
      ended(3, 'turn', 'cancelled', 'Budget exhausted'),
    ];
    const result = body(records, 10);
    expect(result.items.some((item) => item.loading)).toBe(false);
    expect(result.items.at(-1)?.text).toBe('Budget exhausted');
    expect(result.seconds).toBeNull();
    expect(entries(records)[0].cancelled).toBe(true);
  });

  it('keeps a queued message separate from the currently running turn', () => {
    const records = [...cold.slice(0, 7), received(10, 'followup', 'turn2')];
    const [first, second] = entries(records);
    expect(first.progress?.phase).toBe('working');
    expect(second.progress?.phase).toBe('queued');
    expect(body(records, 11).seconds).toBeNull();
  });

  it('binds an initial turn that starts before its message is recorded', () => {
    const records = [started(0), received(0.1), delivered(0.2)];
    expect(body(records, 4).items[0].text).toBe('Starting agent');
    expect(body(records, 4).seconds).toBe(4);
  });

  it('uses Claude initialization for readiness and platform events for time', () => {
    const init: SessionRecord = {
      ...native(6, 'init'),
      kind: 'claude_code',
      source: 'claude_code',
      record_format: 'claude_jsonl@1',
      record_type: 'system',
      payload: {
        type: 'system',
        subtype: 'init',
        session_id: 'claude',
        uuid: 'init',
      },
    };
    const records = [...cold.slice(0, 5), init];
    expect(body(records, 10).items[0].text).toBe('Working');
    expect(body(records, 10).seconds).toBeCloseTo(4.474);
    records.push(ended(11));
    expect(body(records, 100, false).seconds).toBeCloseTo(5.474);
  });

  it('resumes a requeued message and retains each attempt duration once', () => {
    const records = [
      ...cold.slice(0, 5),
      ended(9, 'turn', 'failed'),
      record(9.1, 'message_requeued', {
        message_id: 'message',
        turn_id: 'turn',
        requeued_turn_id: 'retry',
      }),
      environment(
        10,
        'environment_phase',
        { phase: 'restore', status: 'started' },
        'retry'
      ),
    ];
    expect(body(records, 10).items[0].text).toBe('Preparing environment');
    records.push(
      started(11, 'retry'),
      delivered(11.1, 'message', 'retry'),
      native(12, 'turn/started', {}, 'retry')
    );
    expect(body(records, 15).items[0].text).toBe('Working');
    expect(body(records, 15).seconds).toBeCloseTo(7.474);
    expect(entries(records)[0].cancelled).toBe(false);
  });
});
