// One ledger entry per user message. Active turns show messages and activity
// in order; completed turns fold their work and leave final replies visible.
// Pure presentation data shared by web and CLI, with no renderer dependencies.

import type { ChatTurn } from './chatTurns';
import { humanDuration } from './derive';
import { chatTurnsToItems } from './layout';
import { foldRun, type TranscriptItem } from './transcript';
import type { MessageProgress } from './progress';

// One ledger entry: the message you sent and the agent turns that answered
// it, up to your next message. `turns` is empty for a message the agent has
// not taken yet.
export interface LedgerEntry {
  key: string;
  prompt: string;
  createdAt?: string | null;
  // The turn that took the message died without answering it.
  cancelled: boolean;
  turns: ChatTurn[];
  progress?: MessageProgress;
}

// Chat turns as ledger entries: every user turn opens one and the agent turns
// after it fill it; turns before the first message (lifecycle notices, an
// agent that spoke unprompted) come back as the preamble.
export function splitLedger(turns: readonly ChatTurn[]): {
  preamble: ChatTurn[];
  entries: LedgerEntry[];
} {
  const preamble: ChatTurn[] = [];
  const entries: LedgerEntry[] = [];
  const entryByTurn = new Map<ChatTurn, LedgerEntry>();
  const entryByMessage = new Map<string, LedgerEntry>();
  for (const turn of turns) {
    if (turn.role === 'user') {
      const node = turn.nodes.find((n) => n.kind === 'user');
      const entry: LedgerEntry = {
        key: turn.key,
        prompt: node?.text ?? '',
        createdAt: turn.startedAt,
        cancelled: turn.isError,
        turns: [],
        ...(turn.progress ? { progress: turn.progress } : {}),
      };
      entries.push(entry);
      entryByTurn.set(turn, entry);
      if (turn.messageId) entryByMessage.set(turn.messageId, entry);
    }
  }
  let last: LedgerEntry | undefined;
  for (const turn of turns) {
    if (turn.role === 'user') {
      last = entryByTurn.get(turn);
      continue;
    }
    // Arrival order cannot tell us who an answer belongs to: another message
    // may already be queued while the current response is still streaming.
    const owner = turn.messageId ? entryByMessage.get(turn.messageId) : last;
    if (owner) owner.turns.push(turn);
    else preamble.push(turn);
  }
  return { preamble, entries };
}

// Seconds an entry's agent turns have run: closed turns by their result's
// duration (or their timestamps when the result carried none), the open turn
// against `now` (epoch ms).
export function entrySeconds(entry: LedgerEntry, now: number): number {
  if (entry.progress?.turns.length) {
    return (
      entry.progress.turns.reduce((ms, turn) => {
        if (turn.startedAt == null) return ms;
        const end =
          turn.completedAt == null ? now : Date.parse(turn.completedAt);
        return ms + Math.max(0, end - Date.parse(turn.startedAt));
      }, 0) / 1000
    );
  }
  let ms = 0;
  for (const turn of entry.turns) {
    if (turn.role !== 'assistant' || turn.startedAt == null) continue;
    if (turn.durationMs != null) ms += turn.durationMs;
    else {
      const end = turn.completedAt != null ? Date.parse(turn.completedAt) : now;
      ms += Math.max(0, end - Date.parse(turn.startedAt));
    }
  }
  return ms / 1000;
}

export type EntryBody = {
  // The rows to lay out (layOutItems) and draw, in order.
  items: TranscriptItem[];
  // What each fold opens into, by key. Work folds contain progress messages,
  // thoughts and tool folds; tool folds contain calls and results. An empty
  // live work fold has no members yet. Renderers can expand these recursively.
  members: Map<string, TranscriptItem[]>;
  // No work clock before a platform turn starts (e.g. while the VM wakes).
  seconds: number | null;
};

// A work fold is distinct from its nested tool-run folds (isToolFold).
export function isWorkFold(item: TranscriptItem): boolean {
  return item.key.startsWith('work:');
}

// Keep the familiar tool summaries inside an expanded work section.
function foldToolTurn(
  raw: TranscriptItem[],
  members: Map<string, TranscriptItem[]>
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: TranscriptItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const fold = foldRun(run, false);
    members.set(fold.key, run);
    items.push(fold);
    run = [];
  };
  for (const item of raw) {
    if (item.kind === 'tool' || item.kind === 'tool_result') run.push(item);
    else {
      flush();
      items.push(item);
    }
  }
  flush();
  return items;
}

