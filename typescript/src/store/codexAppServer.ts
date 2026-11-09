import type { CodexAppServerEvent, SessionRecord } from '../types';
import type { CodexAgentMessage } from '../generated/frames';

// Presentation only. The store keeps the complete native record unchanged.
type Content =
  | { kind: 'assistant'; text: string; phase?: CodexAgentMessage['phase'] }
  | { kind: 'thinking'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'end'; isError: boolean }
  | {
      kind: 'tool';
      name: string;
      input: Record<string, unknown> | null;
      summary: string;
      result: string | null;
      isError: boolean;
    };

// Threads announced as in-process subagents. A spawn is recorded on the
// spawning thread before the subagent's own events, so one ordered pass sees
// every announcement before the records it governs.
export function codexSubagentThreads(
  records: readonly SessionRecord[]
): Set<string> {
  const threads = new Set<string>();
  for (const record of records) addCodexSubagentThreads(threads, record);
  return threads;
}

// Records the threads a spawn or collab call names; true when the record is one.
export function addCodexSubagentThreads(
  threads: Set<string>,
  record: SessionRecord
): boolean {
  if (record.kind !== 'codex_app_server') return false;
  const event = record.payload;
  if (event.method !== 'item/started' && event.method !== 'item/completed') {
    return false;
  }
  const item = event.params.item;
  if (item.type === 'subAgentActivity') {
    threads.add(item.agentThreadId);
    return true;
  }
  if (item.type === 'collabAgentToolCall') {
    for (const thread of item.receiverThreadIds) threads.add(thread);
    return true;
  }
  return false;
}

// A parent's spawn of a subagent, which starts work inside the parent's turn.
export function isCodexSubagentSpawn(record: SessionRecord): boolean {
  if (record.kind !== 'codex_app_server') return false;
  const event = record.payload;
  if (event.method !== 'item/started' && event.method !== 'item/completed') {
    return false;
  }
  const item = event.params.item;
  return item.type === 'subAgentActivity' && item.kind === 'started';
}

export function isCodexSubagentRecord(
  threads: ReadonlySet<string>,
  record: SessionRecord
): boolean {
  if (record.kind !== 'codex_app_server') return false;
  const params = record.payload.params;
  return (
    'threadId' in params &&
    typeof params.threadId === 'string' &&
    threads.has(params.threadId)
  );
}

export function codexAppServerContent(
  event: CodexAppServerEvent
): Content | null {
  if (event.method === 'turn/completed') {
    return { kind: 'end', isError: event.params.turn.status !== 'completed' };
  }
  if (event.method === 'error') {
    return event.params.willRetry
      ? null
      : { kind: 'error', text: event.params.error.message };
  }
  if (event.method !== 'item/completed') return null;
  const item = event.params.item;
  switch (item.type) {
    case 'agentMessage':
      return { kind: 'assistant', text: item.text, phase: item.phase };
    case 'plan':
      return { kind: 'assistant', text: item.text, phase: 'commentary' };
    case 'reasoning':
      return {
        kind: 'thinking',
        text: (item.summary?.length ? item.summary : (item.content ?? [])).join(
          '\n'
        ),
      };
    case 'commandExecution':
      return {
        kind: 'tool',
        name: 'Bash',
        input: { command: item.command, commandActions: item.commandActions },
        summary: item.command,
        result: item.aggregatedOutput?.trim() || '(no output)',
        isError:
          item.status === 'failed' ||
          item.status === 'declined' ||
          (typeof item.exitCode === 'number' && item.exitCode !== 0),
      };
    case 'fileChange':
      return {
        kind: 'tool',
        name: 'Edit',
        input: { changes: item.changes },
        summary: item.changes.map((change) => change.path).join(', '),
        result: item.changes.map((change) => change.diff).join('\n'),
        isError: item.status === 'failed' || item.status === 'declined',
      };
    case 'subAgentActivity':
      return {
        kind: 'tool',
        name: 'Agent',
        input: { agentPath: item.agentPath ?? null, kind: item.kind },
        summary: item.agentPath ?? item.agentThreadId,
        result: item.kind,
        isError: false,
      };
    case 'webSearch':
      return {
        kind: 'tool',
        name: 'WebSearch',
        input: { query: item.query },
        summary: item.query,
        result: null,
        isError: false,
      };
    default:
      return null;
  }
}
