// The session-level derivations (store/derive.ts): the startup story, the
// in-flight-turn phase, the delivered-but-unechoed sends, the chat-log
// milestones, and the duration wording. Ported from the Ellipsis CLI's
// connect-app tests when the functions moved here.

import { describe, expect, it } from 'vitest';
import {
  awaitingAgentPhase,
  deliveredUnechoedSends,
  deriveSandboxState,
  hookPhrase,
  humanDuration,
  lastLines,
  sandboxSummary,
  sessionLogText,
  startupHeadline,
  startupSettled,
  type RecordSlice,
} from '../src/store';

let seq = 0;
function rec(
  recordType: string,
  payload: Record<string, unknown> = {},
  source = 'lifecycle'
): RecordSlice {
  return { feed_seq: ++seq, source, record_type: recordType, payload };
}

describe('deriveSandboxState', () => {
  const texts = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.text);
  const kinds = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.kind);
  const loading = (state: ReturnType<typeof deriveSandboxState>) =>
    (state?.log ?? []).map((l) => l.loading === true);

  it('returns null before any lifecycle record', () => {
    expect(deriveSandboxState([], 0)).toBeNull();
    expect(
      deriveSandboxState([rec('assistant', {}, 'claude_code')], 0)
    ).toBeNull();
  });

  it('walks the live headline: scheduled → starting → done', () => {
    const scheduled = deriveSandboxState(
      [rec('session_scheduled', { source: 'cli' })],
      0
    );
    expect(scheduled?.headline).toBe('Session scheduled…');
    expect(scheduled?.done).toBe(false);

    const starting = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli', config_name: 'my-agent' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
      ],
      0
    );
    expect(starting?.headline).toBe('Starting sandbox…');
    expect(starting?.done).toBe(false);

    const ready = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting', {}),
        rec('sandbox_ready', { cache_tier: 'exact' }),
      ],
      0
    );
    expect(ready?.done).toBe(true);
    expect(ready?.sandboxDone).toBe(true);
  });

  it('heads the log with the config, and keeps it across the starting transition', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', {
          source: 'cli',
          config_name: 'deployer',
          config_commit_sha: 'abc1234def5678',
        }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
      ],
      0
    );
    expect(state?.headline).toBe('Starting sandbox…');
    expect(state?.configName).toBe('deployer');
    expect(texts(state)[0]).toBe('Using deployer @ abc1234');
  });

  it('logs each phase as ONE line, opened then closed in place', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'image',
          status: 'completed',
          duration_ms: 1200,
          detail: { cache_tier: 'exact' },
        }),
        rec('sandbox_phase', { phase: 'clone', status: 'started' }),
      ],
      0
    );
    expect(texts(state)).toEqual([
      'Preparing image, cached image, 1.2s',
      'Fetching repositories…',
    ]);
    expect(kinds(state)).toEqual(['done', 'step']);
    expect(loading(state)).toEqual([false, true]);
  });

  it('keeps ONE loading line: the innermost open milestone', () => {
    const records = [
      rec('sandbox_starting'),
      rec('sandbox_phase', { phase: 'image', status: 'started' }),
      rec('sandbox_phase', {
        phase: 'image',
        step: 'smoke',
        status: 'started',
      }),
    ];
    const nested = deriveSandboxState(records, 0);
    expect(texts(nested)).toEqual(['Preparing image…', 'Smoke check…']);
    expect(kinds(nested)).toEqual(['step', 'step']);
    expect(loading(nested)).toEqual([false, true]);

    const closed = deriveSandboxState(
      [
        ...records,
        rec('sandbox_phase', {
          phase: 'image',
          step: 'smoke',
          status: 'completed',
          duration_ms: 300,
        }),
      ],
      0
    );
    expect(kinds(closed)).toEqual(['step', 'done']);
    expect(loading(closed)).toEqual([true, false]);
  });

  it('puts build and setup OUTPUT in the same flat log, in order', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', {
          phase: 'image',
          step: 'build',
          status: 'started',
        }),
        rec('sandbox_output', {
          phase: 'image',
          step: 'build',
          chunk: 0,
          lines: ['#1 FROM base'],
        }),
        rec('sandbox_output', {
          phase: 'image',
          step: 'build',
          chunk: 1,
          lines: ['#2 RUN npm ci'],
        }),
        rec('sandbox_phase', {
          phase: 'image',
          step: 'build',
          status: 'completed',
          duration_ms: 42000,
        }),
        rec('sandbox_phase', {
          phase: 'hooks',
          step: 'post_clone',
          status: 'started',
        }),
        rec('sandbox_output', {
          phase: 'hooks',
          step: 'post_clone',
          chunk: 0,
          lines: ['npm ci'],
        }),
      ],
      0
    );
    expect(texts(state)).toEqual([
      'Building image, 42s',
      '#1 FROM base',
      '#2 RUN npm ci',
      'Post-clone setup…',
      'npm ci',
    ]);
    expect(kinds(state)).toEqual([
      'done',
      'output',
      'output',
      'step',
      'output',
    ]);
  });

  it('logs output that arrives with no phase transition to open it', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_output', { phase: 'setup', chunk: 0, lines: ['a'] }),
        rec('sandbox_output', { phase: 'setup', chunk: 1, lines: ['b', 'c'] }),
      ],
      0
    );
    expect(texts(state)).toEqual(['a', 'b', 'c']);
  });

  it('labels phases through the open vocabulary, unknown ones verbatim', () => {
    expect(
      texts(
        deriveSandboxState(
          [rec('sandbox_phase', { phase: 'warmup', status: 'started' })],
          0
        )
      )
    ).toEqual(['Warmup…']);
    expect(
      texts(
        deriveSandboxState(
          [
            rec('sandbox_phase', {
              phase: 'image',
              step: 'warm_cache',
              status: 'started',
            }),
          ],
          0
        )
      )
    ).toEqual(['warm_cache…']);
  });

  it('marks a failed phase and keeps its duration', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_phase', { phase: 'setup', status: 'started' }),
        rec('sandbox_phase', {
          phase: 'setup',
          status: 'failed',
          duration_ms: 4000,
        }),
      ],
      0
    );
    expect(texts(state)).toEqual(['Running setup failed, 4s']);
    expect(kinds(state)).toEqual(['failed']);
  });

  it('closes on sandbox_ready with the phase_timings total, not step durations', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting', { repositories: ['o/r'] }),
        rec('sandbox_phase', { phase: 'image', status: 'started' }),
        rec('sandbox_ready', {
          repositories: ['o/r'],
          cache_tier: 'exact',
          phase_timings: { image: 1.5, clone: 27.5 },
        }),
      ],
      0
    );
    expect(state?.done).toBe(true);
    expect(state?.sandboxDone).toBe(true);
    expect(state?.readySeconds).toBe(29);
    expect(texts(state)).toEqual([
      'Preparing image…',
      'Sandbox ready, cached image, 29s',
    ]);
    expect(kinds(state)).toEqual(['done', 'done']);
  });

  it('starts a fresh log on a wake, dropping the previous start', () => {
    const state = deriveSandboxState(
      [
        rec('session_scheduled', { source: 'cli' }),
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_output', { phase: 'setup', chunk: 0, lines: ['old'] }),
        rec('sandbox_ready', {}),
        rec('session_idle', {}),
        rec('session_starting', { attempt: 0, wake_index: 1 }),
        rec('sandbox_starting'),
        rec('sandbox_phase', { phase: 'restore', status: 'started' }),
      ],
      0
    );
    expect(state?.headline).toBe('Waking the session…');
    expect(state?.done).toBe(false);
    expect(texts(state)).toEqual(['Restoring workspace…']);

    const resumed = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 1 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', { cache_tier: 'exact' }),
        rec('session_resumed', { wake_index: 1 }),
      ],
      0
    );
    expect(resumed?.done).toBe(true);
  });

  it('settles on session_idle WITHOUT rewriting the headline', () => {
    const state = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', {}),
        rec('session_idle', {}),
      ],
      0
    );
    expect(state?.headline).toBe('Starting sandbox…');
    expect(state?.done).toBe(true);
  });

  it('folds the live status word into the headline and the settled test', () => {
    const live = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
      ],
      0
    );
    expect(startupHeadline(live, 'starting')).toBe('Starting sandbox…');
    expect(startupSettled(live, 'starting')).toBe(false);

    const ready = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', {}),
      ],
      0
    );
    expect(startupSettled(ready, 'working')).toBe(true);
    // A wake: the status word flips first, the feed's story is still over.
    expect(startupSettled(ready, 'starting')).toBe(false);
    expect(startupHeadline(ready, 'starting')).toBe('Starting sandbox…');
    expect(startupHeadline(ready, 'scheduled')).toBe('Waiting for a worker…');
    expect(startupHeadline(null, 'working')).toBe('Starting sandbox…');
  });

  it('summarizes a settled start in one line, dropping unknown timings', () => {
    const timed = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('sandbox_ready', { phase_timings: { image: 12, clone: 30 } }),
      ],
      0
    );
    expect(timed?.readySeconds).toBe(42);
    expect(sandboxSummary(timed)).toBe('Sandbox ready in 42s');

    const untimed = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_ready', {}),
      ],
      0
    );
    expect(untimed?.readySeconds).toBeNull();
    expect(sandboxSummary(untimed)).toBe('Sandbox started');
  });

  it('shows Retrying as the headline and drops the failed start log', () => {
    const state = deriveSandboxState(
      [
        rec('session_starting', { attempt: 0, wake_index: 0 }),
        rec('sandbox_starting'),
        rec('session_retrying', {
          reason: 'sandbox provisioning failed',
          attempt: 1,
        }),
      ],
      0
    );
    expect(state?.headline).toBe('Retrying, sandbox provisioning failed');
    expect(state?.done).toBe(false);
    expect(state?.log).toHaveLength(0);
  });

  it('ignores records at or below the render cursor', () => {
    const starting = rec('sandbox_starting');
    const ready = rec('sandbox_ready', {});
    expect(deriveSandboxState([starting, ready], ready.feed_seq)).toBeNull();
  });
});