// Codex supplies message phases. Without a phase, only the trailing prose
// of a settled turn is a reply: earlier prose describes work in progress.
// Do not promote the last progress update of a failed/cancelled turn.
function finalReplyKeys(entry: LedgerEntry, live: boolean): Set<string> {
  const keys = new Set<string>();
  for (const turn of entry.turns) {
    if (turn.role !== 'assistant') continue;
    for (const node of turn.nodes) {
      if (node.kind === 'assistant' && node.phase === 'final_answer') {
        keys.add(node.key);
      }
    }
    if (entry.cancelled || turn.isError) continue;
    if (live && turn.completedAt == null && turn.durationMs == null) continue;
    for (let i = turn.nodes.length - 1; i >= 0; i--) {
      const node = turn.nodes[i];
      if (node.kind !== 'assistant' || node.phase === 'commentary') break;
      keys.add(node.key);
      // Multiple text blocks in the final message belong together, but a
      // preceding message without intervening tools is still commentary.
      const previous = turn.nodes[i - 1];
      if (
        node.createdAt == null ||
        previous?.kind !== 'assistant' ||
        previous.createdAt !== node.createdAt
      )
        break;
    }
  }
  return keys;
}

// Readable summaries usually open with a Markdown heading. Keep the live
// status to one short plain-text line, including while that heading streams.
export function reasoningSummaryTitle(summary: string): string {
  const line = summary.trim().split(/\r?\n/, 1)[0] ?? '';
  const title = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

// Active turns show assistant text (including partial text) between tool folds.
// Settled turns keep earlier messages and activity in `members`. The work
// header keeps its key through completion and is the sole loading row.
export function entryBody(
  entry: LedgerEntry,
  {
    live,
    now,
    liveText = '',
    liveSummary = '',
  }: { live: boolean; now: number; liveText?: string; liveSummary?: string }
): EntryBody {
  live =
    live && (entry.progress === undefined || entry.progress.phase !== null);
  const raw = chatTurnsToItems(entry.turns);
  const replies = finalReplyKeys(entry, live);
  const members = new Map<string, TranscriptItem[]>();
  const items: TranscriptItem[] = [];
  const work: TranscriptItem[] = [];
  const wakeKeys = new Set(
    entry.turns.flatMap((turn) =>
      turn.nodes.flatMap((node) =>
        node.kind === 'lifecycle' &&
        (node.recordType === 'session_resumed' ||
          (node.recordType === 'session_starting' &&
            typeof node.payload?.wake_index === 'number' &&
            node.payload.wake_index > 0))
          ? [node.key]
          : []
      )
    )
  );
  const phase = entry.progress?.phase;
  const seconds =
    entry.progress &&
    !entry.progress.turns.some((turn) => turn.startedAt != null)
      ? null
      : entrySeconds(entry, now);
  const key = `work:${entry.key}`;
  const header: TranscriptItem = {
    key,
    kind: 'summary',
    text: live
      ? phase === 'waking'
        ? 'Waking session'
        : phase === 'starting'
          ? 'Starting agent'
          : phase === 'queued'
            ? 'Queued'
            : reasoningSummaryTitle(liveSummary) || 'Working'
      : seconds == null
        ? 'Session startup'
        : `Worked for ${humanDuration(seconds)}`,
    spaceBefore: true,
    ...(entry.cancelled || entry.turns.some((turn) => turn.isError)
      ? { isError: true }
      : {}),
    ...(live ? { loading: true } : {}),
  };
  if (live && (phase === undefined || phase === 'working')) {
    const visible = raw
      .filter((item) => !wakeKeys.has(item.key))
      .map(({ loading: _, ...item }) => item);
    if (liveText !== '') {
      visible.push({
        key: `live:${entry.key}`,
        kind: 'assistant',
        text: liveText,
        spaceBefore: true,
      });
    }
    return {
      items: [header, ...foldToolTurn(visible, members)],
      members,
      seconds,
    };
  }
  const addWork = (item: TranscriptItem): void => {
    if (work.length === 0) items.push(header);
    work.push(item);
  };
  for (const item of raw) {
    const { loading: _, ...settled } = item;
    if (
      !wakeKeys.has(item.key) &&
      (replies.has(item.key) ||
        !['assistant', 'thinking', 'tool', 'tool_result'].includes(item.kind))
    ) {
      items.push(settled);
    } else {
      addWork(settled);
    }
  }
  if (live && liveText !== '') {
    addWork({
      key: `live:${entry.key}`,
      kind: 'assistant',
      text: liveText,
      spaceBefore: true,
    });
  }
  if (work.length > 0) {
    members.set(key, foldToolTurn(work, members));
  } else if (live) {
    // Nothing has arrived yet; keep the same header key as work streams in.
    items.unshift(header);
  }
  return { items, members, seconds };
}
