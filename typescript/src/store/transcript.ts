// Shape session records into renderable transcript items — the parsing layer
// behind every `agent session connect`-style transcript (the Ellipsis CLI's
// Ink view, the dashboard's session steps view).
//
// Records arrive as a discriminated union on `record_format`: a claude_sdk@1
// payload is an `SdkRecord` (discriminated by `kind`), a codex_jsonl@1 payload
// is a `CodexEvent` (discriminated by `type`), a lifecycle payload renders as
// a notice line. This module is pure (no ANSI, no DOM) — colours, glyphs, and
// layout stay in each platform's renderer. The Claude shape is closed (ours,
// versioned by record_format); Codex's is typed but open — unknown Codex
// event/item types render as nothing rather than breaking a client.

import type {
  CodexEvent,
  SdkContentBlock,
  SdkRecord,
  SessionRecord,
} from '../types';
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexErrorEvent,
  CodexErrorItem,
  CodexFileChangeItem,
  CodexItemCompletedEvent,
  CodexMcpToolCallItem,
  CodexReasoningItem,
  CodexWebSearchItem,
} from '../generated/frames';
import { lifecycleText } from './lifecycle';

// A single line of the rendered transcript. `kind` selects the colour/glyph in
// the UI; `gutter` is the leading marker (● tool, ⎿ result, › you, ✻ thinking).
// `spaceBefore` opens a blank line above to separate message-level blocks;
// grouped sub-lines (a tool's result under its call) set it false so they hug.
export type ItemKind =
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'summary'
  | 'system'
  | 'user'
  | 'notice'
  | 'error';

export interface TranscriptItem {
  key: string;
  kind: ItemKind;
  text: string;
  // Secondary, dimmed text shown after `text` on the same logical block (a
  // tool call's argument summary, a result's body).
  detail?: string;
  gutter?: string;
  spaceBefore?: boolean;
  isError?: boolean;
  // The raw tool name and input for a tool line, so a renderer can key richer
  // presentation off them (e.g. the web gutter's technology logo).
  tool?: { name: string; input?: Record<string, unknown> };
  // The work this line stands for is still running (a fold whose last call
  // has no result yet, or a trailing thinking burst while the turn works).
  // The text then carries NO trailing ellipsis: the renderer draws the
  // house "…" device — typed out dot by dot — after it.
  loading?: boolean;
}