describe('lastLines', () => {
  const log = Array.from({ length: 25 }, (_, i) => ({
    key: `k${i}`,
    kind: 'output' as const,
    text: `line ${i}`,
  }));

  it('keeps the NEWEST lines — the tail is what you watch during a build', () => {
    expect(lastLines(log, 10).map((l) => l.text)).toEqual([
      'line 15',
      'line 16',
      'line 17',
      'line 18',
      'line 19',
      'line 20',
      'line 21',
      'line 22',
      'line 23',
      'line 24',
    ]);
  });

  it('returns everything when the log is shorter than the window', () => {
    expect(lastLines(log.slice(0, 3), 10)).toHaveLength(3);
    expect(lastLines([], 10)).toEqual([]);
  });
});

describe('awaitingAgentPhase', () => {
  it('is null with no turn in flight — including the bare interactive session', () => {
    expect(awaitingAgentPhase([])).toBeNull();
    expect(
      awaitingAgentPhase([rec('session_starting'), rec('sandbox_ready')])
    ).toBeNull();
  });

  it("reports 'boot' for a fresh execution's first turn (the harness starting)", () => {
    expect(
      awaitingAgentPhase([
        rec('session_starting'),
        rec('sandbox_ready'),
        rec('turn_started'),
      ])
    ).toBe('boot');
  });

  it("reports 'turn' through a running turn's lull, even after the harness spoke", () => {
    expect(
      awaitingAgentPhase([
        rec('session_starting'),
        rec('turn_started'),
        rec('assistant', {}, 'claude_code'),
      ])
    ).toBe('turn');
  });

  it('clears when the turn completes or fails', () => {
    expect(
      awaitingAgentPhase([
        rec('turn_started'),
        rec('assistant', {}, 'claude_code'),
        rec('turn_completed'),
      ])
    ).toBeNull();
    expect(
      awaitingAgentPhase([rec('turn_started'), rec('turn_failed')])
    ).toBeNull();
  });

  it('resets to boot on a wake (a fresh execution boots the harness again)', () => {
    expect(
      awaitingAgentPhase([
        rec('turn_started'),
        rec('assistant', {}, 'claude_code'),
        rec('turn_completed'),
        rec('session_starting'),
        rec('turn_started'),
      ])
    ).toBe('boot');
  });
});

