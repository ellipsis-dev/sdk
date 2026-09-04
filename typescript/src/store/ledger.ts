// The chat as a LEDGER OF ENTRIES — one per message you sent, each holding
// the agent turns that answered it — and the rows of one entry's body, ready
// to lay out. This is where a turn's work folds together and where the ONE
// live row of a running turn is decided, so a renderer only decides how a
// loading row looks (a spinner, a pulsing mark) and never which row it is.
//
// The rules of an entry's body:
//   - Runs of tool calls fold into one "Ran N …" row that opens into the
//     calls and their results. Thinking never folds: each thought is a row
//     of its own, and it cuts the run of tool calls around it.
//   - A turn with NO tool calls gets one "Thinking" row at its end — loading
//     while the turn runs, "Thought for 41s" once it is over — that opens
//     into the thoughts. It is dropped when the turn is over and the agent
//     never thought aloud.
//   - Text still streaming is an assistant row that is `loading`.
//   - A live turn has EXACTLY ONE loading row: the run whose call is still
//     out, else the streaming text, else the Thinking row, else the last row
//     of the turn (the agent is between records). A settled turn has none.

import type { ChatTurn } from './chatTurns';
import { humanDuration } from './derive';
import { chatTurnsToItems } from './layout';
import { foldRun, pendingToolCalls, type TranscriptItem } from './transcript';

// One ledger entry: the message you sent and the agent turns that answered
// it, up to your next message. `turns` is empty for a message the agent has
// not taken yet.
export interface LedgerEntry {
  key: string;
  prompt: string;
  // The turn that took the message died without answering it.
  cancelled: boolean;
  turns: ChatTurn[];
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
  for (const turn of turns) {
    if (turn.role === 'user') {
      const node = turn.nodes.find((n) => n.kind === 'user');
      entries.push({
        key: turn.key,
        prompt: node?.text ?? '',
        cancelled: turn.isError,
        turns: [],
      });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last) last.turns.push(turn);
    else preamble.push(turn);
  }
  return { preamble, entries };
}

// Seconds an entry's agent turns have run: closed turns by their result's
// duration (or their timestamps when the result carried none), the open turn
// against `now` (epoch ms).
export function entrySeconds(entry: LedgerEntry, now: number): number {
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
  // What each fold opens into, by the fold's key. A fold with no entry here
  // (a live Thinking row before any thought landed) has nothing to open.
  members: Map<string, TranscriptItem[]>;
};

// Tool runs folded; everything else, thinking included, stays a row.
function foldToolTurn(
  raw: TranscriptItem[],
  live: boolean,
  members: Map<string, TranscriptItem[]>
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: TranscriptItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const fold = foldRun(run, live && pendingToolCalls(run).length > 0);
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

// The rows of one entry's body. `live` says this entry's turn is the one
// running; `now` (epoch ms) is the clock the running turn ticks against;
// `liveText` is the response still streaming, if any.
export function entryBody(
  entry: LedgerEntry,
  {
    live,
    now,
    liveText = '',
  }: { live: boolean; now: number; liveText?: string }
): EntryBody {
  const raw = chatTurnsToItems(entry.turns);
  const members = new Map<string, TranscriptItem[]>();
  const toolRan = raw.some((i) => i.kind === 'tool');
  let items: TranscriptItem[];
  if (toolRan) {
    items = foldToolTurn(raw, live, members);
  } else {
    const thoughts = raw.filter((i) => i.kind === 'thinking');
    items = raw.filter((i) => i.kind !== 'thinking');
    const key = `grp:thought:${entry.key}`;
    if (thoughts.length) members.set(key, thoughts);
    if (live && liveText === '') {
      items.push({
        key,
        kind: 'thinking',
        text: 'Thinking',
        spaceBefore: true,
      });
    } else if (!live && thoughts.length) {
      items.push({
        key,
        kind: 'thinking',
        text: `Thought for ${humanDuration(entrySeconds(entry, now))}`,
        spaceBefore: true,
      });
    }
  }
  if (live && liveText !== '') {
    items.push({
      key: `live:${entry.key}`,
      kind: 'assistant',
      text: liveText,
      spaceBefore: true,
    });
  }
  // Exactly one loading row on a live turn, none on a settled one.
  const chosen = live ? liveRow(items, members) : -1;
  items = items.map((item, i) => {
    const { loading: _, ...rest } = item;
    return i === chosen ? { ...rest, loading: true } : rest;
  });
  return { items, members };
}

function liveRow(
  items: TranscriptItem[],
  members: Map<string, TranscriptItem[]>
): number {
  if (items.length === 0) return -1;
  const running = items.findIndex((item) => {
    const run = members.get(item.key);
    return run != null && pendingToolCalls(run).length > 0;
  });
  if (running >= 0) return running;
  // The streaming text and the Thinking row are both, by construction, the
  // last row when present; between records the last row stands in.
  return items.length - 1;
}
