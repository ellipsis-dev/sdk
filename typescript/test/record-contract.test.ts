import { expect, expectTypeOf, it } from 'vitest';
import type { SessionRecord, SessionRecordsListResponse } from '../src/types';
import {
  claudePayload,
  entryBody,
  isWorkFold,
  recordToItems,
  SessionTranscriptStore,
} from '../src/store';

// Compiled by the SDK typecheck: REST and WebSocket consumers can narrow known
// events without casts, and unknown native data cannot masquerade as typed data.
function checkTypes(
  record: SessionRecord | SessionRecordsListResponse['records'][number]
): void {
  if (record.kind === 'platform' && record.record_type === 'sandbox_ready') {
    expectTypeOf(record.payload.repositories).toMatchTypeOf<
      string[] | undefined
    >();
    // @ts-expect-error an arbitrary extension is not a typed message body
    const body: string = record.payload.body;
    void body;
  }
  if (record.kind === 'claude_code' && record.payload.type === 'assistant') {
    expectTypeOf(record.payload.message.model).toEqualTypeOf<string>();
    for (const block of record.payload.message.content) {
      if (block.type === 'text')
        expectTypeOf(block.text).toEqualTypeOf<string>();
    }
  }
  if (record.kind === 'codex' && record.payload.type === 'item.completed') {
    if (record.payload.item.type === 'command_execution') {
      expectTypeOf(record.payload.item.command).toMatchTypeOf<
        string | undefined
      >();
    }
  }
  if (
    record.kind === 'codex_app_server' &&
    record.payload.method === 'item/completed'
  ) {
    if (record.payload.params.item.type === 'userMessage') {
      for (const input of record.payload.params.item.content) {
        if (input.type === 'localImage') {
          expectTypeOf(input.path).toEqualTypeOf<string>();
          // @ts-expect-error image bytes never become a typed text field
          const text: string = input.text;
          void text;
        } else {
          expectTypeOf(input.text).toEqualTypeOf<string>();
        }
      }
    }
    if (record.payload.params.item.type === 'mcpToolCall') {
      const item = record.payload.params.item;
      expectTypeOf(item.server).toEqualTypeOf<string>();
      expectTypeOf(item.tool).toEqualTypeOf<string>();
      expectTypeOf(item.status).toEqualTypeOf<
        'inProgress' | 'completed' | 'failed'
      >();
      expectTypeOf(item.arguments).toEqualTypeOf<unknown>();
      if (item.error) expectTypeOf(item.error.message).toEqualTypeOf<string>();
      if (item.result)
        expectTypeOf(item.result.content).toEqualTypeOf<unknown[]>();
    }
    if (record.payload.params.item.type === 'commandExecution') {
      expectTypeOf(record.payload.params.item.command).toEqualTypeOf<string>();
      expectTypeOf(record.payload.params.item.exitCode).toEqualTypeOf<
        number | null | undefined
      >();
    }
  }
  if (record.kind === 'unknown') {
    expectTypeOf(record.payload.message).toEqualTypeOf<unknown>();
  }
}

const envelope = {
  id: 'native_1',
  session_id: 'session_1',
  session_execution_id: 'execution_1',
  turn_id: 'turn_1',
  sandbox_id: 'sandbox_1',
  session_message_id: null,
  feed_seq: 1,
  stream_seq: 0,
  tools: null,
  tokens_info: null,
  cost: null,
  duration: null,
  model: null,
  created_at: '2026-09-08T10:00:00Z',
};

it('renders native Claude output without changing its JSON or correlations', () => {
  const record: SessionRecord = {
    ...envelope,
    kind: 'claude_code',
    source: 'claude_code',
    record_format: 'claude_jsonl@1',
    record_type: 'assistant',
    payload: {
      type: 'assistant',
      future: { preserved: [null, 3] },
      message: {
        type: 'message',
        role: 'assistant',
        id: 'message_native',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Hello', extra: false }],
      },
    },
  };
  const original = JSON.stringify(record);
  checkTypes(record);
  expect(claudePayload(record)).toMatchObject({
    kind: 'assistant',
    message_id: 'message_native',
  });
  expect(recordToItems(record, 'r')).toMatchObject([
    { kind: 'assistant', text: 'Hello' },
  ]);
  const store = new SessionTranscriptStore();
  store.ingest({ type: 'records_append', records: [record] });
  expect(store.chatTurns()[0].nodes[0]).toMatchObject({
    kind: 'assistant',
    text: 'Hello',
  });
  expect(JSON.stringify(store.getSnapshot().records[0])).toBe(original);
});