describe('deliveredUnechoedSends', () => {
  const received = (id: string, body: string) =>
    rec('message_received', { message_id: id, body });
  const delivered = (id: string, turn = 't1') =>
    rec('message_delivered', { message_id: id, turn_id: turn });
  const requeued = (id: string) => rec('message_requeued', { message_id: id });
  const turnFailed = (turn = 't1') =>
    rec('turn_failed', { turn_id: turn, turn_index: 0 });
  const echo = (id: string | null): RecordSlice => ({
    ...rec('user', {}, 'claude_code'),
    session_message_id: id,
  });

  it('bridges the gap between delivery and the user-echo record', () => {
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), delivered('m1')])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }]);
  });

  it('marks a send cancelled when the turn that took it died unanswered', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        delivered('m1', 't7'),
        turnFailed('t7'),
      ])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: true }]);
  });

  it('leaves a send waiting when a DIFFERENT turn failed', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        delivered('m1', 't7'),
        turnFailed('t8'),
      ])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }]);
  });

  it('retires the send once its echo record lands', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        delivered('m1'),
        echo('m1'),
      ])
    ).toEqual([]);
  });

  it('excludes pending (undelivered) and requeued messages', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi')])).toEqual([]);
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        delivered('m1'),
        requeued('m1'),
      ])
    ).toEqual([]);
  });

  it('keeps delivery order and ignores unrelated echoes', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'first'),
        received('m2', 'second'),
        delivered('m1'),
        delivered('m2'),
        echo(null),
      ])
    ).toEqual([
      { id: 'm1', body: 'first', cancelled: false },
      { id: 'm2', body: 'second', cancelled: false },
    ]);
  });
});

