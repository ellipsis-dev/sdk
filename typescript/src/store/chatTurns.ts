// Group a session's flat record stream into chat TURNS for a chat-style
// transcript — the richer view that reads like a messenger thread rather than
// the terminal clone (eventToItems).
//
// Two shaping jobs beyond `eventToItems`:
//   1. Pair each tool CALL with its RESULT into one node (results arrive later,
//      as a following `user` event's `tool_result`, keyed by `tool_use_id`), so
//      the UI renders one collapsible tool card, not a call line + a detached
//      result line.
//   2. Bucket nodes into turns with timing — a human turn (one message) or an
//      agent turn (its prose / thinking / tool cards), the agent turn carrying
//      start/complete timestamps so the UI can show a count-up timer. The
//      `result` event closes an agent turn (its duration) but is NOT itself
//      rendered, and `system` events (session-init / liveness ticks) are
//      dropped entirely.

import type { SessionRecord } from '../types';
import type { CCContentBlock, CCEvent } from './transcript';
import { summarizeToolInput } from './transcript';
import {
  lifecycleText,
  sandboxOutputLines,
  sandboxOutputStep,
} from './lifecycle';

// A tool call and (once it lands) its result, rendered as one collapsible card.
// `result` is null until the matching `tool_result` arrives. `startedAt` /
// `completedAt` are the call and result records' timestamps — per-call timing
// (there is no per-call COST: cost exists per LLM completion, and Claude Code
// reports only cumulative per-turn totals).
export interface ChatToolNode {
  key: string;
  kind: 'tool';
  name: string;
  input: Record<string, unknown> | null;
  summary: string;
  result: string | null;
  isError: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export type ChatNode =
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'thinking'; text: string }
  | { key: string; kind: 'user'; text: string }
  | {
      key: string;
      kind: 'lifecycle';
      text: string;
      recordType: string;
      // The provisioning step a sandbox_output chunk came from (an
      // "owner/name" for clone, image.setup, post_start / post_clone);
      // consecutive chunks of the same step collapse into one line.
      step?: string;
      // The step's full accumulated output across its chunks (sandbox_output
      // nodes only), so a renderer can expand the one-line summary into the
      // whole build log.
      lines?: string[];
      // The record's native payload, verbatim, so a renderer can compose
      // richer copy than the one-line `text` (e.g. sandbox_ready's
      // repositories / cache_tier / phase_timings).
      payload?: Record<string, unknown>;
    }
  | ChatToolNode;

// A conversation turn: one human message, or one agent response (its nodes).
// Agent turns carry timing so the UI can run a count-up timer: `startedAt` is
// the first record's timestamp, `completedAt` / `durationMs` come from the
// turn's `result` event (null while the turn is still running). `resumed`
// marks an agent turn that woke a sleeping/idle session — see the init
// tracking below.
export interface ChatTurn {
  key: string;
  role: 'assistant' | 'user' | 'lifecycle';
  nodes: ChatNode[];
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  // Rolled up for the turn's header bar. `costUsd` is THIS turn's cost — the
  // delta between consecutive `result` events' cumulative totals (a result's
  // `total_cost_usd` is the running session total, not the turn's own);
  // `tokens` sums the assistant messages' output tokens. Null until known
  // (user turns never have them). Display-only turn arithmetic — the
  // session's authoritative totals are the session frame's cost fields (§6).
  costUsd: number | null;
  tokens: number | null;
  resumed: boolean;
}

// Every Claude Code execution opens with a `system`/`subtype:"init"` event,
// and a keyed session runs one execution per wake. So the FIRST init is the
// session starting; each LATER init means the session had gone idle/asleep and
// a message woke it — that's what marks the following agent turn `resumed`.
// `init` is the only system event that matters here; the rest (the output-/
// thinking-token and status liveness ticks, hook/task/notification signals)
// are all dropped — they aren't conversation.
const isInitEvent = (data: CCEvent): boolean =>
  data.type === 'system' && data.subtype === 'init';

const TOOL_USE_BLOCK_TYPES = new Set<string>([
  'tool_use',
  'server_tool_use',
  'mcp_tool_use',
]);

// The sandbox spawn family — the lifecycle records that fold into one
// sandbox turn (see the lifecycle branch below).
const SANDBOX_RECORD_TYPES = new Set<string>([
  'sandbox_starting',
  'sandbox_phase',
  'sandbox_output',
  'sandbox_ready',
]);

