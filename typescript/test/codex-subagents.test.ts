// In-process Codex subagents run as extra threads of the same app-server and
// stream into the parent session's records.

import { describe, expect, it } from 'vitest';
import { codexSubagentThreads, groupRecordsToChatTurns } from '../src/store';
import type { SessionRecord } from '../src/types';

const PARENT = 'parent-thread';
const CHILD = 'child-thread';

let seq = 0;
const native = (payload: unknown): SessionRecord =>
  ({
    id: `rec${++seq}`,
    session_id: 's',
    message_id: 'turn',
    feed_seq: seq,
    source: 'codex',
    record_type: (payload as { method: string }).method,
    record_format: 'codex_app_server@1',
    kind: 'codex_app_server',
    payload,
    tools: null,
    tokens_info: null,
    cost: null,
    duration: null,
    model: null,
    created_at: '2026-01-01T00:00:00+00:00',
  }) as SessionRecord;

const item = (threadId: string, value: Record<string, unknown>) =>
  native({
    method: 'item/completed',
    params: { threadId, turnId: `${threadId}-turn`, item: value },
  });

const ended = (threadId: string) =>
  native({
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: `${threadId}-turn`,
        status: 'completed',
        items: [],
        error: null,
      },
    },
  });

const spawn = item(PARENT, {
  type: 'subAgentActivity',
  id: 'call_spawn',
  kind: 'started',
  agentThreadId: CHILD,
  agentPath: '/root/fruit',
});

