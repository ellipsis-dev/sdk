import type { CodexAppServerEvent } from '../types';
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
