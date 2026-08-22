// The pure shaping layer: event -> transcript items, tool-run collapsing,
// pending-call inference, and cost folding. (The web and CLI renderers both
// draw from these; their platform tests cover colours/layout.)

import { describe, expect, it } from 'vitest';
import {
  collapseToolRuns,
  eventToItems,
  foldCosts,
  groupRecordsToChatTurns,
  oneLine,
  pendingToolCalls,
  recordToItems,
  summarizeToolInput,
  type CCEvent,
} from '../src/store';
import type { SessionRecord } from '../src/types';

const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    id: 'rec',
    agent_session_id: 's',
    agent_turn_id: null,
    feed_seq: 1,
    stream_seq: 1,
    source: 'claude_code',
    record_type: 'assistant',
    record_format: 'claude_stream_json@2.0',
    session_message_id: null,
    payload: {},
    tools: null,
    tokens_info: null,
    cost: null,
    duration: null,
    model: null,
    created_at: '2026-01-01T00:00:00+00:00',
    ...over,
  }) as SessionRecord;

describe('eventToItems', () => {
  it('shapes an assistant turn with text, thinking, and tool calls in order', () => {
    const event: CCEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          { type: 'text', text: 'Listing files.' },
        ],
      },
    };
    const items = eventToItems(event, 'k');
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'tool', 'assistant']);
    expect(items[1].detail).toBe('(ls -la)');
    expect(items[1].tool).toEqual({
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('renders system init only when the view opts in', () => {
    const init: CCEvent = { type: 'system', subtype: 'init', model: 'opus' };
    expect(eventToItems(init, 'k')).toEqual([]);
    const items = eventToItems(init, 'k', { systemInitLine: true });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('session started · opus');
    // Non-init system events (liveness ticks) never render either way.
    const tick: CCEvent = { type: 'system', subtype: 'output_tokens' };
    expect(eventToItems(tick, 'k', { systemInitLine: true })).toEqual([]);
  });

  it('caps a turn with the result summary (cost + whole-second duration)', () => {
    const items = eventToItems(
      { type: 'result', duration_ms: 201_700, total_cost_usd: 1.5 },
      'k'
    );
    expect(items[0].kind).toBe('summary');
    expect(items[0].text).toBe('turn complete · 3m 22s · $1.50');
  });
});

describe('recordToItems', () => {
  it('renders lifecycle records as a notice and ignores unknown sources', () => {
    const lifecycle = record({
      source: 'lifecycle',
      record_type: 'sandbox_ready',
      payload: { repositories: ['acme/app'], cache_tier: 'exact' },
    });
    expect(recordToItems(lifecycle, 'k')).toEqual([
      {
        key: 'k',
        kind: 'notice',
        text: 'Sandbox ready · acme/app · cached image',
        spaceBefore: true,
      },
    ]);
    expect(recordToItems(record({ source: 'martian_harness' }), 'k')).toEqual(
      []
    );
  });
});

describe('tool activity', () => {
  const tool = (key: string, name = 'Bash') => ({
    key,
    kind: 'tool' as const,
    text: name,
  });
  const result = (key: string) => ({
    key,
    kind: 'tool_result' as const,
    text: 'ok',
  });

  it('infers in-flight calls FIFO and resets on non-tool items', () => {
    expect(
      pendingToolCalls([tool('a'), result('a'), tool('b')]).map((i) => i.key)
    ).toEqual(['b']);
    expect(
      pendingToolCalls([
        tool('a'),
        { key: 'p', kind: 'assistant', text: 'prose' },
      ])
    ).toEqual([]);
  });

  it('collapses tool bursts into one summary line', () => {
    const items = collapseToolRuns([
      tool('a'),
      result('a'),
      tool('b'),
      result('b'),
      { key: 'p', kind: 'assistant', text: 'done' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['notice', 'assistant']);
    expect(items[0].text).toBe('Ran 2 shell commands');
  });
});

describe('cost folding (display-only, §6)', () => {
  it('reads the latest cumulative result and the last turn delta', () => {
    const events: CCEvent[] = [
      { type: 'result', total_cost_usd: 0.4 },
      { type: 'assistant' },
      { type: 'result', total_cost_usd: 1.0 },
    ];
    expect(foldCosts(events)).toEqual({ total: 1.0, lastStep: 0.6 });
    expect(foldCosts([])).toEqual({ total: null, lastStep: null });
  });
});

describe('summaries', () => {
  it('summarizes common tool inputs to their salient field', () => {
    expect(summarizeToolInput('Read', { file_path: '/tmp/x' })).toBe('/tmp/x');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe(
      'foo in src'
    );
    expect(summarizeToolInput('Unknown', {})).toBe('');
  });

  it('collapses whitespace and truncates one-liners', () => {
    expect(oneLine('a\n  b\tc', 10)).toBe('a b c');
    expect(oneLine('abcdefghij', 5)).toBe('ab...');
  });
});

describe('groupRecordsToChatTurns wake grouping', () => {
  const lifecycle = (
    id: string,
    recordType: string,
    payload: Record<string, unknown> = {}
  ) =>
    record({
      id,
      source: 'lifecycle',
      record_type: recordType,
      record_format: 'ellipsis_lifecycle@1',
      payload,
    });

  it('folds post-ready sandbox records across a session_resumed divider', () => {
    // The wake order: the spin-up card completes with sandbox_ready, then
    // session_resumed (a standalone divider), then restore/hook records.
    // Those must fold back into the SAME sandbox card — requiring the
    // immediately previous turn to be sandbox was the orphan-card bug.
    const turns = groupRecordsToChatTurns([
      lifecycle('r1', 'sandbox_starting', { repositories: ['o/r'] }),
      lifecycle('r2', 'sandbox_ready', { repositories: ['o/r'] }),
      lifecycle('r3', 'session_resumed', { wake_index: 1 }),
      lifecycle('r4', 'sandbox_phase', {
        phase: 'restore',
        status: 'completed',
        duration_ms: 2100,
      }),
      lifecycle('r5', 'sandbox_output', {
        phase: 'hooks',
        step: 'post_start',
        stream: 'stdout',
        chunk: 0,
        lines: ['hook line'],
      }),
    ]);
    // One sandbox card (starting+ready+restore+hook output) + the divider.
    expect(turns).toHaveLength(2);
    const [card, divider] = turns;
    expect(
      card.nodes.map((n) => (n.kind === 'lifecycle' ? n.recordType : n.kind))
    ).toEqual([
      'sandbox_starting',
      'sandbox_ready',
      'sandbox_phase',
      'sandbox_output',
    ]);
    expect(divider.nodes[0]).toMatchObject({
      kind: 'lifecycle',
      recordType: 'session_resumed',
    });
  });

  it('a new sandbox_starting begins a fresh card, never folds back', () => {
    const turns = groupRecordsToChatTurns([
      lifecycle('r1', 'sandbox_starting', { repositories: ['o/r'] }),
      lifecycle('r2', 'sandbox_ready', { repositories: ['o/r'] }),
      lifecycle('r3', 'session_idle'),
      lifecycle('r4', 'sandbox_starting', { repositories: ['o/r'] }),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[2].nodes[0]).toMatchObject({ recordType: 'sandbox_starting' });
  });
});
