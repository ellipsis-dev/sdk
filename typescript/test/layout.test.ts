// The connect-style layout: ChatTurns → flat items, fold placement, tails.

import { describe, expect, it } from 'vitest';
import {
  BRANCH_GLYPH,
  chatTurnsToItems,
  collapseToolRuns,
  entryBody,
  foldGutter,
  groupRecordsToChatTurns,
  gutterFor,
  isToolActivity,
  layOutItems,
  splitLedger,
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
    feed_seq: seq,
    source: 'claude_code',
    record_type: 'assistant',
    record_format: 'claude_sdk@1',
    message_id: null,
    payload: {},
    tools: null,
    tokens_info: null,
    cost: null,
    duration: null,
    model: null,
    created_at: '2026-01-01T00:00:00+00:00',
    kind:
      over.record_format === 'ellipsis_lifecycle@1'
        ? 'platform'
        : over.record_format === 'codex_jsonl@1'
          ? 'codex'
          : over.record_format === 'claude_jsonl@1'
            ? 'claude_code'
            : 'claude_sdk',
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

const lifecycle = (
  record_type: string,
  payload: Record<string, unknown>,
  message_id: string | null = null
) =>
  record({
    source: 'lifecycle',
    record_type,
    record_format: 'ellipsis_lifecycle@1',
    payload,
    message_id,
  } as Partial<SessionRecord>);

const item = (over: Partial<TranscriptItem>): TranscriptItem => ({
  key: over.key ?? `i${++seq}`,
  kind: 'assistant',
  text: '',
  ...over,
});

describe('chatTurnsToItems', () => {
  it.each([
    [
      'Claude SDK',
      record({ payload: assistant([{ type: 'text', text: 'Hello' }]) }),
    ],
    [
      'Claude JSONL',
      record({
        kind: 'claude_code',
        record_format: 'claude_jsonl@1',
        payload: {
          type: 'assistant',
          message: {
            type: 'message',
            role: 'assistant',
            model: 'opus',
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      }),
    ],
    [
      'Codex JSONL',
      record({
        kind: 'codex',
        record_format: 'codex_jsonl@1',
        payload: {
          type: 'item.completed',
          item: { type: 'agent_message', id: 'a', text: 'Hello' },
        },
      }),
    ],
    [
      'Codex app server',
      record({
        kind: 'codex_app_server',
        record_format: 'codex_app_server@1',
        payload: {
          method: 'item/completed',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: { type: 'agentMessage', id: 'a', text: 'Hello' },
          },
        },
      }),
    ],
  ] as const)(
    'preserves %s messages and times through active and settled chat',
    (_, reply) => {
      const sentAt = '2026-01-01T10:00:00Z';
      const firstReplyAt = '2026-01-01T10:00:20Z';
      const secondReplyAt = '2026-01-01T10:00:45Z';
      const received = lifecycle(
        'message',
        { id: 'm1', index: 0, body: 'Hi' },
        'm1'
      );
      const turns = groupRecordsToChatTurns([
        { ...received, created_at: sentAt },
        lifecycle('message_started', { message_id: 'm1' }, 'm1'),
        record({
          payload: user('Hi'),
          message_id: 'm1',
          created_at: '2026-01-01T10:00:10Z',
        }),
        { ...reply, id: 'first', message_id: 'm1', created_at: firstReplyAt },
        { ...reply, id: 'second', message_id: 'm1', created_at: secondReplyAt },
      ]);
      const { entries } = splitLedger(turns);
      expect(entries).toHaveLength(1);
      expect(entries[0].createdAt).toBe(sentAt);
      expect(
        chatTurnsToItems(turns).find((item) => item.kind === 'user')?.createdAt
      ).toBe(sentAt);
      const activeBody = entryBody(entries[0], {
        live: true,
        now: Date.parse(secondReplyAt),
        liveText: 'Still working',
      });
      expect(
        activeBody.items
          .filter((item) => item.kind === 'assistant')
          .map((item) => item.text)
      ).toEqual(['Hello', 'Hello', 'Still working']);
      const body = entryBody(entries[0], {
        live: false,
        now: Date.parse(secondReplyAt),
      });
      expect(
        body.items
          .flatMap((item) => body.members.get(item.key) ?? [item])
          .filter((item) => item.kind === 'assistant')
          .map((item) => item.createdAt)
      ).toEqual([firstReplyAt, secondReplyAt]);
    }
  );

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

  it('drops the environment story and logs the session closing', () => {
    const records = [
      lifecycle(
        'environment_phase',
        { phase: 'image', status: 'started' },
        'm0'
      ),
      lifecycle(
        'environment_ready',
        { repositories: [], duration_ms: 4500 },
        'm0'
      ),
      record({ payload: assistant([{ type: 'text', text: 'Hi.' }]) }),
      lifecycle(
        'message_ended',
        { message_id: 'm0', status: 'completed' },
        'm0'
      ),
      lifecycle('session_closed', {}),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['assistant', 'Hi.'],
      ['notice', 'Session closed'],
    ]);
  });

  it('renders old record types as nothing', () => {
    const records = [
      lifecycle('session_idle', {}),
      lifecycle('session_starting', { attempt: 0, wake_index: 1 }),
      lifecycle('sandbox_ready', { phase_timings: { image: 2.6 } }),
      record({ payload: assistant([{ type: 'text', text: 'Back.' }]) }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['assistant', 'Back.'],
    ]);
  });

  it('draws your message where you sent it, above the environment prepared for it', () => {
    // The real record order of a send into a cold conversation: the inbox
    // takes the message, the environment comes up, the agent echoes the
    // message.
    const records = [
      lifecycle('message', { id: 'smsg_1', index: 1, body: 'yo' }, 'smsg_1'),
      lifecycle(
        'environment_phase',
        { phase: 'restore', status: 'started' },
        'smsg_1'
      ),
      lifecycle(
        'environment_ready',
        { repositories: [], duration_ms: 2600 },
        'smsg_1'
      ),
      lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
      record({ payload: user('yo'), message_id: 'smsg_1' }),
      record({
        payload: assistant([{ type: 'text', text: 'Yo!' }]),
        message_id: 'smsg_1',
      }),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'yo'],
      ['assistant', 'Yo!'],
    ]);
    // Mid-preparation: the message is up, nothing else is.
    const preparing = chatTurnsToItems(
      groupRecordsToChatTurns(records.slice(0, 2))
    );
    expect(preparing.map((i) => [i.kind, i.text])).toEqual([['user', 'yo']]);
  });

  it('still draws an echo that no message record preceded', () => {
    const items = chatTurnsToItems(
      groupRecordsToChatTurns([record({ payload: user('hi') })])
    );
    expect(items.map((i) => [i.kind, i.text])).toEqual([['user', 'hi']]);
  });

  it('marks a message cancelled when answering it failed, and says why', () => {
    const records = [
      lifecycle('message', { id: 'smsg_1', index: 0, body: 'go' }, 'smsg_1'),
      lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
      lifecycle(
        'message_ended',
        {
          message_id: 'smsg_1',
          status: 'failed',
          error: {
            reason: 'missing_repo_access',
            detail: 'The agent cannot reach acme/app.',
          },
        },
        'smsg_1'
      ),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'go'],
      ['notice', 'The agent cannot reach acme/app.'],
    ]);
    expect(items[0].isError).toBe(true);
  });

  it('marks a message cancelled before the agent started on it', () => {
    // A message cancelled while still queued (a stop) ends without ever
    // starting; the message is marked all the same.
    const records = [
      lifecycle('message', { id: 'smsg_1', index: 0, body: 'go' }, 'smsg_1'),
      lifecycle(
        'message_ended',
        {
          message_id: 'smsg_1',
          status: 'cancelled',
          error: { reason: 'stopped' },
        },
        'smsg_1'
      ),
    ];
    const items = chatTurnsToItems(groupRecordsToChatTurns(records));
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'go'],
      ['notice', 'Message cancelled'],
    ]);
    expect(items[0].isError).toBe(true);
  });

  it('clears cancellation when an echoed message is requeued after failure', () => {
    const turns = groupRecordsToChatTurns([
      lifecycle('message', { id: 'smsg_1', index: 0, body: 'go' }, 'smsg_1'),
      lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
      record({ payload: user('go'), message_id: 'smsg_1' }),
      lifecycle(
        'message_ended',
        { message_id: 'smsg_1', status: 'failed' },
        'smsg_1'
      ),
      lifecycle('message_requeued', { message_id: 'smsg_1' }, 'smsg_1'),
    ]);

    const users = chatTurnsToItems(turns).filter((i) => i.kind === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ kind: 'user', text: 'go' });
    expect(users[0].isError).toBeUndefined();
    expect(splitLedger(turns).entries[0].cancelled).toBe(false);
  });

  it.each(['completed', 'failed', 'stopped'])(
    'uses the retry outcome when a requeued message is %s',
    (outcome) => {
      const turns = groupRecordsToChatTurns([
        lifecycle('message', { id: 'smsg_1', index: 0, body: 'go' }, 'smsg_1'),
        lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
        record({ payload: user('go'), message_id: 'smsg_1' }),
        lifecycle(
          'message_ended',
          { message_id: 'smsg_1', status: 'failed' },
          'smsg_1'
        ),
        lifecycle('message_requeued', { message_id: 'smsg_1' }, 'smsg_1'),
        lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
        record({ payload: user('go'), message_id: 'smsg_1' }),
        lifecycle(
          'message_ended',
          { message_id: 'smsg_1', status: outcome },
          'smsg_1'
        ),
      ]);

      const { entries } = splitLedger(turns);
      expect(entries).toHaveLength(1);
      expect(entries[0].cancelled).toBe(outcome !== 'completed');
    }
  );

  it('clears only the requeued message when several messages failed together', () => {
    const turns = groupRecordsToChatTurns([
      lifecycle('message', { id: 'smsg_1', index: 0, body: 'first' }, 'smsg_1'),
      lifecycle(
        'message',
        { id: 'smsg_2', index: 1, body: 'second' },
        'smsg_2'
      ),
      lifecycle('message_started', { message_id: 'smsg_1' }, 'smsg_1'),
      lifecycle('message_started', { message_id: 'smsg_2' }, 'smsg_2'),
      lifecycle(
        'message_ended',
        { message_id: 'smsg_1', status: 'failed' },
        'smsg_1'
      ),
      lifecycle(
        'message_ended',
        { message_id: 'smsg_2', status: 'failed' },
        'smsg_2'
      ),
      lifecycle('message_requeued', { message_id: 'smsg_2' }, 'smsg_2'),
    ]);

    expect(
      splitLedger(turns).entries.map(({ prompt, cancelled }) => ({
        prompt,
        cancelled,
      }))
    ).toEqual([
      { prompt: 'first', cancelled: true },
      { prompt: 'second', cancelled: false },
    ]);
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
