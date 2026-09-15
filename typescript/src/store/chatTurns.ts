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

import { claudePayload } from './claude';
import { codexAppServerContent } from './codexAppServer';
import { messageProgress, type MessageProgress } from './progress';
import type { CodexAgentMessage } from '../generated/frames';
import type {
  CodexEvent,
  SdkRecord,
  SdkSystemRecord,
  SessionRecord,
  Session,
} from '../types';
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
  // Native result metadata, including Claude's structured file patches.
  resultDetails?: unknown;
  isError: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export type ChatNode =
  | {
      key: string;
      kind: 'assistant';
      text: string;
      createdAt?: string;
      // Native message intent, when supplied. Older records omit it.
      phase?: CodexAgentMessage['phase'];
    }
  | { key: string; kind: 'thinking'; text: string; createdAt?: string }
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
  // Durable ownership, independent of when queued messages appear in the feed.
  messageId?: string;
  turnId?: string;
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
  // User-message ownership and timing from platform events, even before
  // there is an assistant content turn to display.
  progress?: MessageProgress;
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
  records: readonly SessionRecord[],
  session?: {
    claude_code?: { prompt?: string | null } | null;
    codex?: { prompt?: string | null } | null;
    lifecycle: {
      timestamps: Pick<Session['lifecycle']['timestamps'], 'created_at'>;
    };
  } | null
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  // tool_use id → its ChatToolNode, so a later tool_result fills the same card.
  const toolNodeByUseId = new Map<string, ChatToolNode>();
  // Your messages are drawn where you SENT them: the message_received record
  // lands the instant the inbox takes a message, while the agent's echo of it
  // can lag by a whole sandbox wake. message id → the user turn it drew, so
  // the echo is folded into it (not drawn twice). A failed delivery marks
  // the message cancelled only while it has not been requeued or redelivered.
  const userTurnByMessageId = new Map<string, ChatTurn>();
  const deliveredTurnByMessageId = new Map<string, string>();
  const failedTurnIds = new Set<string>();
  const activeMessageByTurnId = new Map<string, string>();
  let lastDeliveredMessageId: string | undefined;
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
  const openSessionTurn = (record: SessionRecord): ChatTurn => {
    const messageId =
      (record.turn_id
        ? activeMessageByTurnId.get(record.turn_id)
        : undefined) ?? lastDeliveredMessageId;
    if (
      openIdx >= 0 &&
      (turns[openIdx].turnId !== (record.turn_id ?? undefined) ||
        turns[openIdx].messageId !== messageId)
    ) {
      openIdx = -1;
    }
    if (openIdx < 0) {
      turns.push({
        key: nextKey(record.id),
        messageId,
        turnId: record.turn_id ?? undefined,
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
    if (record.kind === 'platform') {
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
          messageId,
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
        if (typeof record.payload.turn_id === 'string') {
          deliveredTurnByMessageId.set(messageId, record.payload.turn_id);
          activeMessageByTurnId.set(record.payload.turn_id, messageId);
          lastDeliveredMessageId = messageId;
        }
        continue;
      }
      if (record.record_type === 'message_requeued' && messageId) {
        deliveredTurnByMessageId.delete(messageId);
        continue;
      }
      if (record.record_type === 'turn_failed') {
        if (typeof record.payload.turn_id === 'string')
          failedTurnIds.add(record.payload.turn_id);
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
    if (record.session_message_id) {
      lastDeliveredMessageId = record.session_message_id;
      if (record.turn_id)
        activeMessageByTurnId.set(record.turn_id, record.session_message_id);
    }
    // Codex records: the thread/turn/item narrative maps onto the same turn
    // vocabulary — item.completed events carry the content, turn.completed
    // closes the open turn. Codex's schema is open; unknown event/item types
    // shape nothing.
    if (record.kind === 'codex') {
      codexEventIntoTurns(record, record.payload, {
        openSessionTurn,
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

    if (record.kind === 'codex_app_server') {
      const content = codexAppServerContent(record.payload);
      if (!content) continue;
      if (content.kind === 'end') {
        if (openIdx >= 0) {
          turns[openIdx].completedAt = record.created_at;
          if (content.isError) turns[openIdx].isError = true;
          openIdx = -1;
        }
      } else if (content.kind === 'tool') {
        openSessionTurn(record).nodes.push({
          key: nextKey(record.id),
          kind: 'tool',
          name: content.name,
          input: content.input,
          summary: oneLine(content.summary, 100),
          result: content.result,
          isError: content.isError,
          startedAt: record.created_at,
          completedAt: record.created_at,
        });
      } else if (content.text.trim()) {
        const turn = openSessionTurn(record);
        if (content.kind === 'error') turn.isError = true;
        turn.nodes.push({
          key: nextKey(record.id),
          kind: content.kind === 'error' ? 'assistant' : content.kind,
          text: content.text.trim(),
          createdAt: record.created_at,
          ...(content.kind === 'assistant' && content.phase != null
            ? { phase: content.phase }
            : {}),
        });
      }
      continue;
    }

    const data = claudePayload(record);
    if (!data) continue;

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
        const body = toolResultText(block.content ?? null) || '(no output)';
        const useId = block.tool_use_id;
        const node = toolNodeByUseId.get(useId);
        if (node) {
          node.result = body;
          if (record.kind === 'claude_code' || record.kind === 'claude_sdk') {
            node.resultDetails = record.payload.tool_use_result;
          }
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
          openSessionTurn(record).nodes.push(orphan);
          toolNodeByUseId.set(useId, orphan);
        }
      }
      continue;
    }

    // Agent record: text, thinking, and tool calls, in block order.
    if (data.kind !== 'assistant') continue;
    const turn = openSessionTurn(record);
    if (data.usage && typeof data.usage.output_tokens === 'number') {
      turn.tokens = (turn.tokens ?? 0) + data.usage.output_tokens;
    }
    for (const block of data.content ?? []) {
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
          input: block.input ?? null,
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
          createdAt: record.created_at,
        });
      }
    }
  }

  for (const [messageId, turnId] of deliveredTurnByMessageId) {
    const turn = userTurnByMessageId.get(messageId);
    if (turn) turn.isError = failedTurnIds.has(turnId);
  }
  for (const [messageId, progress] of messageProgress(records)) {
    const turn = userTurnByMessageId.get(messageId);
    if (turn) turn.progress = progress;
  }
  // The opening prompt is saved on the session before its inbox row exists.
  // Turn zero's first delivery identifies that row, even in historical feeds
  // where follow-ups were recorded first. Never deduplicate by message text.
  const initialTurn = records.find(
    (r) =>
      r.kind === 'platform' &&
      r.record_type === 'turn_started' &&
      r.payload.turn_index === 0
  );
  const initialDelivery =
    initialTurn &&
    records.find(
      (r) =>
        r.kind === 'platform' &&
        r.record_type === 'message_delivered' &&
        r.payload.turn_id ===
          (initialTurn.turn_id ?? initialTurn.payload.turn_id)
    );
  const initialReceived =
    initialTurn &&
    records.find(
      (r) =>
        r.kind === 'platform' &&
        r.record_type === 'message_received' &&
        r.turn_id === (initialTurn.turn_id ?? initialTurn.payload.turn_id)
    );
  const initialMessage = initialReceived ?? initialDelivery;
  const initialId =
    initialMessage?.kind === 'platform' &&
    typeof initialMessage.payload.message_id === 'string'
      ? initialMessage.payload.message_id
      : undefined;
  const opening = initialId ? userTurnByMessageId.get(initialId) : undefined;
  const includesStart =
    records.length === 0 ||
    records.some((r) => r.record_type === 'session_scheduled');
  const prompt = (session?.claude_code ?? session?.codex)?.prompt;
  if (prompt?.trim() && session && (opening || includesStart)) {
    const first: ChatTurn = opening ?? {
      key: 'prompt',
      role: 'user',
      nodes: [{ key: 'prompt', kind: 'user', text: prompt }],
      startedAt: session.lifecycle.timestamps.created_at,
      completedAt: session.lifecycle.timestamps.created_at,
      durationMs: null,
      costUsd: null,
      tokens: null,
      resumed: false,
      isError: false,
      progress: { phase: 'starting', turns: [] },
    };
    if (opening) turns.splice(turns.indexOf(opening), 1);
    first.key = 'prompt';
    first.startedAt = session.lifecycle.timestamps.created_at;
    turns.unshift(first);
    if (!opening) {
      for (const turn of turns) {
        if (
          turn !== first &&
          turn.role === 'user' &&
          turn.progress &&
          !turn.progress.turns.length
        ) {
          turn.progress.phase = turn.progress.phase === null ? null : 'queued';
        }
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
    openSessionTurn: (record: SessionRecord) => ChatTurn;
    closeTurn: (completedAt: string, isError: boolean) => void;
    nextKey: (base: string) => string;
  }
): void {
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    ops.closeTurn(record.created_at, event.type === 'turn.failed');
    return;
  }
  if (event.type === 'error') {
    const turn = ops.openSessionTurn(record);
    turn.nodes.push({
      key: ops.nextKey(record.id),
      kind: 'assistant',
      text: event.message?.trim() || 'error',
      createdAt: record.created_at,
    });
    return;
  }
  if (event.type !== 'item.completed') return;

  const item = event.item;
  const turn = () => ops.openSessionTurn(record);
  switch (item.type) {
    case 'agent_message': {
      const text = (item.text ?? '').trim();
      if (text)
        turn().nodes.push({
          key: ops.nextKey(record.id),
          kind: 'assistant',
          text,
          createdAt: record.created_at,
        });
      break;
    }
    case 'reasoning': {
      const r = item;
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
      const c = item;
      turn().nodes.push({
        key: ops.nextKey(record.id),
        kind: 'tool',
        name: 'Bash',
        input: { command: c.command },
        summary: oneLine(c.command ?? '', 100),
        result: (c.aggregated_output ?? '').trim() || '(no output)',
        isError: typeof c.exit_code === 'number' && c.exit_code !== 0,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    }
    case 'file_change': {
      const paths = codexChangedPaths(item);
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
        name: codexMcpToolName(item),
        input: null,
        summary: '',
        result: null,
        isError: false,
        startedAt: record.created_at,
        completedAt: record.created_at,
      });
      break;
    case 'web_search': {
      const query = item.query;
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
