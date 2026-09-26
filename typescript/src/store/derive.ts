// Session-level derivations over the committed record log — the questions a
// live transcript UI asks beyond "what was said": is a turn in flight and
// which silence is it, which sends were consumed but not yet echoed, what is
// the environment story so far, which milestones deserve a line in the chat.
// Pure record-in/value-out, shared by the CLI's Ink view and the dashboard's
// chat (they grew separate copies before this module existed).
//
// Wording is plain sentences with comma separators (`a, b`), the same in
// every renderer.

import type { SessionRecord } from '../types';
import {
  cacheTierLabel,
  environmentOutputLines,
  environmentPhaseLabel,
  turnEndedText,
} from './lifecycle';
import { statusActivityText } from './transcript';

// The structural slice these derivations read. The SDK types each harness's
// payload as its own union with no index signature, and these functions only
// ever read display fields by name across all three — so they take the slice,
// and callers pass SessionRecord arrays unchanged.
export type RecordSlice = {
  feed_seq: number;
  source: string;
  record_type: string;
  payload: Record<string, unknown>;
  // The turn the record belongs to; environment records carry the turn they
  // prepare for.
  turn_id?: string | null;
  // The inbox message a user-echo transcript record answers for (§3.3).
  session_message_id?: string | null;
};

export function recordSlice(
  records: readonly SessionRecord[]
): readonly RecordSlice[] {
  return records as unknown as readonly RecordSlice[];
}

// The turn a lifecycle record belongs to: the envelope's, else the payload's
// (turn records name their turn in both places).
function turnOf(record: RecordSlice): string | null {
  if (record.turn_id != null) return record.turn_id;
  return typeof record.payload.turn_id === 'string'
    ? record.payload.turn_id
    : null;
}

// A duration in seconds as compact human-readable components. Precision
// scales down with size: under 1s reads as milliseconds ("428ms"), under 5s
// keeps one decimal ("1.2s", trimming a trailing .0), and everything longer
// reads as whole h/m/s components with zero parts dropped ("10s", "1m 2s",
// "2m", "1h 3m 30s").
export function humanDuration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped === 0) return '0s';
  if (clamped < 1) return `${Math.round(clamped * 1000)}ms`;
  if (clamped < 5) {
    const s = clamped.toFixed(1);
    return s.endsWith('.0') ? `${Math.round(clamped)}s` : `${s}s`;
  }
  const total = Math.round(clamped);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const bits: string[] = [];
  if (h > 0) bits.push(`${h}h`);
  if (m > 0) bits.push(`${m}m`);
  if (s > 0 || bits.length === 0) bits.push(`${s}s`);
  return bits.join(' ');
}

// The session milestones worth a line in the chat log, and how each reads.
// Deliberately a SHORT list of state changes a reader would otherwise be left
// guessing about:
//   - a turn ended without answering (failed, stopped, or cancelled), with
//     the platform's explanation
//   - the conversation closed
// Everything else the lifecycle feed carries is environment detail and
// belongs to the startup block (deriveEnvironmentState), not the
// conversation — logging it would bury the chat in preparation noise.
export function sessionLogText(
  recordType: string,
  payload: Record<string, unknown>
): string | null {
  switch (recordType) {
    case 'turn_ended':
      return turnEndedText(payload);
    case 'session_closed':
      return 'Conversation closed';
    default:
      return null;
  }
}

