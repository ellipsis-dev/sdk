// The connect-style layout: ChatTurns → flat items, fold placement, tails.

import { describe, expect, it } from 'vitest';
import {
  BRANCH_GLYPH,
  chatTurnsToItems,
  collapseToolRuns,
  foldGutter,
  groupRecordsToChatTurns,
  gutterFor,
  isToolActivity,
  layOutItems,
  tailLines,
  toolRunMembers,
  USER_BAR,
  type TranscriptItem,
} from '../src/store';
import type { SdkRecord, SessionRecord } from '../src/types';

let seq = 0;
const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    id: `rec${++seq}`,
    session_id: 's',
    agent_turn_id: null,
    feed_seq: seq,
    stream_seq: seq,
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

const user = (content: unknown): SdkRecord =>
  ({
    kind: 'user',
    content,
    parent_tool_use_id: null,
    session_id: null,
    uuid: null,
  }) as SdkRecord;

const lifecycle = (record_type: string, payload: Record<string, unknown>) =>
  record({
    source: 'lifecycle',
    record_type,
    record_format: 'ellipsis_lifecycle@1',
    payload,
  } as Partial<SessionRecord>);

const item = (over: Partial<TranscriptItem>): TranscriptItem => ({
  key: over.key ?? `i${++seq}`,
  kind: 'assistant',
  text: '',
  ...over,
});

describe('chatTurnsToItems', () => {
  it('pairs a tool call with its result and marks a failed turn', () => {
    const records = [
      record({ payload: user('do it') }),
      record({
        payload: assistant([
          { type: 'text', text: 'On it.' },
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ]),
      }),
      record({
        payload: user([
          { type: 'tool_result', tool_use_id: 't1', content: 'a\nb' },
        ]),
      }),
      record({
        payload: {
          kind: 'result',
          subtype: 'error',
          is_error: true,
          duration_ms: 10,
        } as SdkRecord,
      }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool_result',
      'summary',
    ]);
    expect(items[2].detail).toBe('(ls)');
    expect(items[3].gutter).toBe(BRANCH_GLYPH);
    expect(items[3].key).toBe(`${items[2].key}:r`);
    expect(items[4].isError).toBe(true);
  });

  it('drops the sandbox story and settles a wake in place', () => {
    const records = [
      lifecycle('sandbox_ready', { phase_timings: { image: 4.5 } }),
      lifecycle('session_idle', {}),
      lifecycle('session_starting', { wake_index: 1 }),
      lifecycle('session_resumed', {}),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => i.text)).toEqual([
      'Session asleep',
      'Session awake',
    ]);
    expect(items[1].loading).toBeUndefined();
    // The wake line typed its dots, and kept its key when it settled.
    const waking = chatTurnsToItems(
      groupRecordsToChatTurns(records.slice(0, 3))
    );
    expect(waking[1].text).toBe('Session waking');
    expect(waking[1].loading).toBe(true);
    expect(waking[1].key).toBe(items[1].key);
  });

  it('settles a wake the agent answered even without a resumed record', () => {
    // A degraded wake (transcript lost) emits no session_resumed; the agent
    // answering is proof enough that it is awake.
    const records = [
      lifecycle('session_idle', {}),
      lifecycle('session_starting', { attempt: 0, wake_index: 1 }),
      record({ payload: assistant([{ type: 'text', text: 'Back.' }]) }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['notice', 'Session asleep'],
      ['notice', 'Session awake'],
      ['assistant', 'Back.'],
    ]);
    expect(items[1].loading).toBeUndefined();
  });

  it('draws your message where you sent it, above the wake it caused', () => {
    // The real record order of a send into an asleep session: the inbox
    // takes the message, the sandbox wakes, the agent echoes the message.
    const records = [
      lifecycle('session_idle', {}),
      lifecycle('message_received', { message_id: 'smsg_1', body: 'yo' }),
      lifecycle('session_starting', { attempt: 0, wake_index: 1 }),
      lifecycle('sandbox_starting', { repositories: [] }),
      lifecycle('sandbox_ready', { phase_timings: { image: 2.6 } }),
      lifecycle('session_resumed', { wake_index: 1 }),
      lifecycle('message_delivered', { message_id: 'smsg_1', turn_id: 't1' }),
      record({ payload: user('yo'), session_message_id: 'smsg_1' }),
      record({ payload: assistant([{ type: 'text', text: 'Yo!' }]) }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['notice', 'Session asleep'],
      ['user', 'yo'],
      ['notice', 'Session awake'],
      ['assistant', 'Yo!'],
    ]);
    // Mid-wake: the message is up, the wake line is typing.
    const midWake = chatTurnsToItems(
      groupRecordsToChatTurns(records.slice(0, 4))
    );
    expect(midWake.map((i) => i.text)).toEqual([
      'Session asleep',
      'yo',
      'Session waking',
    ]);
    expect(midWake[2].loading).toBe(true);
  });

  it('still draws an echo that no message_received preceded', () => {
    const items = chatTurnsToItems(
      groupRecordsToChatTurns([record({ payload: user('hi') })])
    );
    expect(items.map((i) => [i.kind, i.text])).toEqual([['user', 'hi']]);
  });

  it('marks a message cancelled when the turn that took it failed', () => {
    const records = [
      lifecycle('message_received', { message_id: 'smsg_1', body: 'go' }),
      lifecycle('message_delivered', { message_id: 'smsg_1', turn_id: 't1' }),
      lifecycle('turn_failed', { turn_id: 't1' }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'go', isError: true });
  });
});

