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

import type {
  CodexEvent,
  SdkRecord,
  SdkSystemRecord,
  SessionRecord,
} from '../types';
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexErrorEvent,
  CodexFileChangeItem,
  CodexItemCompletedEvent,
  CodexMcpToolCallItem,
  CodexReasoningItem,
  CodexWebSearchItem,
} from '../generated/frames';
import {
  codexChangedPaths,
  codexMcpToolName,
  oneLine,
  summarizeToolInput,
  toolResultText,
} from './transcript';
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
// marks an agent turn that woke an idle session — see the init
// tracking below.
export interface ChatTurn {
  key: string;
  role: 'assistant' | 'user' | 'lifecycle';
  nodes: ChatNode[];
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  // Rolled up for the turn's header bar. `costUsd` is THIS turn's cost, taken
  // straight off the turn's `result` record (a result's `cost_usd` is per-turn);
  // `tokens` sums the assistant records' output tokens. Null until known
  // (user turns never have them). Display-only turn arithmetic — the
  // session's authoritative totals are the session frame's cost fields (§6).
  costUsd: number | null;
  tokens: number | null;
  resumed: boolean;
  // The closing `result` record said the turn errored (is_error, or Codex's
  // turn.failed). The result is otherwise not rendered, but a failed turn is
  // content — renderers show it as an error line on the turn.
  isError: boolean;
}

// Every Claude execution opens with a `system`/`subtype:"init"` record,
// and a keyed session runs one execution per wake. So the FIRST init is the
// session starting; each LATER init means the session had gone idle/asleep and
// a message woke it — that's what marks the following agent turn `resumed`.
// `init` is the only system event that matters here; the rest (the output-/
// thinking-token and status liveness ticks, hook/task/notification signals)
// are all dropped — they aren't conversation.
const isInitEvent = (data: SdkRecord): data is SdkSystemRecord =>
  data.kind === 'system' && data.subtype === 'init';

// The sandbox spawn family — the lifecycle records that fold into one
// sandbox turn (see the lifecycle branch below).
const SANDBOX_RECORD_TYPES = new Set<string>([
  'sandbox_starting',
  'sandbox_phase',
  'sandbox_output',
  'sandbox_ready',
]);