// Whether a turn is IN FLIGHT (a turn_started record without its turn_ended),
// and which silence it is: 'boot' when the harness has emitted NOTHING since
// its environment came up — the agent process is still starting, the dead
// air after a send lands a fresh environment's first turn — vs 'turn', a
// running turn's lull between records. null when no turn is in flight, which
// INCLUDES a session sitting between turns waiting for its next message (no
// turn, no agent process — nothing to narrate). Drives the fallback live
// line so a send never looks like the app hung.
export function awaitingAgentPhase(
  records: readonly RecordSlice[]
): 'boot' | 'turn' | null {
  let inFlight = false;
  let sawAgent = false;
  for (const r of records) {
    if (r.source !== 'lifecycle') {
      sawAgent = true;
      continue;
    }
    switch (r.record_type) {
      case 'turn_started':
        inFlight = true;
        break;
      case 'turn_ended':
        inFlight = false;
        break;
      case 'environment_phase':
      case 'environment_output':
      case 'environment_ready':
        // A fresh environment: the harness must boot again before it speaks.
        sawAgent = false;
        break;
    }
  }
  if (!inFlight) return null;
  return sawAgent ? 'turn' : 'boot';
}

// Sends the agent has TAKEN but not yet echoed into the transcript: each
// message_received body, walked through delivered/requeued transitions, minus
// the ids whose user-echo record (session_message_id back-reference) has
// landed. The store's pending set drops a message the instant it's delivered,
// but the agent's echo record can lag by a whole environment start — without
// this bridge a send flashes and vanishes for the gap.
//
// `cancelled` means the turn that took the message ENDED without answering it
// (failed, stopped, or cancelled): the message is consumed, the answer never
// comes. A message_requeued instead puts the message back in the inbox, so
// it is queued again, not cancelled.
export function deliveredUnechoedSends(
  records: readonly RecordSlice[]
): { id: string; body: string; cancelled: boolean }[] {
  const received = new Map<string, string>();
  // Message id -> the turn that consumed it, for the turn_ended correlation.
  const delivered = new Map<string, string>();
  const unanswered = new Set<string>();
  const echoed = new Set<string>();
  for (const r of records) {
    if (r.session_message_id != null) echoed.add(r.session_message_id);
    if (r.source !== 'lifecycle') continue;
    if (r.record_type === 'turn_ended') {
      if (
        typeof r.payload.turn_id === 'string' &&
        r.payload.status !== 'completed'
      )
        unanswered.add(r.payload.turn_id);
      continue;
    }
    const id =
      typeof r.payload.message_id === 'string' ? r.payload.message_id : null;
    if (!id) continue;
    if (r.record_type === 'message_received') {
      if (!received.has(id))
        received.set(
          id,
          typeof r.payload.body === 'string' ? r.payload.body : ''
        );
    } else if (r.record_type === 'message_delivered') {
      delivered.set(
        id,
        typeof r.payload.turn_id === 'string' ? r.payload.turn_id : ''
      );
    } else if (r.record_type === 'message_requeued') delivered.delete(id);
  }
  const out: { id: string; body: string; cancelled: boolean }[] = [];
  for (const [id, body] of received) {
    const turnId = delivered.get(id);
    if (turnId === undefined || echoed.has(id)) continue;
    out.push({ id, body, cancelled: unanswered.has(turnId) });
  }
  return out;
}

// One line of the environment log: a milestone (a phase opening or closing,
// the environment coming up) or a line of output from whatever the
// environment was running. They all live in ONE flat list in feed order,
// because that is how they happened and how you read them.
//
// `step` is an open milestone; `done`/`failed` a closed one; `output` a line
// the environment printed. Exactly ONE line is ever `loading` — the innermost
// open milestone, the thing happening right now, the one a renderer marks
// live. An open milestone whose sub-step is still running is a heading over
// the work below it and carries no mark.
export type EnvironmentLogKind = 'step' | 'output' | 'done' | 'failed';

export type EnvironmentLogLine = {
  key: string;
  kind: EnvironmentLogKind;
  text: string;
  loading?: boolean;
};

// The environment story as a FLAT LOG. Every milestone and every line of
// build/setup output goes into one ordered list; a renderer shows the tail of
// it (lastLines) while the environment comes up, under the live headline
// (startupHeadline), and the settled summary (environmentSummary) after.
export type EnvironmentState = {
  // Whether the preparation is over: the environment came up
  // (environment_ready), the turn it prepared for started or ended without
  // that record, or the conversation closed.
  done: boolean;
  // How long the environment took to come up, from environment_ready. null
  // until then, or when the record carried no duration — the settled summary
  // then drops the duration rather than inventing one.
  readySeconds: number | null;
  // Everything that happened during this preparation, oldest first.
  log: EnvironmentLogLine[];
};

