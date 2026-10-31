// Derived rendering view only. The record's payload stays native and untouched.
import type { SdkRecord, SessionRecord } from '../types';

export function claudePayload(record: SessionRecord): SdkRecord | null {
  if (record.kind === 'claude_sdk') return record.payload;
  if (record.kind !== 'claude_code') return null;
  const event = record.payload;
  switch (event.type) {
    case 'assistant':
      return {
        ...event.message,
        kind: 'assistant',
        message_id: event.message.id,
        parent_tool_use_id: event.parent_tool_use_id,
      };
    case 'user':
      return {
        kind: 'user',
        content: event.message.content,
        uuid: event.uuid,
        parent_tool_use_id: event.parent_tool_use_id,
      };
    case 'system':
      return {
        kind: 'system',
        subtype: event.subtype,
        data: event,
        session_id: event.session_id,
        uuid: event.uuid,
      };
    case 'result':
      return {
        ...event,
        kind: 'result',
        cost_usd: event.total_cost_usd,
        model_usage: event.modelUsage,
      };
    case 'rate_limit_event':
      return {
        kind: 'rate_limit',
        status: event.rate_limit_info.status,
        rate_limit_type: event.rate_limit_info.rateLimitType,
        resets_at: event.rate_limit_info.resetsAt,
        utilization: event.rate_limit_info.utilization,
      };
    default:
      return null;
  }
}
