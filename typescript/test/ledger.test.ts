// The ledger (store/ledger.ts): entries cut at your messages, and one entry's
// body — what folds, what the fold opens into, and which single row of a
// live turn is loading.

import { describe, expect, it } from 'vitest';
import {
  entryBody,
  entrySeconds,
  splitLedger,
  isWorkFold,
  isToolFold,
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
  const completedEntry = (nodes: ChatTurn['nodes']) =>
    entry([
      turn({ role: 'assistant', nodes, startedAt: at(0), completedAt: at(43) }),
    ]);
  const settled = { live: false, now: Date.parse(at(43)) };
  const live = { live: true, now: Date.parse(at(10)) };
  const workItems = (body: ReturnType<typeof entryBody>) =>
    body.members.get(body.items.find(isWorkFold)!.key) ?? [];

  it('folds interleaved commentary, thinking and tools behind one work header', () => {
    const body = entryBody(
      completedEntry([
        say('a', 'Looking'),
        think('t1'),
        call('c1'),
        say('b', 'Checking'),
        think('t2'),
        call('c2'),
        say('final', 'Done'),
      ]),
      settled
    );
    expect(rows(body)).toEqual([
      ['Worked for 43s', false],
      ['Done', false],
    ]);
    expect(workItems(body).map((i) => i.text)).toEqual([
      'Looking',
      'hmm',
      'Ran 1 shell command',
      'Checking',
      'hmm',
      'Ran 1 shell command',
    ]);
    const tools = workItems(body).filter(isToolFold);
    expect(body.members.get(tools[0].key)?.map((i) => i.key)).toEqual([
      'c1',
      'c1:r',
    ]);
    expect(body.members.get(tools[1].key)?.map((i) => i.key)).toEqual([
      'c2',
      'c2:r',
    ]);
  });

  it('puts thinking before the final answer even without tools', () => {
    const body = entryBody(
      completedEntry([think('t'), say('final', 'Hi!')]),
      settled
    );
    expect(rows(body)).toEqual([
      ['Worked for 43s', false],
      ['Hi!', false],
    ]);
    expect(workItems(body).map((i) => i.key)).toEqual(['t']);
  });

  it('does not add an empty work section to a direct reply', () => {
    const body = entryBody(completedEntry([say('final', 'Hi!')]), settled);
    expect(rows(body)).toEqual([['Hi!', false]]);
    expect(body.members.size).toBe(0);
  });

  it('keeps consecutive progress messages folded and all final message blocks visible', () => {
    const body = entryBody(
      completedEntry([
        { ...say('a', 'Looking'), createdAt: at(1) },
        { ...say('b', 'Checking'), createdAt: at(2) },
        { ...say('f1', 'Result'), createdAt: at(40) },
        { ...say('f2', 'Details'), createdAt: at(40) },
      ]),
      settled
    );
    expect(body.items.map((i) => i.text)).toEqual([
      'Worked for 43s',
      'Result',
      'Details',
    ]);
    expect(workItems(body).map((i) => i.text)).toEqual(['Looking', 'Checking']);
  });

  it('starts with one loading work header before any record arrives', () => {
    const body = entryBody(entry([]), live);
    expect(rows(body)).toEqual([['Working', true]]);
    expect(body.members.size).toBe(0);
  });

  it('uses the current summary heading for the live work row and retires it on completion', () => {
    const e = entry([]);
    const body = entryBody(e, {
      ...live,
      liveSummary: '**Inspecting the mock server**\n\nMore details',
    });
    expect(rows(body)).toEqual([['Inspecting the mock server', true]]);
    expect(body.items[0].key).toBe(entryBody(e, live).items[0].key);
    expect(
      entryBody(completedEntry([think('t')]), {
        ...settled,
        liveSummary: 'Stale subtitle',
      }).items[0].text
    ).toBe('Worked for 43s');
    expect(entryBody(e, { ...live, liveSummary: '**' }).items[0].text).toBe(
      'Working'
    );
    expect(
      entryBody(e, { ...live, liveSummary: '# ' + 'x'.repeat(200) }).items[0]
        .text
    ).toHaveLength(120);
  });

  it.each([
    ['queued', 'Queued'],
    ['waking', 'Waking session'],
    ['starting', 'Starting agent'],
    ['working', 'Inspecting the mock server'],
  ] as const)(
    'uses live subtitles only in the working phase (%s)',
    (phase, label) => {
      const e = { ...entry([]), progress: { phase, turns: [] } };
      const body = entryBody(e, {
        ...live,
        liveSummary: '**Inspecting the mock server**',
      });
      expect(rows(body)).toEqual([[label, true]]);
    }
  );

  it.each([null, 'ok'])(
    'keeps only the work header loading with tool result %s',
    (result) => {
      const body = entryBody(
        entry([
          turn({
            role: 'assistant',
            nodes: [say('a', 'Looking'), call('c', result)],
          }),
        ]),
        live
      );
      expect(rows(body)).toEqual([
        ['Working', true],
        ['Looking', false],
        ['Ran 1 shell command', false],
      ]);
      expect([...body.members.values()].flat().some((i) => i.loading)).toBe(
        false
      );
    }
  );

  it('shows partial text and committed progress outside the live work section', () => {
    const e = entry([
      turn({ role: 'assistant', nodes: [call('c'), say('a', 'Checking')] }),
    ]);
    const body = entryBody(e, { ...live, liveText: 'More details' });
    expect(rows(body)).toEqual([
      ['Working', true],
      ['Ran 1 shell command', false],
      ['Checking', false],
      ['More details', false],
    ]);
    expect(body.members.has('work:e')).toBe(false);
    expect(entryBody(e, live).items.at(-1)?.text).toBe('Checking');
  });

  it.each(['Claude', 'Codex'] as const)(
    'shows %s messages around tool activity until the turn completes',
    (provider) => {
      const nodes: ChatTurn['nodes'] = [
        { ...say('a', 'Looking'), createdAt: at(1) },
        call('c1'),
        { ...say('b', 'Checking'), createdAt: at(2) },
        think('t'),
        call('c2'),
        { ...say('f', 'Done'), createdAt: at(40) },
      ].map((node) =>
        provider === 'Codex' && node.kind === 'assistant'
          ? {
              ...node,
              phase: node.key === 'f' ? 'final_answer' : 'commentary',
            }
          : node
      );
      const running = entryBody(
        entry([turn({ role: 'assistant', nodes, startedAt: at(0) })]),
        live
      );
      expect(running.items.map((i) => i.text)).toEqual([
        'Working',
        'Looking',
        'Ran 1 shell command',
        'Checking',
        'hmm',
        'Ran 1 shell command',
        'Done',
      ]);
      const completed = entryBody(completedEntry(nodes), settled);
      expect(completed.items.map((i) => i.text)).toEqual([
        'Worked for 43s',
        'Done',
      ]);
      expect(workItems(completed).map((i) => i.text)).toEqual([
        'Looking',
        'Ran 1 shell command',
        'Checking',
        'hmm',
        'Ran 1 shell command',
      ]);
    }
  );

  it('preserves the work key from an empty live turn through completion and replay', () => {
    const nodes = [think('t'), call('c'), say('a', 'Done')];
    const empty = entryBody(entry([]), live);
    const running = entryBody(
      entry([turn({ role: 'assistant', nodes })]),
      live
    );
    const completed = entryBody(completedEntry(nodes), settled);
    expect(
      [empty, running, completed].map((body) => body.items[0].key)
    ).toEqual(['work:e', 'work:e', 'work:e']);
    expect(entryBody(completedEntry(nodes), settled)).toEqual(completed);
  });

  it('shows explicit commentary while live and folds it after completion', () => {
    const e = entry([
      turn({
        role: 'assistant',
        nodes: [
          { ...say('a', 'Result'), phase: 'final_answer' },
          { ...say('b', 'Checking a follow-up'), phase: 'commentary' },
        ],
      }),
    ]);
    const body = entryBody(e, live);
    expect(
      body.items.filter((i) => i.kind === 'assistant').map((i) => i.text)
    ).toEqual(['Result', 'Checking a follow-up']);
    expect(body.members.has('work:e')).toBe(false);
    expect(workItems(entryBody(e, settled)).map((i) => i.text)).toEqual([
      'Checking a follow-up',
    ]);
  });

  it('does not promote explicit commentary to a final answer after completion', () => {
    const body = entryBody(
      completedEntry([
        call('c'),
        { ...say('a', 'Still checking'), phase: 'commentary' },
      ]),
      settled
    );
    expect(rows(body)).toEqual([['Worked for 43s', false]]);
    expect(workItems(body).at(-1)?.text).toBe('Still checking');
  });

  it('keeps failed-turn errors visible and does not promote unfinished progress', () => {
    const e = completedEntry([
      say('a', 'Looking'),
      { ...call('c'), isError: true },
      say('b', 'Retrying'),
    ]);
    e.turns[0].isError = true;
    const body = entryBody(e, settled);
    expect(rows(body)).toEqual([
      ['Worked for 43s', false],
      ['turn ended with an error', false],
    ]);
    expect(body.items.every((i) => i.isError)).toBe(true);
    expect(workItems(body).at(-1)?.text).toBe('Retrying');
  });

  it('keeps cancelled work folded even without a native completion record', () => {
    const e = completedEntry([call('c', null), say('a', 'Checking')]);
    e.cancelled = true;
    expect(rows(entryBody(e, settled))).toEqual([['Worked for 43s', false]]);
  });

  it('keeps lifecycle notices outside the work section', () => {
    const e = completedEntry([think('t'), say('a', 'Done')]);
    e.turns.push(
      turn({
        role: 'lifecycle',
        nodes: [
          {
            key: 'n',
            kind: 'lifecycle',
            text: 'idle',
            recordType: 'session_idle',
          },
        ],
      })
    );
    const body = entryBody(e, settled);
    expect(body.items.at(-1)?.kind).toBe('notice');
    expect(workItems(body).map((i) => i.key)).toEqual(['t']);
  });

  it('retains replies from multiple completed turns while folding their work together', () => {
    const e = entry([
      ...completedEntry([think('t1'), say('a1', 'First result')]).turns,
      ...completedEntry([think('t2'), say('a2', 'Second result')]).turns,
    ]);
    expect(rows(entryBody(e, settled))).toEqual([
      ['Worked for 1m 26s', false],
      ['First result', false],
      ['Second result', false],
    ]);
  });

  it('keeps separate work sections for separate user messages', () => {
    const { entries } = splitLedger([
      user('u1', 'First'),
      ...completedEntry([think('t1'), say('a1', 'One')]).turns,
      user('u2', 'Second'),
      ...completedEntry([think('t2'), say('a2', 'Two')]).turns,
    ]);
    expect(entries.map((e) => entryBody(e, settled).items[0].key)).toEqual([
      'work:u1',
      'work:u2',
    ]);
  });
});
