// The connect-style transcript LAYOUT: how the shared ChatTurn grouping
// becomes the flat item list a `agent session connect` screen shows, and how
// each item is placed on it (nested under the message that produced it, or
// standing on its own). Pure — no ANSI, no DOM — so the CLI's Ink renderer and
// the dashboard's chat draw the same shape from one implementation and can
// only disagree in colour and typography.

import type { ChatTurn } from './chatTurns';
import { SESSION_WAKING, sessionLogText } from './derive';
import { isFoldable, type TranscriptItem } from './transcript';

// ---------------------------------------------------------------- glyphs
//
// The gutter marks a connect transcript uses. They are part of the shape, not
// the skin: a renderer may swap the character for an icon, but which line
// wears which mark is decided here.

// The mark on a live line — a tool call running, tokens streaming, a sandbox
// coming up. It pulses (the app's one "something is happening right now"
// signal); a settled line takes ✓, ● or ✦ instead.
export const LIVE_GLYPH = '⏺';

// Your own messages wear a BAR down their left edge rather than a mark on
// their first row — the same shape the composer you typed them into has, so a
// message looks like what it was typed in.
export const USER_BAR = '┃';

// The mark on a line nested under the message that produced it: a tool call
// the agent made while writing that message, and the result that came back.
export const BRANCH_GLYPH = '⎿';

// The sender icon: ┃ marks a message you sent, ● the assistant's prose (the
// tool-call ● is coloured differently by every renderer, so the two never read
// the same), ✦ system/notice lines — the infrastructure speaking. Everything
// else keeps the shaper's glyph (⎿ results, ✻ thinking) or none.
export function gutterFor(item: TranscriptItem): string {
  if (item.kind === 'user') return USER_BAR;
  if (item.kind === 'assistant') return '●';
  if (item.kind === 'system' || item.kind === 'notice') return '✦';
  return item.gutter ?? '';
}

// ---------------------------------------------------------------- items

// The sandbox spawn family: the startup block up top narrates these, so the
// chat skips their turns entirely. Logging them here would bury the
// conversation in provisioning noise.
const SANDBOX_RECORD_TYPES = new Set([
  'sandbox_starting',
  'sandbox_phase',
  'sandbox_output',
  'sandbox_ready',
]);

