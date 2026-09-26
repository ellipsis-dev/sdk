// Human copy for `source='lifecycle'` session records — the platform's
// environment, turn, and conversation notifications interleaved into the
// record feed. Pure string shaping, shared by every renderer. Payload shapes
// are the generated LifecyclePayloads (schema/lifecycle.schema.json, pinned
// to the server models); readers stay defensive because payloads arrive as
// untyped wire JSON and older rows may predate newer fields (additive-only
// contract).

// The step label for an environment_output chunk: the sub-item when there is
// one (an "owner/name" for clone, the hook name for hooks), else the phase.
export function environmentOutputStep(
  payload: Record<string, unknown>
): string {
  if (typeof payload.step === 'string' && payload.step) return payload.step;
  return typeof payload.phase === 'string' ? payload.phase : 'setup';
}

// Every non-empty output line of an environment_output chunk — what a full
// build-log view accumulates across a step's chunks.
export function environmentOutputLines(
  payload: Record<string, unknown>
): string[] {
  return Array.isArray(payload.lines)
    ? (payload.lines as unknown[]).filter(
        (l): l is string => typeof l === 'string' && l.trim().length > 0
      )
    : [];
}

// The last non-empty output line of an environment_output chunk — what a
// live "Preparing environment" sub-line and the record view both show.
export function environmentOutputLine(
  payload: Record<string, unknown>
): string | null {
  const lines = environmentOutputLines(payload);
  return lines.length ? lines[lines.length - 1].trim() : null;
}

// Customer-facing wording for a cache_tier, explaining why the start was fast
// or slow.
export function cacheTierLabel(tier: unknown): string | null {
  switch (tier) {
    case 'exact':
      return 'cached image';
    case 'incremental':
      return 'incremental build';
    case 'full':
      return 'full build';
    default:
      return null;
  }
}

// Human label for an environment phase. Phases are an OPEN vocabulary
// (contract §2.4): unknown values render generically off the raw slug, so a
// new server phase never blanks the narrative.
export function environmentPhaseLabel(phase: unknown): string {
  switch (phase) {
    case 'image':
      return 'Preparing image';
    case 'clone':
      return 'Fetching repositories';
    case 'setup':
      return 'Running setup';
    case 'snapshot':
      return 'Snapshotting';
    case 'hooks':
      return 'Running hooks';
    case 'restore':
      return 'Restoring workspace';
    default:
      return typeof phase === 'string' && phase
        ? phase.charAt(0).toUpperCase() + phase.slice(1)
        : 'Working';
  }
}

function durationLabel(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// One transition of environment preparation ({phase, status, duration_ms,
// detail}); statuses are an open vocabulary too — unknown statuses fall back
// to the bare phase label.
function environmentPhaseText(payload: Record<string, unknown>): string {
  const label = environmentPhaseLabel(payload.phase);
  const detail =
    payload.detail && typeof payload.detail === 'object'
      ? (payload.detail as Record<string, unknown>)
      : {};
  switch (payload.status) {
    case 'started':
      return `${label}…`;
    case 'completed': {
      const parts = [label];
      const tier = cacheTierLabel(detail.cache_tier);
      if (tier) parts.push(tier);
      const duration = durationLabel(payload.duration_ms);
      if (duration) parts.push(duration);
      return parts.join(', ');
    }
    case 'failed': {
      const duration = durationLabel(payload.duration_ms);
      return duration ? `${label} failed, ${duration}` : `${label} failed`;
    }
    default:
      return label;
  }
}

// The outcome line of a turn_ended record: nothing for a completed turn (the
// agent's reply is its outcome), else the platform's explanation of why the
// turn failed, stopped, or was cancelled, or the bare status when it gave
// none.
export function turnEndedText(payload: Record<string, unknown>): string | null {
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (!status || status === 'completed') return null;
  const detail =
    typeof payload.detail === 'string' ? payload.detail.trim() : '';
  return detail || `Turn ${status}`;
}

// Human one-liner for a lifecycle record. Returns null for a record type we
// don't surface — including unknown types, which additive server versions may
// introduce and old feeds may still carry (§3.6: ignore, don't crash).
export function lifecycleText(
  recordType: string,
  payload: Record<string, unknown>
): string | null {
  switch (recordType) {
    case 'environment_phase':
      return environmentPhaseText(payload);
    case 'environment_output': {
      // One chunk of preparation output ({phase, step, stream, chunk, lines}):
      // show the step's latest line so a live viewer sees the work progressing.
      const last = environmentOutputLine(payload);
      return last ? `${environmentOutputStep(payload)}, ${last}` : null;
    }
    case 'environment_ready': {
      const repos = Array.isArray(payload.repositories)
        ? (payload.repositories as unknown[]).filter(
            (r): r is string => typeof r === 'string'
          )
        : [];
      const parts = ['Environment ready'];
      if (repos.length) parts.push(repos.join(', '));
      const duration = durationLabel(payload.duration_ms);
      if (duration) parts.push(duration);
      return parts.join(', ');
    }
    case 'turn_ended':
      return turnEndedText(payload);
    case 'session_closed':
      return 'Conversation closed';
    default:
      return null;
  }
}
