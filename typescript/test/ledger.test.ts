// The ledger (store/ledger.ts): entries cut at your messages, and one entry's
// body — what folds, what the fold opens into, and which single row of a
// live turn is loading.

import { describe, expect, it } from 'vitest';
import {
  entryBody,
  entrySeconds,
  splitLedger,
  type ChatTurn,
  type LedgerEntry,
} from '../src/store';

const at = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString();

const turn = (
  over: Partial<ChatTurn> & Pick<ChatTurn, 'role' | 'nodes'>
): ChatTurn => ({
  key: over.nodes[0]?.key ?? 'k',
  startedAt: null,
  completedAt: null,
  durationMs: null,
  costUsd: null,
  tokens: null,
  resumed: false,
  isError: false,
  ...over,
});
const user = (key: string, text: string) =>
  turn({ role: 'user', nodes: [{ key, kind: 'user', text }] });
const say = (key: string, text: string) =>
  ({ key, kind: 'assistant', text }) as const;
const think = (key: string, text = 'hmm') =>
  ({ key, kind: 'thinking', text }) as const;
const call = (key: string, result: string | null = 'ok') =>
  ({
    key,
    kind: 'tool',
    name: 'Bash',
    input: { command: 'ls' },
    summary: 'ls',
    result,
    isError: false,
    startedAt: null,
    completedAt: null,
  }) as const;
const entry = (turns: ChatTurn[], key = 'e'): LedgerEntry => ({
  key,
  prompt: 'go',
  cancelled: false,
  turns,
});
const rows = (body: ReturnType<typeof entryBody>) =>
  body.items.map((i) => [i.text, i.loading === true]);

describe('splitLedger', () => {
  it('cuts entries at your messages and keeps what came before as preamble', () => {
    const notice = turn({
      role: 'lifecycle',
      nodes: [
        { key: 'n', kind: 'lifecycle', text: 'x', recordType: 'session_idle' },
      ],
    });
    const { preamble, entries } = splitLedger([
      notice,
      user('u1', 'hi'),
      turn({ role: 'assistant', nodes: [say('a1', 'hello')] }),
      user('u2', 'more'),
    ]);
    expect(preamble).toEqual([notice]);
    expect(entries.map((e) => [e.prompt, e.turns.length])).toEqual([
      ['hi', 1],
      ['more', 0],
    ]);
  });

  it('marks the entry whose turn died without answering', () => {
    const { entries } = splitLedger([
      turn({
        role: 'user',
        nodes: [{ key: 'u', kind: 'user', text: 'go' }],
        isError: true,
      }),
    ]);
    expect(entries[0].cancelled).toBe(true);
  });
});

describe('entrySeconds', () => {
  it('sums closed turns by duration and the open one against now', () => {
    const e = entry([
      turn({
        role: 'assistant',
        nodes: [say('a', 'x')],
        startedAt: at(0),
        durationMs: 4000,
      }),
      turn({ role: 'assistant', nodes: [say('b', 'y')], startedAt: at(10) }),
    ]);
    expect(entrySeconds(e, Date.parse(at(13)))).toBe(7);
  });
});

describe('entryBody', () => {
  it('folds tool runs, opening into calls and results', () => {
    const body = entryBody(
      entry([
        turn({
          role: 'assistant',
          nodes: [
            say('a', 'looking'),
            think('t1'),
            call('c1'),
            call('c2'),
            say('b', 'done'),
          ],
        }),
      ]),
      { live: false, now: 0 }
    );
    expect(rows(body)).toEqual([
      ['looking', false],
      ['hmm', false],
      ['Ran 2 shell commands', false],
      ['done', false],
    ]);
    const fold = body.items[2];
    expect(body.members.get(fold.key)?.map((i) => i.kind)).toEqual([
      'tool',
      'tool_result',
      'tool',
      'tool_result',
    ]);
  });

  it('keeps every thought as its own row and cuts the run around it', () => {
    const body = entryBody(
      entry([
        turn({
          role: 'assistant',
          nodes: [
            think('t1'),
            say('a', 'plan'),
            call('c1'),
            think('t2'),
            call('c2'),
            say('b', 'mid'),
          ],
        }),
      ]),
      { live: false, now: 0 }
    );
    expect(body.items.map((i) => i.text)).toEqual([
      'hmm',
      'plan',
      'Ran 1 shell command',
      'hmm',
      'Ran 1 shell command',
      'mid',
    ]);
    expect(body.members.get(body.items[2].key)?.map((i) => i.key)).toEqual([
      'c1',
      'c1:r',
    ]);
  });

  it('closes a turn without tool calls on "Thought for", opening into the thoughts', () => {
    const body = entryBody(
      entry([
        turn({
          role: 'assistant',
          nodes: [think('t1'), say('a', 'Hi!')],
          startedAt: at(0),
          durationMs: 41000,
        }),
      ]),
      { live: false, now: 0 }
    );
    expect(rows(body)).toEqual([
      ['Hi!', false],
      ['Thought for 41s', false],
    ]);
    expect(body.members.get(body.items[1].key)?.map((i) => i.key)).toEqual([
      't1',
    ]);
  });

  it('shows nothing after a reply that neither thought nor ran tools', () => {
    const body = entryBody(
      entry([turn({ role: 'assistant', nodes: [say('a', 'Hi!')] })]),
      { live: false, now: 0 }
    );
    expect(rows(body)).toEqual([['Hi!', false]]);
  });

  it('live before any record: one loading Thinking row with nothing to open', () => {
    const body = entryBody(entry([]), { live: true, now: 0 });
    expect(rows(body)).toEqual([['Thinking', true]]);
    expect(body.members.size).toBe(0);
  });

  it('live with a call out: the run is the loading row, the Thinking row is gone', () => {
    const body = entryBody(
      entry([
        turn({
          role: 'assistant',
          nodes: [say('a', 'looking'), call('c1', null)],
        }),
      ]),
      { live: true, now: 0 }
    );
    expect(rows(body)).toEqual([
      ['looking', false],
      ['Ran 1 shell command', true],
    ]);
  });

  it('live with text streaming: the streaming text is the loading row', () => {
    const body = entryBody(
      entry([
        turn({ role: 'assistant', nodes: [say('a', 'looking'), call('c1')] }),
      ]),
      { live: true, now: 0, liveText: 'Here is what' }
    );
    expect(rows(body)).toEqual([
      ['looking', false],
      ['Ran 1 shell command', false],
      ['Here is what', true],
    ]);
    expect(body.items[2].kind).toBe('assistant');
  });

  it('live between records after tools: the last row stands in', () => {
    const body = entryBody(
      entry([
        turn({
          role: 'assistant',
          nodes: [say('a', 'looking'), call('c1'), say('b', 'next')],
        }),
      ]),
      { live: true, now: 0 }
    );
    expect(rows(body)).toEqual([
      ['looking', false],
      ['Ran 1 shell command', false],
      ['next', true],
    ]);
  });

  it('never leaves a settled turn loading, even with an unanswered call', () => {
    const body = entryBody(
      entry([turn({ role: 'assistant', nodes: [call('c1', null)] })]),
      { live: false, now: 0 }
    );
    expect(rows(body)).toEqual([['Ran 1 shell command', false]]);
  });
});