// Best-effort display text for a tool_result: its content is a string, a list
// of text blocks, or arbitrary JSON. Whitespace preserved, only end-trimmed.
function toolResultText(block: CCContentBlock): string {
  const c = block.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return (c as CCContentBlock[])
      .map((inner) =>
        typeof inner.text === 'string' ? inner.text : JSON.stringify(inner)
      )
      .join('\n')
      .trim();
  }
  if (c === undefined || c === null) return '';
  return JSON.stringify(c);
}

export function groupRecordsToChatTurns(
  records: readonly SessionRecord[]
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  // tool_use id → its ChatToolNode, so a later tool_result fills the same card.
  const toolNodeByUseId = new Map<string, ChatToolNode>();
  let seq = 0;
  const nextKey = (base: string) => `${base}:${seq++}`;

  // Index of the currently-open agent turn in `turns` (-1 = none open).
  // Tracked as an index, not a nullable closure var, so the mutations below
  // type-narrow cleanly.
  let openIdx = -1;
  // Cumulative session cost as of the previous `result` event, so each turn's
  // costUsd is its own delta rather than the running total.
  let prevCumulativeCostUsd = 0;
  // How many init events we've seen, and whether the next agent turn woke the
  // session (set by a non-first init, consumed when the turn opens).
  let initCount = 0;
  let pendingResume = false;
  const openAgentTurn = (record: SessionRecord): ChatTurn => {
    if (openIdx < 0) {
      turns.push({
        key: nextKey(record.id),
        role: 'assistant',
        nodes: [],
        startedAt: record.created_at,
        completedAt: null,
        durationMs: null,
        costUsd: null,
        tokens: null,
        resumed: pendingResume,
      });
      pendingResume = false;
      openIdx = turns.length - 1;
    }
    return turns[openIdx];
  };

  for (const record of records) {
    // Lifecycle records render as their own feed item between turns. The
    // sandbox spawn family (starting → setup-output chunks → ready) folds
    // into ONE turn whose node list is the whole spawn story, so a renderer
    // can draw one card that updates in place while the box builds and opens
    // up into the full setup log. Other lifecycle records (paused, resumed,
    // closed, cancelled) each stand alone.
    if (record.source === 'lifecycle') {
      const text = lifecycleText(record.record_type, record.payload);
      if (!text) continue;
      const isSandbox = SANDBOX_RECORD_TYPES.has(record.record_type);
      const isSandboxOutput = record.record_type === 'sandbox_output';
      const step = isSandboxOutput
        ? sandboxOutputStep(record.payload)
        : undefined;
      const lines = isSandboxOutput
        ? sandboxOutputLines(record.payload)
        : undefined;

      // The turn to fold into: the most recent sandbox turn among the
      // TRAILING run of lifecycle turns. A non-sandbox lifecycle divider
      // (session_resumed on a wake) may sit between the sandbox card and its
      // post-ready records (restore transitions, hook output) — scan past
      // those, but never past a conversation turn, and sandbox_starting
      // always begins a fresh spin-up card. Requiring the IMMEDIATELY
      // previous turn here was the orphan-second-card bug on wakes.
      let foldTarget: ChatTurn | null = null;
      if (isSandbox && record.record_type !== 'sandbox_starting') {
        for (let i = turns.length - 1; i >= 0; i--) {
          const candidate = turns[i];
          if (candidate.role !== 'lifecycle') break;
          if (
            candidate.nodes.some(
              (n) =>
                n.kind === 'lifecycle' && SANDBOX_RECORD_TYPES.has(n.recordType)
            )
          ) {
            foldTarget = candidate;
            break;
          }
        }
      }
      if (foldTarget) {
        // Fold into the open sandbox turn. Consecutive sandbox_output
        // chunks of the same step collapse into one node whose text tracks
        // the script's latest output line while `lines` accumulates the
        // step's whole log.
        const last = foldTarget.nodes[foldTarget.nodes.length - 1];
        if (
          isSandboxOutput &&
          last &&
          last.kind === 'lifecycle' &&
          last.recordType === 'sandbox_output' &&
          last.step === step
        ) {
          last.text = text;
          last.lines = [...(last.lines ?? []), ...(lines ?? [])];
        } else {
          foldTarget.nodes.push({
            key: nextKey(record.id),
            kind: 'lifecycle',
            text,
            recordType: record.record_type,
            step,
            lines,
            payload: record.payload,
          });
        }
        foldTarget.completedAt = record.created_at;
        continue;
      }
      turns.push({
        key: nextKey(record.id),
        role: 'lifecycle',
        nodes: [
          {
            key: nextKey(record.id),
            kind: 'lifecycle',
            text,
            recordType: record.record_type,
            step,
            lines,
            payload: record.payload,
          },
        ],
        startedAt: record.created_at,
        completedAt: record.created_at,
        durationMs: null,
        costUsd: null,
        tokens: null,
        resumed: false,
      });
      continue;
    }
    // Everything else shaped here is a claude_code transcript record; unknown
    // sources are ignored (§3.6).
    if (record.source !== 'claude_code') continue;
    const data = record.payload as CCEvent;

    if (data.type === 'system') {
      // init = a fresh execution; the 2nd+ one means this message woke the
      // session. All other system events (liveness ticks, hooks, …) are
      // dropped.
      if (isInitEvent(data)) {
        initCount += 1;
        if (initCount > 1) pendingResume = true;
      }
      continue;
    }

    if (data.type === 'result') {
      // Close the open agent turn with its duration; render nothing for it.
      if (openIdx >= 0) {
        turns[openIdx].completedAt = record.created_at;
        turns[openIdx].durationMs =
          typeof data.duration_ms === 'number' ? data.duration_ms : null;
        if (typeof data.total_cost_usd === 'number') {
          // total_cost_usd is the CUMULATIVE session total; the turn's own
          // cost is the delta from the previous result.
          turns[openIdx].costUsd = Math.max(
            0,
            data.total_cost_usd - prevCumulativeCostUsd
          );
          prevCumulativeCostUsd = data.total_cost_usd;
        }
        openIdx = -1;
      }
      continue;
    }

    const message = data.message;
    if (!message) continue;

    if (data.type === 'user') {
      const content = message.content;
      if (typeof content === 'string') {
        // A real human message: closes the current agent turn and stands alone.
        if (content.trim()) {
          openIdx = -1;
          turns.push({
            resumed: false,
            key: nextKey(record.id),
            role: 'user',
            nodes: [
              { key: nextKey(record.id), kind: 'user', text: content.trim() },
            ],
            startedAt: record.created_at,
            completedAt: record.created_at,
            durationMs: null,
            costUsd: null,
            tokens: null,
          });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      // Tool results: fill the matching call's card; do NOT close the turn
      // (the call and its result are the same agent turn).
      for (const block of content as CCContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        const body = toolResultText(block) || '(no output)';
        const useId = block.tool_use_id ?? undefined;
        const node = useId != null ? toolNodeByUseId.get(useId) : undefined;
        if (node) {
          node.result = body;
          node.isError = !!block.is_error;
          node.completedAt = record.created_at;
        } else {
          const orphan: ChatToolNode = {
            key: nextKey(record.id),
            kind: 'tool',
            name: 'tool',
            input: null,
            summary: '',
            result: body,
            isError: !!block.is_error,
            startedAt: null,
            completedAt: record.created_at,
          };
          openAgentTurn(record).nodes.push(orphan);
          if (useId != null) toolNodeByUseId.set(useId, orphan);
        }
      }
      continue;
    }

    // Agent message: text, thinking, and tool calls, in block order.
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const turn = openAgentTurn(record);
    const usage = (message as { usage?: { output_tokens?: unknown } }).usage;
    if (usage && typeof usage.output_tokens === 'number') {
      turn.tokens = (turn.tokens ?? 0) + usage.output_tokens;
    }
    for (const block of content as CCContentBlock[]) {
      if (
        (block.type === 'thinking' || block.type === 'redacted_thinking') &&
        typeof block.thinking === 'string' &&
        block.thinking.trim()
      ) {
        turn.nodes.push({
          key: nextKey(record.id),
          kind: 'thinking',
          text: block.thinking.trim(),
        });
      } else if (block.type != null && TOOL_USE_BLOCK_TYPES.has(block.type)) {
        const name = block.name ?? 'tool';
        const node: ChatToolNode = {
          key: nextKey(record.id),
          kind: 'tool',
          name,
          input: block.input ?? null,
          summary: summarizeToolInput(name, block.input ?? undefined),
          result: null,
          isError: false,
          startedAt: record.created_at,
          completedAt: null,
        };
        turn.nodes.push(node);
        if (block.id) toolNodeByUseId.set(block.id, node);
      } else if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim()
      ) {
        turn.nodes.push({
          key: nextKey(record.id),
          kind: 'assistant',
          text: block.text.trim(),
        });
      }
    }
  }

  return turns;
}