// Collapse whitespace/newlines to one displayable line, truncated to `max`.
export function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 3)}...`;
}

// Claude-Code-style one-line summary of a tool call's arguments: the salient
// field for the common tools (a path, a command, a pattern), else compact JSON.
export function summarizeToolInput(name: string, input: unknown): string {
  const args = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;
  const tool = name.toLowerCase();

  const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  if (
    ['read', 'write', 'edit', 'multiedit', 'notebookedit'].includes(tool) &&
    path
  ) {
    return oneLine(path, 100);
  }
  if (tool === 'bash' && str(args.command))
    return oneLine(str(args.command)!, 100);
  if ((tool === 'grep' || tool === 'glob') && str(args.pattern)) {
    const where = str(args.path) ?? str(args.glob);
    return oneLine(str(args.pattern)! + (where ? ` in ${where}` : ''), 100);
  }
  if ((tool === 'task' || tool === 'agent') && str(args.description)) {
    return oneLine(str(args.description)!, 100);
  }
  if (tool === 'webfetch' && str(args.url)) return oneLine(str(args.url)!, 100);
  if (tool === 'websearch' && str(args.query))
    return oneLine(str(args.query)!, 100);

  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  return oneLine(JSON.stringify(args), 100);
}

// Human-readable duration from seconds, Claude Code style: "42s" under a
// minute, then "3m 21s". Whole seconds only ("200.7s" reads as noise).
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// Flatten a message's `content` to a block list (a bare string becomes one
// text block), so assistant and user turns share one iteration path.
function blocksOf(content: string | SdkContentBlock[]): SdkContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

// Best-effort display text for a tool_result block's content: a string, a
// list of text blocks, or arbitrary JSON. Whitespace is preserved (results are
// shown as a small indented body), only trimmed at the ends.
export function toolResultText(
  content: string | Record<string, unknown>[] | null
): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const inner of content) {
      if (typeof inner.text === 'string') parts.push(inner.text);
      else parts.push(JSON.stringify(inner));
    }
    return parts.join('\n').trim();
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

export interface EventToItemsOptions {
  // Render the `system`/`init` event as a dim "session started, model, cwd"
  // line. Default OFF: Claude Code emits an init for every message it
  // processes in stream-json mode, so terminal views that already carry the
  // model in a banner render it as pure noise; the dashboard steps view keeps
  // it as the execution boundary marker.
  systemInitLine?: boolean;
}

// Render a whole Claude record into transcript items (usually one, sometimes
// several for a multi-block assistant turn). `keyBase` makes list keys unique
// across the stream; blank when the record carries nothing worth showing.
export function eventToItems(
  event: SdkRecord,
  keyBase: string,
  options: EventToItemsOptions = {}
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const push = (item: Omit<TranscriptItem, 'key'>): void => {
    items.push({ ...item, key: `${keyBase}:${items.length}` });
  };

  // A final result record: a dim one-liner capping the turn (cost + duration).
  if (event.kind === 'result') {
    const bits: string[] = [];
    bits.push(formatDuration(event.duration_ms / 1000));
    if (typeof event.cost_usd === 'number')
      bits.push(`$${event.cost_usd.toFixed(2)}`);
    const label = event.is_error ? 'turn ended with an error' : 'turn complete';
    push({
      kind: 'summary',
      text: bits.length ? `${label}, ${bits.join(', ')}` : label,
      spaceBefore: true,
      isError: event.is_error,
    });
    return items;
  }

  // System records: only the `init` subtype ever renders (and only when the
  // view asks for it) — the CLI emits other system records (hook and task
  // signals) that carry no transcript content. Liveness ticks never reach a
  // client at all: the backend drops them before ingest.
  if (event.kind === 'system') {
    if (!options.systemInitLine || event.subtype !== 'init') return items;
    const data = event.data ?? {};
    const bits: string[] = [];
    if (typeof data.model === 'string') bits.push(data.model);
    if (typeof data.cwd === 'string') bits.push(data.cwd);
    push({
      kind: 'system',
      text: bits.length
        ? `session started, ${bits.join(', ')}`
        : 'session started',
      spaceBefore: true,
    });
    return items;
  }

  if (event.kind === 'rate_limit') return items;

  const blocks = blocksOf(event.content);

  // A user turn is either tool results (grouped under the calls above) or a
  // human message injected into the conversation.
  if (event.kind === 'user') {
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const body = toolResultText(block.content);
        push({
          kind: 'tool_result',
          gutter: '⎿',
          text: body || '(no output)',
          spaceBefore: false,
          isError: block.is_error ?? undefined,
        });
      } else if (block.type === 'text' && block.text.trim()) {
        push({
          kind: 'user',
          gutter: '›',
          text: block.text.trim(),
          spaceBefore: true,
        });
      }
    }
    return items;
  }

  // Assistant turn: text, thinking, and tool calls, in block order.
  for (const block of blocks) {
    if (block.type === 'thinking' && block.thinking.trim()) {
      push({
        kind: 'thinking',
        gutter: '✻',
        text: block.thinking.trim(),
        spaceBefore: true,
      });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      const summary = summarizeToolInput(block.name, block.input);
      push({
        kind: 'tool',
        gutter: '●',
        text: block.name,
        detail: summary ? `(${summary})` : undefined,
        spaceBefore: true,
        tool: { name: block.name, input: block.input },
      });
    } else if (block.type === 'text' && block.text.trim()) {
      push({ kind: 'assistant', text: block.text.trim(), spaceBefore: true });
    }
  }
  return items;
}

// Render a whole Codex event into transcript items — the codex_jsonl@1
// counterpart of eventToItems, mapping Codex's thread/turn/item narrative
// onto the same TranscriptItem vocabulary so every renderer handles both
// harnesses for free. Codex's schema is open: unknown event and item types
// render as nothing.
export function codexEventToItems(
  event: CodexEvent,
  keyBase: string
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const push = (item: Omit<TranscriptItem, 'key'>): void => {
    items.push({ ...item, key: `${keyBase}:${items.length}` });
  };

  if (event.type === 'turn.failed') {
    push({
      kind: 'summary',
      text: 'turn ended with an error',
      spaceBefore: true,
      isError: true,
    });
    return items;
  }
  if (event.type === 'error') {
    push({
      kind: 'error',
      text: (event as CodexErrorEvent).message?.trim() || 'error',
      spaceBefore: true,
      isError: true,
    });
    return items;
  }
  // thread.started / turn.started / turn.completed carry no transcript
  // content (usage rides the envelope's tokens_info), and item.started /
  // item.updated are progress for an item whose completion renders below —
  // showing both would duplicate every line.
  if (event.type !== 'item.completed') return items;

  // The per-case casts below (and in every switch over Codex types): the
  // union's open catch-all member has a non-literal `type`, which blocks TS
  // structural narrowing, so the tag check narrows manually.
  const item = (event as CodexItemCompletedEvent).item;
  switch (item.type) {
    case 'agent_message': {
      const text = (item as CodexAgentMessageItem).text.trim();
      if (text) push({ kind: 'assistant', text, spaceBefore: true });
      break;
    }
    case 'reasoning': {
      const r = item as CodexReasoningItem;
      const text = (r.text ?? r.summary ?? '').trim();
      if (text)
        push({ kind: 'thinking', gutter: '✻', text, spaceBefore: true });
      break;
    }
    case 'command_execution': {
      const c = item as CodexCommandExecutionItem;
      const summary = oneLine(c.command, 100);
      push({
        kind: 'tool',
        gutter: '●',
        text: 'Bash',
        detail: summary ? `(${summary})` : undefined,
        spaceBefore: true,
        tool: { name: 'Bash', input: { command: c.command } },
      });
      const output = (c.aggregated_output ?? '').trim();
      push({
        kind: 'tool_result',
        gutter: '⎿',
        text: output || '(no output)',
        spaceBefore: false,
        isError: typeof c.exit_code === 'number' && c.exit_code !== 0,
      });
      break;
    }
    case 'file_change': {
      const paths = codexChangedPaths(item as CodexFileChangeItem);
      push({
        kind: 'tool',
        gutter: '●',
        text: 'Edit',
        detail: paths.length
          ? `(${oneLine(paths.join(', '), 100)})`
          : undefined,
        spaceBefore: true,
        tool: { name: 'Edit' },
      });
      break;
    }
    case 'mcp_tool_call': {
      const name = codexMcpToolName(item as CodexMcpToolCallItem);
      push({
        kind: 'tool',
        gutter: '●',
        text: name,
        spaceBefore: true,
        tool: { name },
      });
      break;
    }
    case 'web_search': {
      const query = (item as CodexWebSearchItem).query;
      push({
        kind: 'tool',
        gutter: '●',
        text: 'WebSearch',
        detail: query ? `(${oneLine(query, 100)})` : undefined,
        spaceBefore: true,
        tool: { name: 'WebSearch' },
      });
      break;
    }
    case 'error':
      push({
        kind: 'error',
        text: (item as CodexErrorItem).message?.trim() || 'error',
        spaceBefore: true,
        isError: true,
      });
      break;
    // todo_list and unknown item types: nothing worth a transcript line.
  }
  return items;
}

// The changed file paths of a Codex file_change item, for a tool line's
// argument summary.
export function codexChangedPaths(item: CodexFileChangeItem): string[] {
  return (item.changes ?? [])
    .map((c) => (typeof c.path === 'string' ? c.path : null))
    .filter((p): p is string => p !== null);
}

// A Codex MCP call under the same mcp__server__tool name Claude uses, so
// renderers key richer presentation off one vocabulary.
export function codexMcpToolName(item: CodexMcpToolCallItem): string {
  return item.server && item.tool
    ? `mcp__${item.server}__${item.tool}`
    : (item.tool ?? 'mcp_tool_call');
}

// Render one session record into transcript items, switching on the
// envelope's record_format: claude_sdk@1 expands via eventToItems,
// codex_jsonl@1 via codexEventToItems, and a lifecycle record becomes a
// single dim notice line (the spawn/respawn/idle notifications).
export function recordToItems(
  record: SessionRecord,
  keyBase: string,
  options: EventToItemsOptions = {}
): TranscriptItem[] {
  switch (record.record_format) {
    case 'claude_sdk@1':
      return eventToItems(record.payload, keyBase, options);
    case 'codex_jsonl@1':
      return codexEventToItems(record.payload, keyBase);
    case 'ellipsis_lifecycle@1': {
      const text = lifecycleText(record.record_type, record.payload);
      return text
        ? [{ key: keyBase, kind: 'notice', text, spaceBefore: true }]
        : [];
    }
    default:
      // A record_format a newer server introduced: render nothing rather than
      // returning undefined into a caller's flatMap (§3.6).
      return [];
  }
}

// Which records a connect-style transcript renders. Claude Code records are
// the conversation; lifecycle records are filtered EXCEPT sandbox_ready — the
// one moment worth a conversation note (the box is up, work can start). The
// other lifecycle rows (starting, paused, closed, resumed) are carried by live
// activity lines / footers / exit notices instead.
export function isConnectVisibleRecord(record: SessionRecord): boolean {
  return (
    record.source !== 'lifecycle' || record.record_type === 'sandbox_ready'
  );
}

// The tool calls that are executing RIGHT NOW, inferred from the committed
// transcript: a `tool` item whose `tool_result` hasn't arrived yet is a tool
// in flight (CC's headless stream emits nothing between the call committing
// and its result landing — this inference is the only live signal). Matching
// is FIFO within the current burst; any non-tool item (prose, thinking, a
// turn's result summary, a user message) means earlier calls resolved, so the
// pending set resets — a stale unmatched call from an errored old turn can
// never read as "running" forever.
export function pendingToolCalls(items: TranscriptItem[]): TranscriptItem[] {
  let pending: TranscriptItem[] = [];
  for (const item of items) {
    if (item.kind === 'tool') pending.push(item);
    else if (item.kind === 'tool_result') pending.shift();
    else pending = [];
  }
  return pending;
}

// Whether an item is part of the agent's WORK between two things it said: a
// tool call, its result, or a ✻ thinking block. These fold together.
export function isFoldable(item: TranscriptItem): boolean {
  return (
    item.kind === 'tool' ||
    item.kind === 'tool_result' ||
    item.kind === 'thinking'
  );
}

// The one-line label for a run of agent work. Thinking is never counted: a
// run that is ONLY thinking reads "Thinking"; otherwise the label names the
// tool calls — all-Bash runs count shell commands, all-Read runs count files
// read, one other tool is named ("Ran WebFetch", "Ran WebFetch 3 times"),
// mixed runs count calls and list the tools. `settled` appends the literal
// "…" a finished thinking-only run keeps; a loading run leaves it to the
// renderer's animated device.
function foldLabel(group: TranscriptItem[], settled: boolean): string {
  const work = group.filter((i) => i.kind !== 'thinking');
  if (work.length === 0) return settled ? 'Thinking…' : 'Thinking';
  const names = [
    ...new Set(work.filter((i) => i.kind === 'tool').map((i) => i.text)),
  ];
  const n = work.filter((i) => i.kind === 'tool').length || work.length;
  const plural = n === 1 ? '' : 's';
  if (names.length === 1 && names[0] === 'Bash')
    return `Ran ${n} shell command${plural}`;
  if (names.length === 1 && names[0] === 'Read')
    return `Read ${n} file${plural}`;
  if (names.length === 1)
    return n === 1 ? `Ran ${names[0]}` : `Ran ${names[0]} ${n} times`;
  if (names.length === 0) return `Ran ${n} tool call${plural}`;
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
  return `Ran ${n} tool call${plural} (${shown})`;
}

// The one fold line standing in for a run of agent work, keyed by the run's
// first member so a renderer can open it back into its members. A run that
// is only thinking is a 'thinking' row (its mark is the brain); a run with
// tool work is a 'notice'. Renderers key off the kind, never the label.
export function foldRun(
  group: TranscriptItem[],
  loading: boolean
): TranscriptItem {
  const thinkingOnly = group.every((i) => i.kind === 'thinking');
  return {
    key: `grp:${group[0].key}`,
    kind: thinkingOnly ? 'thinking' : 'notice',
    ...(thinkingOnly ? { gutter: '✻' } : {}),
    text: foldLabel(group, !loading),
    spaceBefore: true,
    ...(loading ? { loading } : {}),
  };
}

// Collapse each maximal run of consecutive agent work (tool calls, their
// results, and thinking) into one dim summary line — the Claude-Code-app
// treatment ("Ran 8 shell commands") — so a burst of shell work reads as one
// beat of the conversation. The caller's expanded state renders the original
// items instead, restoring the full ● call / ⎿ result / ✻ thinking blocks.
//
// A fold is `loading` while its work runs: a call in it has no result yet
// (the pending call is counted in the label — "Ran 2 shell commands" with the
// dots typing while the second runs), or it is the transcript's last item,
// holds only thinking, and `working` says the turn is still in flight.
export function collapseToolRuns(
  items: TranscriptItem[],
  { working = false }: { working?: boolean } = {}
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let group: TranscriptItem[] = [];
  const flush = (trailing: boolean): void => {
    if (group.length === 0) return;
    const pending = pendingToolCalls(group).length > 0;
    const thinkingOnly = group.every((i) => i.kind === 'thinking');
    const loading = pending || (trailing && working && thinkingOnly);
    out.push(foldRun(group, loading));
    group = [];
  };
  for (const item of items) {
    if (isFoldable(item)) group.push(item);
    else {
      flush(false);
      out.push(item);
    }
  }
  flush(true);
  return out;
}

// Clamp a multi-line body to `maxLines`, appending the truncated count when
// cut — used for tool-result bodies so a huge file read stays compact.
export function clampLines(
  text: string,
  maxLines: number
): { body: string; more: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { body: text, more: 0 };
  return {
    body: lines.slice(0, maxLines).join('\n'),
    more: lines.length - maxLines,
  };
}

// The turn cost (USD) a Claude `result` record carries. null for non-result
// records or a result without a cost.
export function resultCostUsd(event: SdkRecord): number | null {
  if (event.kind !== 'result') return null;
  return typeof event.cost_usd === 'number' ? event.cost_usd : null;
}

// Fold a chronological record list into the spend a footer shows: `total` sums
// every result's cost, `lastStep` is the newest result's own. A result's
// `cost_usd` is PER-TURN, so the total is the sum and the last turn needs no
// subtraction. Both null until the first result lands. This is display-only turn
// arithmetic: the session's authoritative totals are the `session` frame's cost
// fields (§6).
export function foldCosts(events: SdkRecord[]): {
  total: number | null;
  lastStep: number | null;
} {
  let total: number | null = null;
  let lastStep: number | null = null;
  for (const event of events) {
    const cost = resultCostUsd(event);
    if (cost == null) continue;
    total = (total ?? 0) + cost;
    lastStep = cost;
  }
  return { total, lastStep };
}

// The concrete label for the ✻ activity line during INFRASTRUCTURE phases —
// the sandbox spawning/waking — where nothing else on screen moves. It
// re-renders in place as the status changes; statuses never append transcript
// lines. null for `working` (a renderer shows its own gerund there) and for
// calm states (waiting, idle, terminal), where the line hides entirely.
// Takes the server-derived surface status word (sessionStatusWord).
export function statusActivityText(status: string): string | null {
  switch (status) {
    case 'scheduled':
      return 'Waiting for a worker';
    case 'starting':
      return 'Starting sandbox';
    case 'retrying':
      return 'Retrying after a transient error';
    default:
      return null;
  }
}
