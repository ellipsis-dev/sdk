// The pure shaping layer: record -> transcript items, tool-run collapsing,
// pending-call inference, and cost folding. (The web and CLI renderers both
// draw from these; their platform tests cover colours/layout.)

import { describe, expect, it } from 'vitest';
import {
  codexEventToItems,
  collapseToolRuns,
  eventToItems,
  foldCosts,
  groupRecordsToChatTurns,
  oneLine,
  pendingToolCalls,
  recordToItems,
  summarizeToolInput,
} from '../src/store';
import type {
  CodexEvent,
  SdkRecord,
  SdkResultRecord,
  SessionRecord,
} from '../src/types';

const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    id: 'rec',
    session_id: 's',
    agent_turn_id: null,
    feed_seq: 1,
    stream_seq: 1,
    source: 'claude_code',
    record_type: 'assistant',
    record_format: 'claude_sdk@1',
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

const assistant = (content: unknown): SdkRecord =>
  ({
    kind: 'assistant',
    content,
    model: 'opus',
    message_id: null,
    stop_reason: null,
    usage: null,
    cache_creation: null,
    parent_tool_use_id: null,
    session_id: null,
    uuid: null,
    error: null,
  }) as SdkRecord;

const result = (over: Partial<SdkResultRecord>): SdkRecord =>
  ({
    kind: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    duration_ms: 0,
    duration_api_ms: 0,
    session_id: null,
    stop_reason: null,
    cost_usd: null,
    usage: null,
    model_usage: null,
    result: null,
    structured_output: null,
    errors: null,
    api_error_status: null,
    uuid: null,
    ...over,
  }) as SdkRecord;

const system = (
  subtype: string,
  data: Record<string, unknown> = {}
): SdkRecord =>
  ({
    kind: 'system',
    subtype,
    data,
    session_id: null,
    uuid: null,
  }) as SdkRecord;

describe('eventToItems', () => {
  it('shapes an assistant turn with text, thinking, and tool calls in order', () => {
    const event = assistant([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
      { type: 'text', text: 'Listing files.' },
    ]);
    const items = eventToItems(event, 'k');
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'tool', 'assistant']);
    expect(items[1].detail).toBe('(ls -la)');
    expect(items[1].tool).toEqual({
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('renders system init only when the view opts in', () => {
    const init = system('init', { model: 'opus' });
    expect(eventToItems(init, 'k')).toEqual([]);
    const items = eventToItems(init, 'k', { systemInitLine: true });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('session started, opus');
    // Non-init system events (liveness ticks) never render either way.
    expect(
      eventToItems(system('output_tokens'), 'k', { systemInitLine: true })
    ).toEqual([]);
  });

  it('caps a turn with the result summary (cost + whole-second duration)', () => {
    const items = eventToItems(
      result({ duration_ms: 201_700, cost_usd: 1.5 }),
      'k'
    );
    expect(items[0].kind).toBe('summary');
    expect(items[0].text).toBe('turn complete, 3m 22s, $1.50');
  });
});

describe('codexEventToItems', () => {
  it('renders an agent message as assistant prose', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: 'pong' },
    } as CodexEvent;
    const items = codexEventToItems(event, 'k');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'pong' });
  });

  it('renders a command execution as a Bash call with its output', () => {
    const event: CodexEvent = {
      type: 'item.completed',
      item: {
        id: 'i1',
        type: 'command_execution',
        command: 'ls -la',
        aggregated_output: 'total 0',
        exit_code: 0,
      },
    } as CodexEvent;
    const items = codexEventToItems(event, 'k');
    expect(items.map((i) => i.kind)).toEqual(['tool', 'tool_result']);
    expect(items[0].text).toBe('Bash');
    expect(items[0].detail).toBe('(ls -la)');
    expect(items[1].text).toBe('total 0');
    expect(items[1].isError).toBe(false);
  });

  it('renders nothing for narrative events and progress items', () => {
    const silent: CodexEvent[] = [
      { type: 'thread.started', thread_id: 't' } as CodexEvent,
      { type: 'turn.started' } as CodexEvent,
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      } as CodexEvent,
      {
        type: 'item.started',
        item: { id: 'i', type: 'agent_message', text: 'partial' },
      } as CodexEvent,
      { type: 'some.future.event' } as CodexEvent,
    ];
    for (const event of silent) {
      expect(codexEventToItems(event, 'k')).toEqual([]);
    }
  });
});

describe('recordToItems', () => {
  it('renders lifecycle records as a notice', () => {
    const lifecycle = record({
      source: 'lifecycle',
      record_type: 'sandbox_ready',
      record_format: 'ellipsis_lifecycle@1',
      payload: { repositories: ['acme/app'], cache_tier: 'exact' },
    });
    expect(recordToItems(lifecycle, 'k')).toEqual([
      {
        key: 'k',
        kind: 'notice',
        text: 'Sandbox ready, acme/app, cached image',
        spaceBefore: true,
      },
    ]);
  });

  it('renders codex records through the codex mapper', () => {
    const codex = record({
      source: 'codex',
      record_type: 'agent_message',
      record_format: 'codex_jsonl@1',
      payload: {
        type: 'item.completed',
        item: { id: 'i1', type: 'agent_message', text: 'pong' },
      },
    });
    const items = recordToItems(codex, 'k');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'pong' });
  });
});

describe('tool activity', () => {
  const tool = (key: string, name = 'Bash') => ({
    key,
    kind: 'tool' as const,
    text: name,
  });
  const toolResult = (key: string) => ({
    key,
    kind: 'tool_result' as const,
    text: 'ok',
  });

  it('infers in-flight calls FIFO and resets on non-tool items', () => {
    expect(
      pendingToolCalls([tool('a'), toolResult('a'), tool('b')]).map(
        (i) => i.key
      )
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
      toolResult('a'),
      tool('b'),
      toolResult('b'),
      { key: 'p', kind: 'assistant', text: 'done' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['notice', 'assistant']);
    expect(items[0].text).toBe('Ran 2 shell commands');
  });
});

describe('cost folding (display-only, §6)', () => {
  it('sums per-turn result costs and reports the newest turn', () => {
    // A result's cost_usd is the TURN's own, so total is the sum.
    const events: SdkRecord[] = [
      result({ cost_usd: 0.4 }),
      assistant([]),
      result({ cost_usd: 0.6 }),
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

  it('groups codex records into turns closed by turn.completed', () => {
    const codex = (id: string, payload: Record<string, unknown>) =>
      record({
        id,
        source: 'codex',
        record_format: 'codex_jsonl@1',
        record_type: 'agent_message',
        payload: payload as CodexEvent,
      });
    const turns = groupRecordsToChatTurns([
      codex('c1', { type: 'thread.started', thread_id: 't' }),
      codex('c2', { type: 'turn.started' }),
      codex('c3', {
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'total 0',
          exit_code: 0,
        },
      }),
      codex('c4', {
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: 'done' },
      }),
      codex('c5', { type: 'turn.completed', usage: { input_tokens: 1 } }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].completedAt).not.toBeNull();
    expect(turns[0].nodes.map((n) => n.kind)).toEqual(['tool', 'assistant']);
    const bash = turns[0].nodes[0];
    expect(bash).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      result: 'total 0',
    });
  });
});
