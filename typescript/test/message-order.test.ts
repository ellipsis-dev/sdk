import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../src/types';
import {
  groupRecordsToChatTurns,
  splitLedger,
  entryBody,
  isWorkFold,
} from '../src/store';

const at = (s: number) =>
  new Date(Date.UTC(2026, 8, 12, 13, 45, s)).toISOString();
// The session, whose opening prompt becomes message zero.
const session = {
  codex: { prompt: 'Update the docs' },
  created_at: at(0),
};
const record = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  messageId: string | null = null,
  native = false
): SessionRecord =>
  ({
    id: `record-${seq}`,
    session_id: 'session',
    message_id: messageId,
    feed_seq: seq,
    source: native ? 'codex' : 'lifecycle',
    kind: native ? 'codex_app_server' : 'platform',
    record_type: type,
    record_format: native ? 'codex_app_server@1' : 'ellipsis_lifecycle@1',
    created_at: at(seq),
    payload,
    tools: null,
    tokens_info: null,
    cost: null,
    duration: null,
    model: null,
  }) as SessionRecord;
// A message record names its message in the payload and the envelope;
// message zero is the opening prompt.
const received = (seq: number, id: string, body: string, index: number) =>
  record(seq, 'message', { id, index, body }, id);
const started = (seq: number, id: string) =>
  record(seq, 'message_started', { message_id: id }, id);
const answer = (seq: number, text: string, messageId: string | null) =>
  record(
    seq,
    'item/completed',
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: `answer-${seq}`,
          text,
          phase: 'final_answer',
        },
      },
    },
    messageId,
    true
  );
// A historical feed that recorded a follow-up before the opening message.
const initial = [
  received(2, 'followup', 'Open a PR', 1),
  started(3, 'opening'),
  received(4, 'opening', session.codex.prompt, 0),
];
const ledger = (records: SessionRecord[], opening = session) =>
  splitLedger(groupRecordsToChatTurns(records, opening)).entries;
const replies = (entries: ReturnType<typeof ledger>) =>
  entries.map((entry) => [
    entry.prompt,
    entry.turns.flatMap((turn) =>
      turn.nodes
        .filter((node) => node.kind === 'assistant')
        .map((node) => node.text)
    ),
  ]);

describe('message ordering and answer ownership', () => {
  it('keeps the opening prompt visible while follow-ups arrive during preparation', () => {
    const entries = ledger([
      received(1, 'opening', session.codex.prompt, 0),
      record(
        2,
        'environment_phase',
        { phase: 'image', status: 'started' },
        'opening'
      ),
      received(3, 'followup', 'Open a PR', 1),
    ]);
    expect(entries.map((entry) => entry.prompt)).toEqual([
      'Update the docs',
      'Open a PR',
    ]);
    expect(entries[0].key).toBe('prompt');
    expect(entries.map((entry) => entry.progress?.phase)).toEqual([
      'preparing',
      'queued',
    ]);
  });

  it('shows the opening prompt from the session alone before any record lands', () => {
    const entries = ledger([]);
    expect(entries.map((entry) => [entry.key, entry.prompt])).toEqual([
      ['prompt', 'Update the docs'],
    ]);
    expect(entries[0].progress?.phase).toBe('preparing');
  });

  it('reconciles the opening message record with a start that preceded it', () => {
    const entries = ledger(initial);
    expect(entries.map((entry) => entry.prompt)).toEqual([
      session.codex.prompt,
      'Open a PR',
    ]);
    expect(entries[0].key).toBe('prompt');
    expect(entries.map((entry) => entry.progress?.phase)).toEqual([
      'starting',
      'queued',
    ]);
  });

  it('repairs the historical opening-message order and gives each answer its own entry', () => {
    const entries = ledger([
      ...initial,
      answer(6, 'Docs updated', 'opening'),
      started(7, 'followup'),
      answer(8, 'PR opened', 'followup'),
    ]);
    expect(replies(entries)).toEqual([
      ['Update the docs', ['Docs updated']],
      ['Open a PR', ['PR opened']],
    ]);
    expect(entries[0].key).toBe('prompt');
    expect(entries[0].createdAt).toBe(session.created_at);
  });

  it('does not attach continued output to a follow-up that is still queued', () => {
    const entries = ledger([
      ...initial,
      answer(6, 'Still doing the first task', 'opening'),
      received(7, 'third', 'Also add tests', 2),
      answer(8, 'First task finished', 'opening'),
    ]);
    expect(replies(entries)).toEqual([
      [
        'Update the docs',
        ['Still doing the first task', 'First task finished'],
      ],
      ['Open a PR', []],
      ['Also add tests', []],
    ]);
  });

  it('gives steered content within one native turn to the message it answers', () => {
    // A follow-up accepted mid-turn: the agent keeps its native turn, but the
    // records after the start carry the new message id.
    const entries = ledger([
      ...initial,
      answer(6, 'Original work', 'opening'),
      started(7, 'followup'),
      answer(8, 'Steered work', 'followup'),
    ]);
    expect(replies(entries)).toEqual([
      ['Update the docs', ['Original work']],
      ['Open a PR', ['Steered work']],
    ]);
  });

  it('keeps Claude replies attached to their started messages with queued follow-ups', () => {
    const claude = (
      seq: number,
      text: string,
      messageId: string
    ): SessionRecord =>
      ({
        ...record(
          seq,
          'assistant',
          { kind: 'assistant', content: [{ type: 'text', text }], usage: null },
          messageId
        ),
        kind: 'claude_sdk',
        source: 'claude_code',
        record_format: 'claude_sdk@1',
      }) as SessionRecord;
    expect(
      replies(
        ledger([
          ...initial,
          claude(6, 'Docs updated', 'opening'),
          started(7, 'followup'),
          claude(8, 'PR opened', 'followup'),
        ])
      )
    ).toEqual([
      ['Update the docs', ['Docs updated']],
      ['Open a PR', ['PR opened']],
    ]);
  });

  it('never deduplicates two messages with identical text', () => {
    const records = [...initial];
    records[0] = received(2, 'followup', session.codex.prompt, 1);
    const entries = ledger([
      ...records,
      answer(6, 'First', 'opening'),
      started(7, 'followup'),
      answer(8, 'Second', 'followup'),
    ]);
    expect(replies(entries)).toEqual([
      [session.codex.prompt, ['First']],
      [session.codex.prompt, ['Second']],
    ]);
  });

  it('does not resurrect the opening prompt in truncated history', () => {
    expect(
      ledger([received(30, 'later', 'Continue', 3)]).map(
        (entry) => entry.prompt
      )
    ).toEqual(['Continue']);
  });

  it('does not give an unstamped native record to a pending message', () => {
    expect(
      replies(
        ledger([
          ...initial,
          received(6, 'later', 'Wait', 2),
          answer(7, 'Extra continuation', null),
        ])
      )[0]
    ).toEqual([session.codex.prompt, ['Extra continuation']]);
  });

  it('keeps a successful work summary neutral when an intermediate command failed', () => {
    const failed = record(
      6,
      'item/completed',
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'cmd',
            command: 'rg missing',
            commandActions: [],
            cwd: '/workspace',
            status: 'failed',
            exitCode: 1,
            aggregatedOutput: 'No matches',
          },
        },
      },
      'opening',
      true
    );
    const body = entryBody(
      ledger([...initial, failed, answer(7, 'Done', 'opening')])[0],
      { live: false, now: Date.parse(at(8)) }
    );
    expect(body.items.find(isWorkFold)?.isError).not.toBe(true);
    expect([...body.members.values()].flat().some((item) => item.isError)).toBe(
      true
    );
  });
});