describe('sessionLogText', () => {
  it('does not log the FIRST start — the startup block tells that story', () => {
    expect(sessionLogText('session_starting', {})).toBeNull();
    expect(sessionLogText('session_starting', { wake_index: 0 })).toBeNull();
  });

  it('logs a wake, which happens long after the startup block settled', () => {
    expect(sessionLogText('session_starting', { wake_index: 2 })).toBe(
      'Session waking'
    );
  });

  it('logs an infra retry distinctly from a wake', () => {
    expect(sessionLogText('session_starting', { attempt: 1 })).toContain(
      'transient error'
    );
    expect(sessionLogText('session_retrying', { reason: 'node lost' })).toBe(
      'Retrying, node lost'
    );
  });

  it('logs a cancellation with its reason when there is one', () => {
    expect(sessionLogText('session_cancelled', {})).toBe('Session cancelled');
    expect(sessionLogText('session_cancelled', { reason: 'budget' })).toBe(
      'Session cancelled, budget'
    );
  });

  it('ignores provisioning chatter', () => {
    for (const t of [
      'sandbox_starting',
      'sandbox_phase',
      'sandbox_output',
      'sandbox_ready',
      'turn_started',
    ]) {
      expect(sessionLogText(t, {})).toBeNull();
    }
  });
});

describe('humanDuration', () => {
  it('scales precision down with size: ms under 1s, one decimal under 5s', () => {
    expect(humanDuration(0.428)).toBe('428ms');
    expect(humanDuration(1.2)).toBe('1.2s');
    expect(humanDuration(4.7)).toBe('4.7s');
    expect(humanDuration(3)).toBe('3s');
  });

  it('reads as compact h/m/s components, dropping zero parts', () => {
    expect(humanDuration(0)).toBe('0s');
    expect(humanDuration(62)).toBe('1m 2s');
    expect(humanDuration(120)).toBe('2m');
    expect(humanDuration(3600)).toBe('1h');
    expect(humanDuration(3810)).toBe('1h 3m 30s');
    expect(humanDuration(5400)).toBe('1h 30m');
  });

  it('rounds fractional seconds and clamps negatives', () => {
    expect(humanDuration(59.7)).toBe('1m');
    expect(humanDuration(-5)).toBe('0s');
  });
});

describe('hookPhrase', () => {
  it('maps known step/phase keys and passes unknown ones through', () => {
    expect(hookPhrase('setup')).toBe('Building image');
    expect(hookPhrase('image.setup')).toBe('Building image');
    expect(hookPhrase('clone')).toBe('Fetching repositories');
    expect(hookPhrase('post_clone')).toBe('Post-clone setup');
    expect(hookPhrase('post_start')).toBe('Post-start setup');
    expect(hookPhrase('custom.step')).toBe('custom.step');
  });
});