// The live headline's text while an environment comes up.
const PREPARING_ENVIRONMENT = 'Preparing environment';

function msLabel(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  return humanDuration(ms / 1000);
}

// The image phase's preparation sub-steps as sentences: the dockerfile build,
// the container start (minutes for a multi-GB image), and the post-create
// smoke test. The step vocabulary is open by contract, so unknown steps pass
// through verbatim.
function imageStepLabel(step: string): string {
  switch (step) {
    case 'build':
      return 'Building image';
    case 'container':
      return 'Starting container';
    case 'smoke':
      return 'Smoke check';
    default:
      return step;
  }
}

// An environment_output step identifier — payload.step ?? payload.phase — as
// a human preparation-phase label. Steps are null/'post_start'/'post_clone'
// and phases 'setup'/'clone'/'hooks'; 'image.setup' is the legacy image step.
// Unknown values pass through verbatim (§3.6).
export function hookPhrase(step: string): string {
  switch (step) {
    case 'setup':
    case 'image.setup':
      return 'Building image';
    case 'clone':
      return 'Fetching repositories';
    case 'post_start':
      return 'Post-start setup';
    case 'post_clone':
      return 'Post-clone setup';
    default:
      return step;
  }
}

// Human label for a timeline step: hooks sub-items keep their hook phrasing,
// image sub-items read as sentences, other sub-items (a clone's
// "owner/repo") read as themselves, whole phases go through the open-
// vocabulary phase labels.
function stepLabel(phase: string, step: string | null): string {
  if (step) {
    if (phase === 'hooks') return hookPhrase(step);
    if (phase === 'image') return imageStepLabel(step);
    return step;
  }
  return environmentPhaseLabel(phase);
}