describe('layOutItems', () => {
  it('lays every row out flat, tool runs included', () => {
    const items = collapseToolRuns([
      item({ kind: 'user', text: 'hi' }),
      item({ kind: 'tool', text: 'Bash' }),
      item({ kind: 'tool_result', text: 'ok' }),
      item({ kind: 'assistant', text: 'looking' }),
      item({ kind: 'thinking', text: 'hmm' }),
      item({ kind: 'tool', text: 'Read' }),
      item({ kind: 'tool_result', text: 'ok' }),
      item({ kind: 'assistant', text: 'done' }),
    ]);
    const placed = layOutItems(items);
    expect(placed.map((p) => [p.item.kind, p.nested, p.attach])).toEqual([
      ['user', false, false],
      ['notice', false, false],
      ['assistant', false, false],
      ['notice', false, false],
      ['assistant', false, false],
    ]);
    expect(placed[1].item.text).toBe('Ran 1 shell command');
    expect(placed[3].item.text).toBe('Read 1 file');
    expect(foldGutter(placed[1].nested)).toBe('●');
    expect(foldGutter(placed[3].nested)).toBe('●');
  });

  it('folds thinking into the run and labels a thinking-only run', () => {
    const items = collapseToolRuns([
      item({ kind: 'assistant', text: 'a' }),
      item({ kind: 'thinking', text: 'hmm' }),
      item({ kind: 'thinking', text: 'hmm again' }),
      item({ kind: 'assistant', text: 'b' }),
      item({ kind: 'thinking', text: 'hmm' }),
      item({ kind: 'tool', text: 'Bash' }),
      item({ kind: 'tool_result', text: 'ok' }),
      item({ kind: 'thinking', text: 'hmm' }),
    ]);
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['assistant', 'a'],
      ['thinking', 'Thinking…'],
      ['assistant', 'b'],
      ['notice', 'Ran 1 shell command'],
    ]);
  });
});