it('retains unknown records and advances the resume cursor past them', () => {
  const record: SessionRecord = {
    ...envelope,
    kind: 'unknown',
    source: 'future_harness',
    record_format: 'future_jsonl@2',
    record_type: 'future_event',
    payload: { opaque: [false, null] },
  };
  checkTypes(record);
  const store = new SessionTranscriptStore();
  store.ingest({ type: 'records_append', records: [record] });
  expect(store.cursor).toBe(1);
  expect(store.getSnapshot().records).toEqual([record]);
  expect(recordToItems(record, 'r')).toEqual([]);
});

it('renders native app-server tools and completes the turn without changing the payload', () => {
  const command: SessionRecord = {
    ...envelope,
    kind: 'codex_app_server',
    source: 'codex',
    record_format: 'codex_app_server@1',
    record_type: 'item/completed',
    payload: {
      method: 'item/completed',
      emittedAtMs: 123,
      params: {
        threadId: 'native_thread',
        turnId: 'native_turn',
        item: {
          type: 'commandExecution',
          id: 'cmd_1',
          command: 'node test.js',
          cwd: '/workspace',
          commandActions: [],
          status: 'failed',
          exitCode: 1,
          aggregatedOutput: 'test failed',
          future: { preserved: [null, true] },
        },
      },
    },
  };
  const complete: SessionRecord = {
    ...envelope,
    id: 'native_2',
    feed_seq: 2,
    stream_seq: 1,
    kind: 'codex_app_server',
    source: 'codex',
    record_format: 'codex_app_server@1',
    record_type: 'turn/completed',
    payload: {
      method: 'turn/completed',
      params: {
        threadId: 'native_thread',
        turn: { id: 'native_turn', status: 'failed', items: [] },
      },
    },
  };
  const original = JSON.stringify(command);
  checkTypes(command);
  expect(recordToItems(command, 'r')).toMatchObject([
    { kind: 'tool', text: 'Bash' },
    { kind: 'tool_result', text: 'test failed', isError: true },
  ]);
  const store = new SessionTranscriptStore();
  store.ingest({ type: 'records_append', records: [command, complete] });
  expect(store.chatTurns()[0]).toMatchObject({
    isError: true,
    completedAt: envelope.created_at,
    nodes: [
      { kind: 'tool', name: 'Bash', result: 'test failed', isError: true },
    ],
  });
  expect(JSON.stringify(store.getSnapshot().records[0])).toBe(original);
});

it('renders one complete app-server reply and keeps user echoes out of the assistant turn', () => {
  const reply = {
    ...envelope,
    kind: 'codex_app_server',
    source: 'codex',
    record_format: 'codex_app_server@1',
    record_type: 'item/completed',
    payload: {
      method: 'item/completed',
      params: {
        threadId: 'native_thread',
        turnId: 'native_turn',
        item: { type: 'agentMessage', id: 'message_1', text: 'pong' },
      },
    },
  } satisfies SessionRecord;
  const started: SessionRecord = {
    ...reply,
    payload: { ...reply.payload, method: 'item/started' },
  };
  expect(recordToItems(started, 'r')).toEqual([]);
  expect(recordToItems(reply, 'r')).toMatchObject([
    { kind: 'assistant', text: 'pong' },
  ]);
  const echo: SessionRecord = {
    ...reply,
    payload: {
      method: 'item/completed',
      params: {
        threadId: 'native_thread',
        turnId: 'native_turn',
        item: {
          type: 'userMessage',
          id: 'message_0',
          content: [{ type: 'text', text: 'Say pong' }],
        },
      },
    },
  };
  expect(recordToItems(echo, 'r')).toEqual([]);
});

it.each(['commentary', 'final_answer'] as const)(
  'preserves native %s intent from records through the ledger',
  (phase) => {
    const record: SessionRecord = {
      ...envelope,
      kind: 'codex_app_server',
      source: 'codex',
      record_format: 'codex_app_server@1',
      record_type: 'item/completed',
      payload: {
        method: 'item/completed',
        params: {
          threadId: 'native_thread',
          turnId: 'native_turn',
          item: { type: 'agentMessage', id: 'message_1', text: 'Reply', phase },
        },
      },
    };
    const store = new SessionTranscriptStore();
    store.ingest({ type: 'records_append', records: [record] });
    const turns = store.chatTurns();
    expect(turns[0].nodes[0]).toMatchObject({ kind: 'assistant', phase });
    const body = entryBody(
      { key: 'e', prompt: 'Go', cancelled: false, turns },
      {
        live: false,
        now: Date.parse(envelope.created_at),
      }
    );
    expect(body.items[0].kind).toBe(
      phase === 'final_answer' ? 'assistant' : 'summary'
    );
    expect(isWorkFold(body.items[0])).toBe(phase === 'commentary');
  }
);