export function groupRecordsToChatTurns(
  records: readonly SessionRecord[]
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  // tool_use id → its ChatToolNode, so a later tool_result fills the same card.
  const toolNodeByUseId = new Map<string, ChatToolNode>();
  // Your messages are drawn where you SENT them: the message_received record
  // lands the instant the inbox takes a message, while the agent's echo of it
  // can lag by a whole sandbox wake. message id → the user turn it drew, so
  // the echo is folded into it (not drawn twice) and a turn_failed on the
  // turn that took it marks the turn cancelled.
  const userTurnByMessageId = new Map<string, ChatTurn>();
  const messageIdByTurnId = new Map<string, string>();
  let seq = 0;
  const nextKey = (base: string) => `${base}:${seq++}`;

  // Index of the currently-open agent turn in `turns` (-1 = none open).
  // Tracked as an index, not a nullable closure var, so the mutations below
  // type-narrow cleanly.
  let openIdx = -1;
  // Cumulative session cost as of the previous `result` event, so each turn's
  // costUsd is its own delta rather than the running total.
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
        isError: false,
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
    if (record.record_format === 'ellipsis_lifecycle@1') {
      const messageId =
        typeof record.payload.message_id === 'string'
          ? record.payload.message_id
          : null;
      if (record.record_type === 'message_received' && messageId) {
        const body =
          typeof record.payload.body === 'string' ? record.payload.body : '';
        if (!body.trim() || userTurnByMessageId.has(messageId)) continue;
        const turn: ChatTurn = {
          resumed: false,
          isError: false,
          key: `msg:${messageId}`,
          role: 'user',
          nodes: [{ key: `msg:${messageId}`, kind: 'user', text: body.trim() }],
          startedAt: record.created_at,
          completedAt: record.created_at,
          durationMs: null,
          costUsd: null,
          tokens: null,
        };
        userTurnByMessageId.set(messageId, turn);
        turns.push(turn);
        continue;
      }
      if (record.record_type === 'message_delivered' && messageId) {
        if (typeof record.payload.turn_id === 'string')
          messageIdByTurnId.set(record.payload.turn_id, messageId);
        continue;
      }
      if (record.record_type === 'turn_failed') {
        // The turn that took a message died without answering it (the /stop
        // path, which does not requeue): the message reads as cancelled.
        const turnId =
          typeof record.payload.turn_id === 'string'
            ? record.payload.turn_id
            : null;
        const owner = turnId ? messageIdByTurnId.get(turnId) : undefined;
        const userTurn = owner ? userTurnByMessageId.get(owner) : undefined;
        if (userTurn) userTurn.isError = true;
        continue;
      }
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
        isError: false,
      });
      continue;
    }
    // Codex records: the thread/turn/item narrative maps onto the same turn
    // vocabulary — item.completed events carry the content, turn.completed
    // closes the open turn. Codex's schema is open; unknown event/item types
    // shape nothing.
    if (record.record_format === 'codex_jsonl@1') {
      codexEventIntoTurns(record, record.payload, {
        openAgentTurn,
        closeTurn: (completedAt, isError) => {
          if (openIdx >= 0) {
            turns[openIdx].completedAt = completedAt;
            if (isError) turns[openIdx].isError = true;
            openIdx = -1;
          }
        },
        nextKey,
      });
      continue;
    }

    const data = record.payload;

    if (data.kind === 'system') {
      // init = a fresh execution; the 2nd+ one means this message woke the
      // session. All other system records (hooks, task signals) are dropped;
      // liveness ticks never reach a client, the backend drops them at ingest.
      if (isInitEvent(data)) {
        initCount += 1;
        if (initCount > 1) pendingResume = true;
      }
      continue;
    }

    if (data.kind === 'result') {
      // Close the open agent turn with its duration; render nothing for it.
      if (openIdx >= 0) {
        turns[openIdx].completedAt = record.created_at;
        turns[openIdx].durationMs =
          typeof data.duration_ms === 'number' ? data.duration_ms : null;
        if (typeof data.cost_usd === 'number') {
          // A result's cost is the TURN's own, not a running session total
          // (verified against a live multi-turn session; the backend's
          // compute_spend_from_records sums them for the session figure).
          turns[openIdx].costUsd = data.cost_usd;
        }
        if (data.is_error) turns[openIdx].isError = true;
        openIdx = -1;
      }
      continue;
    }

    if (data.kind === 'user') {
      const content = data.content;
      if (typeof content === 'string') {
        // A real human message: closes the current agent turn and stands alone
        // — unless its message_received already drew it, in which case the
        // echo only closes the turn.
        if (content.trim()) {
          openIdx = -1;
          if (
            record.session_message_id != null &&
            userTurnByMessageId.has(record.session_message_id)
          )
            continue;
          turns.push({
            resumed: false,
            isError: false,
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
      // Tool results: fill the matching call's card; do NOT close the turn
      // (the call and its result are the same agent turn).
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const body = toolResultText(block.content) || '(no output)';
        const useId = block.tool_use_id;
        const node = toolNodeByUseId.get(useId);
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
          toolNodeByUseId.set(useId, orphan);
        }
      }
      continue;
    }

    // Agent record: text, thinking, and tool calls, in block order.
    if (data.kind !== 'assistant') continue;
    const turn = openAgentTurn(record);
    if (data.usage && typeof data.usage.output_tokens === 'number') {
      turn.tokens = (turn.tokens ?? 0) + data.usage.output_tokens;
    }
    for (const block of data.content) {
      if (block.type === 'thinking' && block.thinking.trim()) {
        turn.nodes.push({
          key: nextKey(record.id),
          kind: 'thinking',
          text: block.thinking.trim(),
        });
      } else if (
        block.type === 'tool_use' ||
        block.type === 'server_tool_use'
      ) {
        const node: ChatToolNode = {
          key: nextKey(record.id),
          kind: 'tool',
          name: block.name,
          input: block.input,
          summary: summarizeToolInput(block.name, block.input),
          result: null,
          isError: false,
          startedAt: record.created_at,
          completedAt: null,
        };
        turn.nodes.push(node);
        toolNodeByUseId.set(block.id, node);
      } else if (block.type === 'text' && block.text.trim()) {
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

// Shape one Codex event into the open chat turn — the codex_jsonl@1 branch of
// groupRecordsToChatTurns. Codex has no separate tool-result record (a
// command's output rides its own item), so each item becomes one already-
// complete node; turn.completed closes the turn.
function codexEventIntoTurns(
  record: SessionRecord,
  event: CodexEvent,
  ops: {
    openAgentTurn: (record: SessionRecord) => ChatTurn;
    closeTurn: (completedAt: string, isError: boolean) => void;
    nextKey: (base: string) => string;
  }
): void {
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    ops.closeTurn(record.created_at, event.type === 'turn.failed');
    return;
  }
  if (event.type === 'error') {
    const turn = ops.openAgentTurn(record);
    turn.nodes.push({
      key: ops.nextKey(record.id),
      kind: 'assistant',
      text: (event as CodexErrorEvent).message?.trim() || 'error',
    });
    return;
  }
  if (event.type !== 'item.completed') return;

  // Per-case casts as in codexEventToItems: the union's open catch-all member
  // has a non-literal `type`, which blocks TS structural narrowing.
  const item = (event as CodexItemCompletedEvent).item;
  const turn = () => ops.openAgentTurn(record);
  switch (item.type) {
    case 'agent_message': {
      const text = (item as CodexAgentMessageItem).text.trim();
      if (text)
        turn().nodes.push({
          key: ops.nextKey(record.id),
          kind: 'assistant',
          text,
        });
      break;
    }
    case 'reasoning': {
      const r = item as CodexReasoningItem;
      const text = (r.text ?? r.summary ?? '').trim();
      if (text)
        turn().nodes.push({
          key: ops.nextKey(record.id),
          kind: 'thinking',
          text,
        });
      break;
    }
    case 'command_execution': {
      const c = item as CodexCommandExecutionItem;
      turn().nodes.push({
        key: ops.nextKey(record.id),
        kind: 'tool',
        name: 'Bash',
        input: { command: c.command },
        summary: oneLine(c.command, 100),
        result: (c.aggregated_output ?? '').trim() || '(no output)',
        isError: typeof c.exit_code === 'number' && c.exit_code !== 0,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    }
    case 'file_change': {
      const paths = codexChangedPaths(item as CodexFileChangeItem);
      turn().nodes.push({
        key: ops.nextKey(record.id),
        kind: 'tool',
        name: 'Edit',
        input: null,
        summary: paths.length ? oneLine(paths.join(', '), 100) : '',
        result: null,
        isError: false,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    }
    case 'mcp_tool_call':
      turn().nodes.push({
        key: ops.nextKey(record.id),
        kind: 'tool',
        name: codexMcpToolName(item as CodexMcpToolCallItem),
        input: null,
        summary: '',
        result: null,
        isError: false,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    case 'web_search': {
      const query = (item as CodexWebSearchItem).query;
      turn().nodes.push({
        key: ops.nextKey(record.id),
        kind: 'tool',
        name: 'WebSearch',
        input: query ? { query } : null,
        summary: query ? oneLine(query, 100) : '',
        result: null,
        isError: false,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    }
    // todo_list / item error / unknown item types: nothing worth a node.
  }
}