// One test per fold shape a reader can meet: the label and whether the dots
// are typing. `loading` is absent (not false) on a settled fold.
describe('fold scenarios', () => {
  const tool = (name: string, key = name) =>
    item({ key, kind: 'tool', text: name });
  const result = (key: string) =>
    item({ key: `${key}:r`, kind: 'tool_result', text: 'ok' });
  const think = (key = 'th') => item({ key, kind: 'thinking', text: 'hmm' });
  const call = (name: string, key = name) => [tool(name, key), result(key)];
  const fold = (items: ReturnType<typeof item>[], working = false) => {
    const out = collapseToolRuns(items, { working });
    expect(out).toHaveLength(1);
    return { text: out[0].text, loading: out[0].loading };
  };

  it('1. thinking only, settled', () => {
    expect(fold([think('a'), think('b')])).toEqual({
      text: 'Thinking…',
      loading: undefined,
    });
  });

  it('2. trailing thinking while the turn works', () => {
    expect(fold([think()], true)).toEqual({ text: 'Thinking', loading: true });
  });

  it('3. Bash ×3 with thinking between', () => {
    expect(
      fold([
        ...call('Bash', 'b1'),
        think(),
        ...call('Bash', 'b2'),
        ...call('Bash', 'b3'),
      ])
    ).toEqual({ text: 'Ran 3 shell commands', loading: undefined });
  });

  it('4. Read ×2', () => {
    expect(fold([...call('Read', 'r1'), ...call('Read', 'r2')])).toEqual({
      text: 'Read 2 files',
      loading: undefined,
    });
  });

  it('5. one other tool', () => {
    expect(fold(call('WebFetch'))).toEqual({
      text: 'Ran WebFetch',
      loading: undefined,
    });
  });

  it('6. one other tool, repeated', () => {
    expect(
      fold([
        ...call('WebFetch', 'w1'),
        ...call('WebFetch', 'w2'),
        ...call('WebFetch', 'w3'),
      ])
    ).toEqual({ text: 'Ran WebFetch 3 times', loading: undefined });
  });

  it('7. mixed tools', () => {
    expect(
      fold([
        ...call('Grep'),
        ...call('Bash', 'b1'),
        ...call('Bash', 'b2'),
        ...call('Read'),
      ])
    ).toEqual({
      text: 'Ran 4 tool calls (Grep, Bash, Read)',
      loading: undefined,
    });
  });

  it('8. a call still running counts and types the dots', () => {
    expect(fold([...call('Bash', 'b1'), tool('Bash', 'b2')])).toEqual({
      text: 'Ran 2 shell commands',
      loading: true,
    });
  });

  it('9. an orphan result with no call seen', () => {
    expect(fold([result('x')])).toEqual({
      text: 'Ran 1 tool call',
      loading: undefined,
    });
  });

  it('a settled thinking-only fold mid-transcript never loads', () => {
    const out = collapseToolRuns(
      [think(), item({ kind: 'assistant', text: 'a' })],
      { working: true }
    );
    expect(out[0]).toMatchObject({ text: 'Thinking…' });
    expect(out[0].loading).toBeUndefined();
  });
});

describe('classification', () => {
  it('classifies items', () => {
    expect(isToolActivity(item({ key: 'grp:x', kind: 'notice' }))).toBe(true);
    expect(isToolActivity(item({ kind: 'notice' }))).toBe(false);
    expect(gutterFor(item({ kind: 'user' }))).toBe(USER_BAR);
    expect(gutterFor(item({ kind: 'notice' }))).toBe('✦');
    expect(gutterFor(item({ kind: 'tool_result', gutter: '⎿' }))).toBe('⎿');
  });
});

describe('tailLines', () => {
  it('keeps the newest lines and counts what scrolled past', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toEqual({ body: 'c\nd', hidden: 2 });
    expect(tailLines('a\nb', 6)).toEqual({ body: 'a\nb', hidden: 0 });
  });
});

describe('toolRunMembers', () => {
  it('keys each run by the fold collapseToolRuns emits for it', () => {
    const items = [
      item({ kind: 'assistant', text: 'a' }),
      item({ key: 'th', kind: 'thinking', text: 'hmm' }),
      item({ key: 't1', kind: 'tool', text: 'Bash' }),
      item({ key: 't1:r', kind: 'tool_result', text: 'ok' }),
      item({ kind: 'assistant', text: 'b' }),
      item({ key: 't2', kind: 'tool', text: 'Read' }),
    ];
    const folds = collapseToolRuns(items).filter((i) =>
      i.key.startsWith('grp:')
    );
    const members = toolRunMembers(items);
    expect([...members.keys()]).toEqual(folds.map((f) => f.key));
    expect(members.get('grp:th')!.map((i) => i.key)).toEqual([
      'th',
      't1',
      't1:r',
    ]);
  });
});