// The environment story from the lifecycle records of the LATEST preparation:
// ONE FLAT LOG of everything that happened on the way up, in feed order —
// each phase opening and closing (with its cache tier and duration) and every
// line of output those phases produced (image builds, clones, the customer's
// hooks).
//
// Environment records carry the turn they prepare for, so a record for a
// later turn begins a fresh story and drops the previous one's log rather
// than appending to it. null when no environment record has been seen.
// Records at or below `minFeedSeq` are skipped (a caller replaying from a
// cursor).
export function deriveEnvironmentState(
  records: readonly RecordSlice[],
  minFeedSeq: number
): EnvironmentState | null {
  let seen = false;
  let done = false;
  let readySeconds: number | null = null;
  let log: EnvironmentLogLine[] = [];
  // Phases still open, so a `completed`/`failed` transition can close the line
  // it opened rather than adding a second one.
  let open = new Map<string, EnvironmentLogLine>();
  // The turn the current story prepares for.
  let storyTurn: string | null = null;
  const push = (
    record: RecordSlice,
    kind: EnvironmentLogKind,
    text: string
  ): EnvironmentLogLine => {
    const entry = { key: `${record.feed_seq}:${log.length}`, kind, text };
    log.push(entry);
    return entry;
  };
  // Every environment record belongs to the story of the turn it prepares
  // for; one for another turn starts over.
  const begin = (record: RecordSlice): void => {
    const turn = turnOf(record);
    if (seen && turn !== storyTurn) {
      log = [];
      open = new Map();
      done = false;
      readySeconds = null;
    }
    seen = true;
    storyTurn = turn;
  };

  for (const record of records) {
    if (record.feed_seq <= minFeedSeq || record.source !== 'lifecycle')
      continue;
    const p = record.payload;
    switch (record.record_type) {
      case 'environment_phase': {
        begin(record);
        const phase =
          typeof p.phase === 'string' && p.phase ? p.phase : 'setup';
        const step = typeof p.step === 'string' && p.step ? p.step : null;
        const key = step ? `${phase}:${step}` : phase;
        const label = stepLabel(phase, step);
        if (p.status === 'completed' || p.status === 'failed') {
          const detail =
            p.detail && typeof p.detail === 'object'
              ? (p.detail as Record<string, unknown>)
              : {};
          // "Preparing image, full build, 2s" — the label then its readout.
          const tier = cacheTierLabel(detail.cache_tier);
          const dur = msLabel(p.duration_ms);
          const failed = p.status === 'failed';
          const base = failed ? `${label} failed` : label;
          const text = [
            base,
            ...(tier ? [tier] : []),
            ...(dur ? [dur] : []),
          ].join(', ');
          const line = open.get(key);
          if (line) {
            // Close the line this phase opened, in place: one line per phase,
            // not an opening line and a closing one.
            line.kind = failed ? 'failed' : 'done';
            line.text = text;
            open.delete(key);
          } else {
            push(record, failed ? 'failed' : 'done', text);
          }
        } else if (!open.has(key)) {
          open.set(key, push(record, 'step', `${label}…`));
        }
        break;
      }
      case 'environment_output': {
        begin(record);
        for (const l of environmentOutputLines(p)) push(record, 'output', l);
        break;
      }
      case 'environment_ready': {
        begin(record);
        // Anything still open finished when the environment came up.
        for (const [, line] of open) line.kind = 'done';
        open = new Map();
        const seconds =
          typeof p.duration_ms === 'number' &&
          isFinite(p.duration_ms) &&
          p.duration_ms > 0
            ? p.duration_ms / 1000
            : null;
        push(
          record,
          'done',
          seconds == null
            ? 'Environment ready'
            : `Environment ready, ${humanDuration(seconds)}`
        );
        readySeconds = seconds;
        done = true;
        break;
      }
      case 'turn_started':
      case 'turn_ended':
        // The turn this story prepared for is under way or over: the
        // preparation is done even when no environment_ready record said so.
        if (seen && turnOf(record) === storyTurn) done = true;
        break;
      case 'session_closed':
        if (seen) done = true;
        break;
      default:
        break;
    }
  }
  // Only the innermost open milestone is live; the ones it sits inside are
  // headings over it until it closes and they become the live line again.
  const openLines = [...open.values()];
  if (openLines.length) openLines[openLines.length - 1].loading = true;
  return seen ? { done, readySeconds, log } : null;
}

// Whether the startup block has settled into its one-line summary: the
// preparation is over AND the turn status word is not narrating a new one (a
// later turn's status flips to pending before its environment records land).
export function startupSettled(
  environment: EnvironmentState | null,
  status: string
): boolean {
  return (environment?.done ?? false) && statusActivityText(status) == null;
}

// The live line above the environment log, ending in the house "…": the
// status word's activity when the feed's story is over or absent (a pending
// turn whose environment records have not landed yet), else the story's own
// headline.
export function startupHeadline(
  environment: EnvironmentState | null,
  status: string
): string {
  const text =
    !environment || environment.done
      ? (statusActivityText(status) ?? PREPARING_ENVIRONMENT)
      : PREPARING_ENVIRONMENT;
  return `${text}…`;
}

// The whole preparation compressed to one line, for the settled block: how
// long the environment took. Falls back to "Environment ready" when no timing
// can be derived — an environment_ready record that carried no duration, or a
// story that settled without one.
export function environmentSummary(
  environment: EnvironmentState | null
): string {
  const seconds = environment?.readySeconds ?? null;
  return seconds
    ? `Environment ready in ${humanDuration(seconds)}`
    : 'Environment ready';
}

// The tail of the environment log: the last `max` lines, which is what you
// want while an environment comes up — the newest output, not the oldest.
export function lastLines(
  log: readonly EnvironmentLogLine[],
  max: number
): EnvironmentLogLine[] {
  return log.length <= max ? [...log] : log.slice(log.length - max);
}