describe('codex subagents', () => {
  it('finds the threads a spawn announces', () => {
    expect(codexSubagentThreads([spawn])).toEqual(new Set([CHILD]));
  });

  it('keeps the parent turn open when a subagent turn ends', () => {
    const turns = groupRecordsToChatTurns([
      spawn,
      item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' }),
      ended(CHILD),
      item(PARENT, { type: 'agentMessage', id: 'p', text: 'done' }),
      ended(PARENT),
    ]).filter((turn) => turn.role !== 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0].completedAt).toBeDefined();
    expect(
      turns[0].nodes.map((node) => ('text' in node ? node.text : node.kind))
    ).toContain('done');
  });

  it('keeps a background subagent in the parent turn after it ends', () => {
    const turns = groupRecordsToChatTurns([
      spawn,
      item(PARENT, { type: 'agentMessage', id: 'p', text: 'started it' }),
      ended(PARENT),
      item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' }),
      ended(CHILD),
      item(PARENT, {
        type: 'subAgentActivity',
        id: 'call_done',
        kind: 'completed',
        agentThreadId: CHILD,
        agentPath: '/root/fruit',
      }),
    ]).filter((turn) => turn.role !== 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0].completedAt).not.toBeNull();
    expect(
      turns[0].nodes.map((node) => ('text' in node ? node.text : node.kind))
    ).toEqual(['tool', 'started it', 'pineapple', 'tool']);
  });

  it('keeps a subagent error off the parent turn', () => {
    const turns = groupRecordsToChatTurns([
      spawn,
      native({
        method: 'error',
        params: {
          threadId: CHILD,
          turnId: `${CHILD}-turn`,
          willRetry: false,
          error: { message: 'child failed' },
        },
      }),
      ended(CHILD),
      item(PARENT, { type: 'agentMessage', id: 'p', text: 'done' }),
      ended(PARENT),
    ]).filter((turn) => turn.role !== 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0].isError).toBe(false);
  });

  it('keeps a nested subagent off the parent turn', () => {
    const GRANDCHILD = 'grandchild-thread';
    const turns = groupRecordsToChatTurns([
      spawn,
      item(CHILD, {
        type: 'subAgentActivity',
        id: 'call_nested',
        kind: 'started',
        agentThreadId: GRANDCHILD,
        agentPath: '/root/fruit/seed',
      }),
      native({
        method: 'error',
        params: {
          threadId: GRANDCHILD,
          turnId: `${GRANDCHILD}-turn`,
          willRetry: false,
          error: { message: 'nested failed' },
        },
      }),
      ended(GRANDCHILD),
      item(PARENT, { type: 'agentMessage', id: 'p', text: 'done' }),
      ended(PARENT),
    ]).filter((turn) => turn.role !== 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0].isError).toBe(false);
    expect(
      turns[0].nodes.map((node) => ('text' in node ? node.text : node.kind))
    ).toContain('done');
  });

  it('keeps a late subagent record in its own turn after the next one opens', () => {
    const later = (value: SessionRecord): SessionRecord => ({
      ...value,
      message_id: 'turn2',
    });
    const turns = groupRecordsToChatTurns([
      spawn,
      ended(PARENT),
      later(item(PARENT, { type: 'agentMessage', id: 'n', text: 'next' })),
      item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' }),
      later(item(PARENT, { type: 'agentMessage', id: 'm', text: 'more' })),
      later(ended(PARENT)),
    ]).filter((turn) => turn.role !== 'user');
    expect(
      turns.map((turn) =>
        turn.nodes.map((node) => ('text' in node ? node.text : node.kind))
      )
    ).toEqual([
      ['tool', 'pineapple'],
      ['next', 'more'],
    ]);
    expect(turns.every((turn) => turn.completedAt !== null)).toBe(true);
  });

  it('opens a new turn when a turn starts by spawning', () => {
    const turns = groupRecordsToChatTurns([
      item(PARENT, { type: 'agentMessage', id: 'a', text: 'first' }),
      ended(PARENT),
      spawn,
      item(PARENT, { type: 'agentMessage', id: 'b', text: 'second' }),
      ended(PARENT),
    ]).filter((turn) => turn.role !== 'user');
    expect(
      turns.map((turn) =>
        turn.nodes.map((node) => ('text' in node ? node.text : node.kind))
      )
    ).toEqual([['first'], ['tool', 'second']]);
  });

  it('keeps an unmatched late subagent record in the open turn', () => {
    const later = (value: SessionRecord): SessionRecord => ({
      ...value,
      message_id: 'turn2',
    });
    const turns = groupRecordsToChatTurns([
      spawn,
      ended(PARENT),
      later(item(PARENT, { type: 'agentMessage', id: 'n', text: 'next' })),
      {
        ...item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' }),
        message_id: null,
      },
      later(item(PARENT, { type: 'agentMessage', id: 'm', text: 'more' })),
      later(ended(PARENT)),
    ]).filter((turn) => turn.role !== 'user');
    expect(
      turns.map((turn) =>
        turn.nodes.map((node) => ('text' in node ? node.text : node.kind))
      )
    ).toEqual([['tool'], ['next', 'pineapple', 'more']]);
    expect(turns.every((turn) => turn.completedAt !== null)).toBe(true);
  });

  it('opens the next turn for a subagent record stamped with it', () => {
    const later = (value: SessionRecord): SessionRecord => ({
      ...value,
      message_id: 'turn2',
    });
    const turns = groupRecordsToChatTurns([
      spawn,
      ended(PARENT),
      later(item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' })),
      later(
        item(PARENT, {
          type: 'subAgentActivity',
          id: 'call_done',
          kind: 'completed',
          agentThreadId: CHILD,
          agentPath: '/root/fruit',
        })
      ),
      later(item(PARENT, { type: 'agentMessage', id: 's', text: 'second' })),
      later(ended(PARENT)),
    ]).filter((turn) => turn.role !== 'user');
    expect(
      turns.map((turn) => [
        turn.messageId,
        turn.nodes.map((node) => ('text' in node ? node.text : node.kind)),
      ])
    ).toEqual([
      ['turn', ['tool']],
      ['turn2', ['pineapple', 'tool', 'second']],
    ]);
    expect(turns.every((turn) => turn.completedAt !== null)).toBe(true);
  });

  it('opens the stamped turn when the previous one never ended', () => {
    const turns = groupRecordsToChatTurns([
      spawn,
      {
        ...item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' }),
        message_id: 'turn2',
      },
    ]).filter((turn) => turn.role !== 'user');
    expect(turns.map((turn) => turn.messageId)).toEqual(['turn', 'turn2']);
  });

  it('puts an unstamped late record in the open turn, not an older one', () => {
    const unstamped = (value: SessionRecord): SessionRecord => ({
      ...value,
      message_id: null,
    });
    const turns = groupRecordsToChatTurns([
      unstamped(item(PARENT, { type: 'agentMessage', id: 'a', text: 'first' })),
      unstamped(spawn),
      unstamped(ended(PARENT)),
      item(PARENT, { type: 'agentMessage', id: 'b', text: 'second' }),
      unstamped(
        item(CHILD, { type: 'agentMessage', id: 'c', text: 'pineapple' })
      ),
      ended(PARENT),
    ]).filter((turn) => turn.role !== 'user');
    expect(
      turns.map((turn) =>
        turn.nodes.map((node) => ('text' in node ? node.text : node.kind))
      )
    ).toEqual([
      ['first', 'tool'],
      ['second', 'pineapple'],
    ]);
  });
});
