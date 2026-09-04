// Session-level derivations over the committed record log — the questions a
// live transcript UI asks beyond "what was said": is a turn in flight and
// which silence is it, which sends were consumed but not yet echoed, what is
// the startup story so far, which lifecycle milestones deserve a line in the
// chat. Pure record-in/value-out, shared by the CLI's Ink view and the
// dashboard's chat (they grew separate copies before this module existed).
//
// Wording is plain sentences with comma separators (`a, b`), the same in
// every renderer.

import type { SessionRecord } from '../types';
import {
  cacheTierLabel,
  lifecycleText,
  sandboxOutputLines,
  sandboxPhaseLabel,
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
  // The inbox message a user-echo transcript record answers for (§3.3).
  session_message_id?: string | null;
};

export function recordSlice(
  records: readonly SessionRecord[]
): readonly RecordSlice[] {
  return records as unknown as readonly RecordSlice[];
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
//   - the session parked between turns
//   - it is coming back up (a wake, or an infra retry after a wobble)
//   - it was stopped or cancelled
// Everything else the lifecycle feed carries is startup detail and belongs to
// a startup block (deriveSandboxState), not the conversation — logging it
// would bury the chat in provisioning noise.
//
// `session_ready`-style milestones are deliberately absent for a FIRST start:
// the startup block already tells that story in place. A wake is different —
// it happens long after the block settled, mid-conversation.
// The wake line's text while the wake runs. No trailing "…": the line is
// `loading` and the renderer types the house dots after it.
export const SESSION_WAKING = 'Session waking';

export function sessionLogText(
  recordType: string,
  payload: Record<string, unknown>
): string | null {
  const p = payload;
  switch (recordType) {
    case 'session_idle':
      return 'Session asleep';
    case 'session_starting': {
      // Only a WAKE is logged: the first start is the startup block's story.
      const wake = typeof p.wake_index === 'number' ? p.wake_index : 0;
      const attempt = typeof p.attempt === 'number' ? p.attempt : 0;
      if (attempt > 0) return 'Restarting the sandbox after a transient error…';
      return wake > 0 ? SESSION_WAKING : null;
    }
    case 'session_retrying':
      return typeof p.reason === 'string' && p.reason
        ? `Retrying, ${p.reason}`
        : 'Retrying after a transient error…';
    case 'session_resumed':
      return 'Session awake';
    case 'session_cancelled': {
      const reason =
        typeof p.reason === 'string' && p.reason ? `, ${p.reason}` : '';
      return `Session cancelled${reason}`;
    }
    default:
      return null;
  }
}

// Whether a turn is IN FLIGHT (a turn_started record without its
// turn_completed/turn_failed), and which silence it is: 'boot' when the
// harness has emitted NOTHING this execution — the agent process is still
// starting up in the sandbox, the ~15-20s dead air after a send lands a fresh
// execution's first turn — vs 'turn', a running turn's lull between records.
// null when no turn is in flight, which INCLUDES the bare interactive
// session sitting at 'working' status waiting for its first message (no
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
    } else {
      if (r.record_type === 'turn_started') inFlight = true;
      else if (
        r.record_type === 'turn_completed' ||
        r.record_type === 'turn_failed'
      ) {
        inFlight = false;
      } else if (
        r.record_type === 'session_starting' ||
        r.record_type === 'session_retrying'
      ) {
        // A fresh execution: no turn is in flight and the harness must boot
        // again before it speaks.
        inFlight = false;
        sawAgent = false;
      }
    }
  }
  if (!inFlight) return null;
  return sawAgent ? 'turn' : 'boot';
}

