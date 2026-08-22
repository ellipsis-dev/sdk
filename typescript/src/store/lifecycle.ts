// Human copy for `source='lifecycle'` session records — the platform's
// startup/respawn/idle notifications interleaved into the record feed. Pure
// string shaping, shared by every renderer. Payload shapes are the generated
// LifecyclePayloads (schema/lifecycle.schema.json, pinned to the server
// models); readers stay defensive because payloads arrive as untyped wire
// JSON and older rows may predate newer fields (additive-only contract).

// The step label for a sandbox_output chunk: the sub-item when there is one
// (an "owner/name" for clone, the hook name for hooks), else the phase.
export function sandboxOutputStep(payload: Record<string, unknown>): string {
  if (typeof payload.step === 'string' && payload.step) return payload.step;
  return typeof payload.phase === 'string' ? payload.phase : 'setup';
}

// Every non-empty output line of a sandbox_output chunk — what a full build-log
// view accumulates across a step's chunks.
export function sandboxOutputLines(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.lines)
    ? (payload.lines as unknown[]).filter(
        (l): l is string => typeof l === 'string' && l.trim().length > 0
      )
    : [];
}

// The last non-empty output line of a sandbox_output chunk — what a live
// "Starting sandbox" sub-line and the record view both show.
export function sandboxOutputLine(
  payload: Record<string, unknown>
): string | null {
  const lines = sandboxOutputLines(payload);
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

// Human label for a provisioning phase. Phases are an OPEN vocabulary
// (contract §2.4): unknown values render generically off the raw slug, so a
// new server phase never blanks the narrative.
export function sandboxPhaseLabel(phase: unknown): string {
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

// One transition of the provisioning state machine ({phase, status,
// duration_ms, detail}); statuses are an open vocabulary too — unknown
// statuses fall back to the bare phase label.
function sandboxPhaseText(payload: Record<string, unknown>): string {
  const label = sandboxPhaseLabel(payload.phase);
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
      return parts.join(' · ');
    }
    case 'failed': {
      const duration = durationLabel(payload.duration_ms);
      return duration ? `${label} failed · ${duration}` : `${label} failed`;
    }
    default:
      return label;
  }
}

// Human one-liner for a lifecycle record. Returns null for a record type we
// don't surface — including unknown types, which additive server versions may
// introduce (§3.6: ignore, don't crash).
export function lifecycleText(
  recordType: string,
  payload: Record<string, unknown>
): string | null {
  switch (recordType) {
    case 'session_scheduled': {
      const config =
        typeof payload.config_name === 'string' ? payload.config_name : null;
      return config ? `Session scheduled · ${config}` : 'Session scheduled';
    }
    case 'session_starting': {
      // attempt > 0 = an infra retry of the SAME start/wake (the preceding
      // session_retrying record carries the reason) — never "Waking".
      const attempt = typeof payload.attempt === 'number' ? payload.attempt : 0;
      if (attempt > 0) return 'Retrying…';
      const wakeIndex =
        typeof payload.wake_index === 'number' ? payload.wake_index : 0;
      return wakeIndex > 0 ? 'Waking the session…' : 'Session starting…';
    }
    case 'session_retrying':
      return typeof payload.reason === 'string' && payload.reason
        ? `Retrying · ${payload.reason}`
        : 'Retrying after a transient error…';
    case 'sandbox_starting':
      return 'Starting sandbox…';
    case 'sandbox_phase':
      return sandboxPhaseText(payload);
    case 'sandbox_output': {
      // One chunk of provisioning output ({phase, step, stream, chunk,
      // lines}): show
      // the step's latest line so a live viewer sees the install progressing.
      const last = sandboxOutputLine(payload);
      return last ? `${sandboxOutputStep(payload)} · ${last}` : null;
    }
    case 'sandbox_ready': {
      const repos = Array.isArray(payload.repositories)
        ? (payload.repositories as unknown[]).filter(
            (r): r is string => typeof r === 'string'
          )
        : [];
      const parts = ['Sandbox ready'];
      if (repos.length) parts.push(repos.join(', '));
      const tier = cacheTierLabel(payload.cache_tier);
      if (tier) parts.push(tier);
      return parts.join(' · ');
    }
    case 'session_resumed':
      return 'Resumed the conversation';
    case 'session_idle':
      return 'Idle — your next message wakes it';
    case 'session_closed':
      return 'Conversation closed';
    case 'session_cancelled': {
      const reason = typeof payload.reason === 'string' ? payload.reason : null;
      return reason ? `Session cancelled · ${reason}` : 'Session cancelled';
    }
    default:
      return null;
  }
}
