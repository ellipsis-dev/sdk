import type { GeminiStreamEvent } from '../types';
import { oneLine, summarizeToolInput } from './transcript';

// Presentation only. The store keeps the complete native record unchanged.
export type GeminiContent =
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'end'; isError: boolean }
  | {
      kind: 'tool';
      toolId: string;
      name: string;
      input: Record<string, unknown> | null;
      summary: string;
    }
  | { kind: 'tool_result'; toolId: string; text: string; isError: boolean };

export function geminiStreamContent(
  event: GeminiStreamEvent
): GeminiContent | null {
  switch (event.type) {
    case 'message':
      return event.role === 'assistant' && !event.delta && event.content.trim()
        ? { kind: 'assistant', text: event.content }
        : null;
    case 'tool_use': {
      const input = (event.parameters ?? null) as Record<
        string,
        unknown
      > | null;
      return {
        kind: 'tool',
        toolId: event.tool_id,
        name: event.tool_name,
        input,
        summary: oneLine(summarizeToolInput(event.tool_name, input ?? {}), 100),
      };
    }
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolId: event.tool_id,
        text: (event.output ?? event.error?.message ?? '').trim(),
        isError: event.status === 'error',
      };
    case 'error':
      return { kind: 'error', text: event.message };
    case 'result':
      return { kind: 'end', isError: event.status === 'error' };
    default:
      return null;
  }
}