// Sends the agent has TAKEN but not yet echoed into the transcript: each
// message_received body, walked through delivered/requeued transitions, minus
// the ids whose user-echo record (session_message_id back-reference) has
// landed. The store's pending set drops a message the instant it's delivered,
// but the agent's echo record can lag by a whole sandbox wake — without this
// bridge a send flashes and vanishes for the gap.
//
// `cancelled` means the turn that took the message DIED without answering it —
// the /stop path, where the backend deliberately does not requeue an
// interrupted turn's messages (the message is consumed, the answer never
// comes). A message_requeued instead puts the message back in the inbox, so
// it is queued again, not cancelled.
export function deliveredUnechoedSends(
  records: readonly RecordSlice[]
): { id: string; body: string; cancelled: boolean }[] {
  const received = new Map<string, string>();
  // Message id -> the turn that consumed it, for the turn_failed correlation.
  const delivered = new Map<string, string>();
  const failedTurns = new Set<string>();
  const echoed = new Set<string>();
  for (const r of records) {
    if (r.session_message_id != null) echoed.add(r.session_message_id);
    if (r.source !== 'lifecycle') continue;
    if (r.record_type === 'turn_failed') {
      if (typeof r.payload.turn_id === 'string')
        failedTurns.add(r.payload.turn_id);
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
    out.push({ id, body, cancelled: failedTurns.has(turnId) });
  }
  return out;
}

// One line of the startup log: a milestone (a phase opening or closing, the
// config resolving, the box coming up) or a line of output from whatever the
// sandbox was running. They all live in ONE flat list in feed order, because
// that is how they happened and how you read them.
//
// `step` is an open milestone; `done`/`failed` a closed one; `output` a line
// the sandbox printed. Exactly ONE line is ever `loading` — the innermost
// open milestone, the thing happening right now, the one a renderer marks
// live. An open milestone whose sub-step is still running is a heading over
// the work below it and carries no mark.
export type SandboxLogKind = 'step' | 'output' | 'done' | 'failed';

export type SandboxLogLine = {
  key: string;
  kind: SandboxLogKind;
  text: string;
  loading?: boolean;
};

// The startup story as a HEADLINE plus a FLAT LOG. Every milestone and every
// line of build/setup output goes into one ordered list; a renderer shows the
// tail of it (lastLines) while the session comes up.
export type SandboxState = {
  // The current LIVE top-level line ("Session scheduled…", "Starting
  // sandbox…", "Waking the session…", "Retrying…"). Read only while the block
  // is still moving: once it settles the block shows its static summary
  // instead, so a session that later falls asleep doesn't rewrite its own
  // opening line. Renderers go through startupHeadline, which folds the live
  // status word in.
  headline: string;
  done: boolean;
  // How long the sandbox took to come up, when the feed says (sandbox_ready's
  // phase_timings). null on a wake or an old feed that carried no timings —
  // the settled summary drops the duration rather than inventing one.
  readySeconds: number | null;
  // Whether the sandbox itself has finished provisioning, so the log's live
  // lines stop pulsing.
  sandboxDone: boolean;
  // The agent config resolved at scheduling, held apart from the log because
  // it outlives a restart: the log drops on a retry/wake, but which config the
  // session runs is still true. Rendered as the log's first line.
  configName: string | null;
  // The commit of the config file in the repo it's owned at (the sync
  // provenance), when the backend sends it. Shortened for display.
  configCommitSha: string | null;
  // Everything that happened during this start, oldest first.
  log: SandboxLogLine[];
};

// The live headline's resting text — a fresh first start.
const STARTING_SANDBOX = 'Starting sandbox…';

function msLabel(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  return humanDuration(ms / 1000);
}

// The image phase's provisioning sub-steps as sentences: the dockerfile
// build, the container start (minutes for a multi-GB image), and the
// post-create smoke test. The step vocabulary is open by contract, so unknown
// steps pass through verbatim.
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

// A sandbox_output step identifier — payload.step ?? payload.phase — as a
// human startup-phase label. Steps are null/'post_start'/'post_clone' and
// phases 'setup'/'clone'/'hooks'; 'image.setup' is the legacy image step.
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
  return sandboxPhaseLabel(phase);
}