// ChatTurns as flat transcript items, in turn order — the connect screen's
// item list, derived from the SAME grouped turns a chat-style renderer uses:
// tool calls paired with their results, turns closed by their result records,
// a failed turn carrying isError.
//
// Lifecycle turns are reworded through sessionLogText (the SHORT list of
// milestones worth a chat line — asleep, waking, retrying, cancelled). A wake
// is ONE line, not two: "Session waking" (loading, the dots typing) settles
// in place to "Session awake" KEEPING ITS KEY, so a scroll anchor never
// moves. It settles on the resumed record, or on the first agent turn after
// it — a degraded wake (§8: no resumed record when the transcript was lost)
// must not leave the dots typing under an agent that is plainly answering.
//
// Your own message is drawn where you sent it (its message_received record),
// so on a wake it sits ABOVE "Session waking", which is what happened.
//
// A turn's closing result record is not itself rendered (its duration and
// cost are bookkeeping; a footer carries the spend), but a failed turn is
// content: turn.isError becomes a "turn ended with an error" line at the
// turn's end.
export function chatTurnsToItems(turns: readonly ChatTurn[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // Index of the "Session waking" line still awaiting its outcome.
  let wakeAt = -1;
  const settleWake = () => {
    if (wakeAt < 0) return;
    const { loading: _, ...settled } = items[wakeAt];
    items[wakeAt] = { ...settled, text: 'Session awake' };
    wakeAt = -1;
  };
  for (const turn of turns) {
    if (turn.role === 'assistant') settleWake();
    if (turn.role === 'lifecycle') {
      for (const node of turn.nodes) {
        if (node.kind !== 'lifecycle') continue;
        if (SANDBOX_RECORD_TYPES.has(node.recordType)) continue;
        if (node.recordType === 'session_resumed') {
          settleWake();
          continue;
        }
        const text = sessionLogText(node.recordType, node.payload ?? {});
        if (!text) continue;
        const waking = text === SESSION_WAKING;
        items.push({
          key: node.key,
          kind: 'notice',
          text,
          spaceBefore: true,
          ...(waking ? { loading: true } : {}),
        });
        wakeAt = waking ? items.length - 1 : -1;
      }
      continue;
    }
    if (turn.role === 'user') {
      for (const node of turn.nodes) {
        if (node.kind === 'user') {
          // isError on a user turn: the turn that took the message died
          // without answering it — the message reads as cancelled.
          items.push({
            key: node.key,
            kind: 'user',
            text: node.text,
            spaceBefore: true,
            ...(turn.isError ? { isError: true } : {}),
          });
        }
      }
      continue;
    }
    for (const node of turn.nodes) {
      if (node.kind === 'assistant') {
        items.push({
          key: node.key,
          kind: 'assistant',
          text: node.text,
          spaceBefore: true,
        });
      } else if (node.kind === 'thinking') {
        items.push({
          key: node.key,
          kind: 'thinking',
          gutter: '✻',
          text: node.text,
          spaceBefore: true,
        });
      } else if (node.kind === 'tool') {
        // An orphaned result (its call was never seen — replay can start
        // mid-burst) renders as the ⎿ result alone, not under a made-up call.
        const orphan =
          node.name === 'tool' &&
          node.input === null &&
          node.startedAt === null;
        if (!orphan) {
          items.push({
            key: node.key,
            kind: 'tool',
            gutter: '●',
            text: node.name,
            detail: node.summary ? `(${node.summary})` : undefined,
            spaceBefore: true,
            tool: { name: node.name, input: node.input ?? undefined },
          });
        }
        // The result rides directly under its call — the pairing is the
        // point of the ChatTurn shape. A call still running has none, which
        // is what pendingToolCalls keys the live activity line off.
        if (node.result !== null) {
          items.push({
            key: `${node.key}:r`,
            kind: 'tool_result',
            gutter: BRANCH_GLYPH,
            text: node.result || '(no output)',
            spaceBefore: false,
            isError: node.isError || undefined,
          });
        }
      }
    }
    if (turn.isError) {
      items.push({
        key: `${turn.key}:err`,
        kind: 'summary',
        text: 'turn ended with an error',
        spaceBefore: true,
        isError: true,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- placement

// Whether an item is a collapsed fold standing in for a run of tool activity
// (collapseToolRuns' "Ran N …" notice).
export function isToolFold(item: TranscriptItem): boolean {
  return item.key.startsWith('grp:');
}

// Lines that represent work the agent did rather than something it said: a
// tool call, its result, and the collapsed fold that stands in for a run of
// them (which, collapsed, also holds the run's thinking).
export function isToolActivity(item: TranscriptItem): boolean {
  return (
    item.kind === 'tool' || item.kind === 'tool_result' || isToolFold(item)
  );
}

// How each visible item is placed in the chat. Every row stands on its own:
// a tool run (the ● call, its ⎿ result, or the collapsed "Ran N …" fold
// standing in for them) keeps its own gutter mark and its own blank row, the
// same as the prose around it. A run is never indented under the message
// before it — an indented run under a message that has already scrolled by
// reads as if the message were the subject, when the run is the agent's own
// next step in the turn.
export type PlacedItem = {
  item: TranscriptItem;
  // One level in, under the message that produced it. Always false at the
  // top level; FoldMembers nests its own rows.
  nested: boolean;
  // No blank row above.
  attach: boolean;
};

export function layOutItems(items: readonly TranscriptItem[]): PlacedItem[] {
  return items.map((item) => ({ item, nested: false, attach: false }));
}

// The gutter a fold wears where it is placed: the branch glyph when it hangs
// off a message, else ● like any other line the agent owns. Not ✦ — that mark
// is the infrastructure speaking, which a fold is not.
export function foldGutter(nested: boolean): string {
  return nested ? BRANCH_GLYPH : '●';
}

// ---------------------------------------------------------------- tails

// The LAST `maxLines` lines of a body, and how many were cut above them —
// the tail idiom for command output: what a command just printed is the
// newest lines, and "… +N earlier lines" says what scrolled past. (clampLines
// is the head form, for bodies read top-down.)
export function tailLines(
  text: string,
  maxLines: number
): { body: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { body: text, hidden: 0 };
  return {
    body: lines.slice(lines.length - maxLines).join('\n'),
    hidden: lines.length - maxLines,
  };
}

// ---------------------------------------------------------------- folds

// The items each collapsed fold stands in for, keyed by the fold's key — the
// inverse of collapseToolRuns, for a renderer that can open a fold back into
// its ● calls and ⎿ results (the terminal cannot; the web can). Groups are cut
// by the same rule collapseToolRuns uses, so the keys always line up.
export function toolRunMembers(
  items: readonly TranscriptItem[]
): Map<string, TranscriptItem[]> {
  const out = new Map<string, TranscriptItem[]>();
  let group: TranscriptItem[] = [];
  const flush = (): void => {
    if (group.length > 0) out.set(`grp:${group[0].key}`, group);
    group = [];
  };
  for (const item of items) {
    if (isFoldable(item)) group.push(item);
    else flush();
  }
  flush();
  return out;
}