// The startup story from the lifecycle records of the LATEST start: a live
// headline for while it is still coming up ("Session scheduled…" → "Starting
// sandbox…" / "Waking…" / "Retrying…"), plus ONE FLAT LOG of everything
// that happened on the way up, in feed order — the config resolving, each
// provisioning phase opening and closing (with its cache tier and duration),
// and every line of output those phases produced (image builds, clones, setup
// hooks).
//
// The headline tracks the START only, never later session status: session_idle
// is a mid-conversation event with its own transcript line (sessionLogText),
// and folding it in here made an old session open with "Session asleep" as
// its first line.
//
// session_starting begins a fresh story: a wake or an infra retry drops the
// previous start's log rather than appending to it. null when no lifecycle
// record has been seen. Records at or below `minFeedSeq` are skipped (a
// caller replaying from a cursor).
export function deriveSandboxState(
  records: readonly RecordSlice[],
  minFeedSeq: number
): SandboxState | null {
  let seen = false;
  let headline = STARTING_SANDBOX;
  let done = false;
  let sandboxDone = false;
  let readySeconds: number | null = null;
  let configName: string | null = null;
  let configCommitSha: string | null = null;
  let log: SandboxLogLine[] = [];
  // Phases still open, so a `completed`/`failed` transition can close the line
  // it opened rather than adding a second one.
  let open = new Map<string, SandboxLogLine>();
  const push = (
    record: RecordSlice,
    kind: SandboxLogKind,
    text: string
  ): SandboxLogLine => {
    const entry = { key: `${record.feed_seq}:${log.length}`, kind, text };
    log.push(entry);
    return entry;
  };
  const reset = (): void => {
    log = [];
    open = new Map();
    sandboxDone = false;
  };

  for (const record of records) {
    if (record.feed_seq <= minFeedSeq || record.source !== 'lifecycle')
      continue;
    const p = record.payload;
    switch (record.record_type) {
      case 'session_scheduled': {
        seen = true;
        headline = 'Session scheduled…';
        done = false;
        configName =
          typeof p.config_name === 'string' && p.config_name
            ? p.config_name
            : null;
        configCommitSha =
          typeof p.config_commit_sha === 'string' && p.config_commit_sha
            ? p.config_commit_sha
            : null;
        break;
      }
      case 'session_starting':
      case 'session_retrying': {
        seen = true;
        // Every claim starts a fresh story: the headline takes over and the
        // previous start's log drops. A fresh first start is the one line the
        // lifecycle wording ("Session starting…") doesn't match — this block
        // is the SANDBOX coming up, and the headline names that.
        const text = lifecycleText(record.record_type, p);
        headline =
          !text || text === 'Session starting…' ? STARTING_SANDBOX : text;
        done = false;
        readySeconds = null;
        reset();
        break;
      }
      case 'session_resumed':
      case 'session_idle': {
        seen = true;
        // Both settle the block WITHOUT touching the headline: the wake
        // mounted its snapshots, or the session parked between turns. Either
        // way the start is over, and the chat log carries the event on its
        // own line.
        done = true;
        break;
      }
      case 'sandbox_starting': {
        // The headline already says it; the log holds what happens inside.
        seen = true;
        reset();
        break;
      }
      case 'sandbox_phase': {
        seen = true;
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
      case 'sandbox_output': {
        seen = true;
        for (const l of sandboxOutputLines(p)) push(record, 'output', l);
        break;
      }
      case 'sandbox_ready': {
        seen = true;
        // Anything still open finished when the box came up.
        for (const [, line] of open) line.kind = 'done';
        open = new Map();
        const timings =
          p.phase_timings && typeof p.phase_timings === 'object'
            ? Object.values(p.phase_timings as Record<string, unknown>)
            : [];
        const totalSeconds = timings.reduce<number>(
          (acc, v) => (typeof v === 'number' && isFinite(v) ? acc + v : acc),
          0
        );
        const tier = cacheTierLabel(p.cache_tier);
        push(
          record,
          'done',
          [
            'Sandbox ready',
            ...(tier ? [tier] : []),
            ...(totalSeconds > 0 ? [humanDuration(totalSeconds)] : []),
          ].join(', ')
        );
        sandboxDone = true;
        readySeconds = totalSeconds > 0 ? totalSeconds : null;
        // The box coming up is the session-level outcome too.
        done = true;
        break;
      }
      default:
        break;
    }
  }
  // Only the innermost open milestone is live; the ones it sits inside are
  // headings over it until it closes and they become the live line again.
  const openLines = [...open.values()];
  if (openLines.length) openLines[openLines.length - 1].loading = true;
  // The config line heads the log: it is the first thing that was decided, and
  // it survives the restarts that clear everything below it.
  const full: SandboxLogLine[] = configName
    ? [
        {
          key: 'config',
          kind: 'done',
          text: `Using ${configName}${
            configCommitSha ? ` @ ${configCommitSha.slice(0, 7)}` : ''
          }`,
        },
        ...log,
      ]
    : log;
  return seen
    ? {
        headline,
        done,
        readySeconds,
        sandboxDone,
        configName,
        configCommitSha,
        log: full,
      }
    : null;
}

// Whether the startup block has settled into its one-line summary: the start
// is over AND the session's live status word is not narrating a new one (a
// wake flips the status back to starting before its records land).
export function startupSettled(
  sandbox: SandboxState | null,
  status: string
): boolean {
  return (sandbox?.done ?? false) && statusActivityText(status) == null;
}

// The live line above the startup log, ending in the house "…": the status
// word's activity when the feed's story is over or absent (a wake in flight,
// a session with no lifecycle records yet), else the feed's own headline.
export function startupHeadline(
  sandbox: SandboxState | null,
  status: string
): string {
  const activity = statusActivityText(status);
  const text =
    !sandbox || sandbox.done
      ? (activity ?? STARTING_SANDBOX)
      : sandbox.headline;
  return `${text.replace(/…$/, '')}…`;
}

// The whole start compressed to one line, for the settled block: how long the
// sandbox took. Falls back to "Sandbox started" when no timing can be derived
// — an old feed whose sandbox_ready carried no phase_timings, or a wake,
// where the duration was never ours to know.
export function sandboxSummary(sandbox: SandboxState | null): string {
  const seconds = sandbox?.readySeconds ?? null;
  return seconds
    ? `Sandbox ready in ${humanDuration(seconds)}`
    : 'Sandbox started';
}

// The tail of the startup log: the last `max` lines, which is what you want
// while a session comes up — the newest output, not the oldest.
export function lastLines(
  log: readonly SandboxLogLine[],
  max: number
): SandboxLogLine[] {
  return log.length <= max ? [...log] : log.slice(log.length - max);
}
