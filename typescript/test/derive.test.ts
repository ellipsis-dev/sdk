// The session-level derivations (store/derive.ts): the environment story, the
// in-flight-message phase, the delivered-but-unechoed sends, the chat-log
// milestones, and the duration wording. Ported from the Ellipsis CLI's
// connect-app tests when the functions moved here.

import { describe, expect, it } from 'vitest';
import {
  awaitingAgentPhase,
  deliveredUnechoedSends,
  deriveEnvironmentState,
  environmentSummary,
  hookPhrase,
  humanDuration,
  lastLines,
  sessionLogText,
  startupHeadline,
  startupSettled,
  type RecordSlice,
} from '../src/store';

let seq = 0;
function rec(
  recordType: string,
  payload: Record<string, unknown> = {},
  source = 'lifecycle',
  messageId: string | null = null
): RecordSlice {
  return {
    feed_seq: ++seq,
    source,
    record_type: recordType,
    payload,
    message_id: messageId,
  };
}
// An environment record, carrying the message it prepares for.
const env = (
  recordType: string,
  payload: Record<string, unknown> = {},
  messageId = 'm1'
) => rec(recordType, payload, 'lifecycle', messageId);
const messageStarted = (messageId = 'm1') =>
  rec('message_started', { message_id: messageId }, 'lifecycle', messageId);
const messageEnded = (messageId = 'm1', status = 'completed') =>
  rec(
    'message_ended',
    { message_id: messageId, status },
    'lifecycle',
    messageId
  );

describe('deriveEnvironmentState', () => {
  const texts = (state: ReturnType<typeof deriveEnvironmentState>) =>
    (state?.log ?? []).map((l) => l.text);
  const kinds = (state: ReturnType<typeof deriveEnvironmentState>) =>
    (state?.log ?? []).map((l) => l.kind);
  const loading = (state: ReturnType<typeof deriveEnvironmentState>) =>
    (state?.log ?? []).map((l) => l.loading === true);

  it('returns null before any environment record', () => {
    expect(deriveEnvironmentState([], 0)).toBeNull();
    expect(
      deriveEnvironmentState(
        [rec('assistant', {}, 'claude_code'), messageStarted(), messageEnded()],
        0
      )
    ).toBeNull();
  });

  it('is live while the environment comes up and done once it is ready', () => {
    const live = deriveEnvironmentState(
      [env('environment_phase', { phase: 'image', status: 'started' })],
      0
    );
    expect(live?.done).toBe(false);
    expect(live?.readySeconds).toBeNull();

    const ready = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'image', status: 'started' }),
        env('environment_ready', { repositories: ['o/r'], duration_ms: 4200 }),
      ],
      0
    );
    expect(ready?.done).toBe(true);
    expect(ready?.readySeconds).toBe(4.2);
    expect(texts(ready)).toEqual([
      'Preparing image…',
      'Environment ready, 4.2s',
    ]);
    // Anything still open finished when the environment came up.
    expect(kinds(ready)).toEqual(['done', 'done']);
    expect(loading(ready)).toEqual([false, false]);
  });

  it('logs each phase as ONE line, opened then closed in place', () => {
    const state = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'image', status: 'started' }),
        env('environment_phase', {
          phase: 'image',
          status: 'completed',
          duration_ms: 1200,
          detail: { cache_tier: 'exact' },
        }),
        env('environment_phase', { phase: 'clone', status: 'started' }),
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
      env('environment_phase', { phase: 'image', status: 'started' }),
      env('environment_phase', {
        phase: 'image',
        step: 'smoke',
        status: 'started',
      }),
    ];
    const nested = deriveEnvironmentState(records, 0);
    expect(texts(nested)).toEqual(['Preparing image…', 'Smoke check…']);
    expect(kinds(nested)).toEqual(['step', 'step']);
    expect(loading(nested)).toEqual([false, true]);

    const closed = deriveEnvironmentState(
      [
        ...records,
        env('environment_phase', {
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
    const state = deriveEnvironmentState(
      [
        env('environment_phase', {
          phase: 'image',
          step: 'build',
          status: 'started',
        }),
        env('environment_output', {
          phase: 'image',
          step: 'build',
          chunk: 0,
          lines: ['#1 FROM base'],
        }),
        env('environment_output', {
          phase: 'image',
          step: 'build',
          chunk: 1,
          lines: ['#2 RUN npm ci'],
        }),
        env('environment_phase', {
          phase: 'image',
          step: 'build',
          status: 'completed',
          duration_ms: 42000,
        }),
        env('environment_phase', {
          phase: 'hooks',
          step: 'post_clone',
          status: 'started',
        }),
        env('environment_output', {
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
    const state = deriveEnvironmentState(
      [
        env('environment_output', { phase: 'setup', chunk: 0, lines: ['a'] }),
        env('environment_output', {
          phase: 'setup',
          chunk: 1,
          lines: ['b', 'c'],
        }),
      ],
      0
    );
    expect(texts(state)).toEqual(['a', 'b', 'c']);
  });

  it('labels phases through the open vocabulary, unknown ones verbatim', () => {
    expect(
      texts(
        deriveEnvironmentState(
          [env('environment_phase', { phase: 'warmup', status: 'started' })],
          0
        )
      )
    ).toEqual(['Warmup…']);
    expect(
      texts(
        deriveEnvironmentState(
          [
            env('environment_phase', {
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
    const state = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'setup', status: 'started' }),
        env('environment_phase', {
          phase: 'setup',
          status: 'failed',
          duration_ms: 4000,
        }),
      ],
      0
    );
    expect(texts(state)).toEqual(['Running setup failed, 4s']);
    expect(kinds(state)).toEqual(['failed']);
    expect(state?.done).toBe(false);
  });

  it('settles when the message it prepared starts, even without a ready record', () => {
    const state = deriveEnvironmentState(
      [
        env('environment_phase', {
          phase: 'restore',
          status: 'completed',
          duration_ms: 900,
        }),
        messageStarted('m1'),
      ],
      0
    );
    expect(state?.done).toBe(true);
    expect(state?.readySeconds).toBeNull();
    // Another message's start says nothing about this preparation.
    const other = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'restore', status: 'started' }),
        messageStarted('m0'),
      ],
      0
    );
    expect(other?.done).toBe(false);
    // A message that ended without starting settles its preparation too.
    const ended = deriveEnvironmentState(
      [
        env('environment_phase', {
          phase: 'setup',
          status: 'failed',
          duration_ms: 4000,
        }),
        messageEnded('m1', 'failed'),
      ],
      0
    );
    expect(ended?.done).toBe(true);
  });

  it("starts a fresh log for a later message's environment, dropping the previous one", () => {
    const state = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'image', status: 'started' }, 'm1'),
        env(
          'environment_output',
          { phase: 'setup', chunk: 0, lines: ['old'] },
          'm1'
        ),
        env('environment_ready', { repositories: [], duration_ms: 3000 }, 'm1'),
        messageStarted('m1'),
        messageEnded('m1'),
        env('environment_phase', { phase: 'restore', status: 'started' }, 'm2'),
      ],
      0
    );
    expect(state?.done).toBe(false);
    expect(state?.readySeconds).toBeNull();
    expect(texts(state)).toEqual(['Restoring workspace…']);
  });

  it('settles on the conversation closing', () => {
    const state = deriveEnvironmentState(
      [
        env('environment_phase', { phase: 'image', status: 'started' }),
        rec('session_closed'),
      ],
      0
    );
    expect(state?.done).toBe(true);
  });

  it('folds the turn status word into the headline and the settled test', () => {
    const live = deriveEnvironmentState(
      [env('environment_phase', { phase: 'image', status: 'started' })],
      0
    );
    expect(startupHeadline(live, 'queued')).toBe('Preparing environment…');
    expect(startupSettled(live, 'queued')).toBe(false);

    const ready = deriveEnvironmentState([env('environment_ready', {})], 0);
    expect(startupSettled(ready, 'running')).toBe(true);
    expect(startupSettled(ready, 'completed')).toBe(true);
    // A later message: the status word flips first, the feed's story is still
    // over.
    expect(startupSettled(ready, 'queued')).toBe(false);
    expect(startupHeadline(ready, 'queued')).toBe('Waiting to start…');
    expect(startupHeadline(null, 'queued')).toBe('Waiting to start…');
    expect(startupHeadline(null, 'running')).toBe('Preparing environment…');
  });

  it('summarizes a settled start in one line, dropping unknown timings', () => {
    const timed = deriveEnvironmentState(
      [env('environment_ready', { duration_ms: 42000 })],
      0
    );
    expect(timed?.readySeconds).toBe(42);
    expect(environmentSummary(timed)).toBe('Environment ready in 42s');

    const untimed = deriveEnvironmentState([env('environment_ready', {})], 0);
    expect(untimed?.readySeconds).toBeNull();
    expect(environmentSummary(untimed)).toBe('Environment ready');
    expect(environmentSummary(null)).toBe('Environment ready');
  });

  it('ignores records at or below the render cursor, and old record types', () => {
    const phase = env('environment_phase', {
      phase: 'image',
      status: 'started',
    });
    const ready = env('environment_ready', {});
    expect(deriveEnvironmentState([phase, ready], ready.feed_seq)).toBeNull();
    expect(
      deriveEnvironmentState(
        [
          rec('sandbox_starting'),
          rec('sandbox_ready', {}),
          rec('session_idle'),
        ],
        0
      )
    ).toBeNull();
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
  it('is null with no message in flight — including the bare interactive session', () => {
    expect(awaitingAgentPhase([])).toBeNull();
    expect(
      awaitingAgentPhase([env('environment_phase'), env('environment_ready')])
    ).toBeNull();
  });

  it("reports 'boot' for a fresh environment's first message (the harness starting)", () => {
    expect(
      awaitingAgentPhase([env('environment_ready'), messageStarted()])
    ).toBe('boot');
  });

  it("reports 'turn' through a running message's lull, even after the harness spoke", () => {
    expect(
      awaitingAgentPhase([
        env('environment_ready'),
        messageStarted(),
        rec('assistant', {}, 'claude_code'),
      ])
    ).toBe('turn');
  });

  it('clears when the message ends, however it ended', () => {
    expect(
      awaitingAgentPhase([
        messageStarted(),
        rec('assistant', {}, 'claude_code'),
        messageEnded('m1', 'completed'),
      ])
    ).toBeNull();
    expect(
      awaitingAgentPhase([messageStarted(), messageEnded('m1', 'failed')])
    ).toBeNull();
  });

  it('resets to boot when a fresh environment is prepared (the harness boots again)', () => {
    expect(
      awaitingAgentPhase([
        messageStarted('m1'),
        rec('assistant', {}, 'claude_code'),
        messageEnded('m1'),
        env('environment_phase', { phase: 'restore', status: 'started' }, 'm2'),
        messageStarted('m2'),
      ])
    ).toBe('boot');
  });
});

describe('deliveredUnechoedSends', () => {
  // A message record names its message in the payload and the envelope.
  const received = (id: string, body: string, index = 0) =>
    rec('message', { id, index, body }, 'lifecycle', id);
  const started = (id: string) => messageStarted(id);
  const requeued = (id: string) =>
    rec('message_requeued', { message_id: id }, 'lifecycle', id);
  const echo = (id: string | null): RecordSlice => ({
    ...rec('user', {}, 'claude_code'),
    message_id: id,
  });

  it('bridges the gap between the start and the user-echo record', () => {
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), started('m1')])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }]);
  });

  it('marks a send cancelled when it ended unanswered', () => {
    for (const status of ['failed', 'stopped', 'cancelled']) {
      expect(
        deliveredUnechoedSends([
          received('m1', 'hi'),
          started('m1'),
          messageEnded('m1', status),
        ])
      ).toEqual([{ id: 'm1', body: 'hi', cancelled: true }]);
    }
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        started('m1'),
        messageEnded('m1', 'completed'),
      ])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }]);
  });

  it('leaves a send waiting when a DIFFERENT message failed', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        started('m1'),
        messageEnded('m2', 'failed'),
      ])
    ).toEqual([{ id: 'm1', body: 'hi', cancelled: false }]);
  });

  it('retires the send once its echo record lands', () => {
    expect(
      deliveredUnechoedSends([received('m1', 'hi'), started('m1'), echo('m1')])
    ).toEqual([]);
  });

  it('excludes pending (unstarted) and requeued messages', () => {
    expect(deliveredUnechoedSends([received('m1', 'hi')])).toEqual([]);
    expect(
      deliveredUnechoedSends([
        received('m1', 'hi'),
        started('m1'),
        requeued('m1'),
      ])
    ).toEqual([]);
  });

  it('keeps start order and ignores unrelated echoes', () => {
    expect(
      deliveredUnechoedSends([
        received('m1', 'first'),
        received('m2', 'second', 1),
        started('m1'),
        started('m2'),
        echo(null),
      ])
    ).toEqual([
      { id: 'm1', body: 'first', cancelled: false },
      { id: 'm2', body: 'second', cancelled: false },
    ]);
  });
});

describe('sessionLogText', () => {
  it('logs the session closing', () => {
    expect(sessionLogText('session_closed', {})).toBe('Session closed');
  });

  it('logs a message that ended without being answered, with the platform explanation', () => {
    expect(sessionLogText('message_ended', { status: 'completed' })).toBeNull();
    expect(sessionLogText('message_ended', { status: 'failed' })).toBe(
      'Message failed'
    );
    expect(
      sessionLogText('message_ended', {
        status: 'stopped',
        error: { reason: 'stopped', detail: 'Stopped by hunter.' },
      })
    ).toBe('Stopped by hunter.');
    expect(
      sessionLogText('message_ended', {
        status: 'cancelled',
        error: { reason: 'budget_hit', detail: 'Budget exhausted' },
      })
    ).toBe('Budget exhausted');
  });

  it('ignores preparation chatter, message records, and old record types', () => {
    for (const t of [
      'environment_phase',
      'environment_output',
      'environment_ready',
      'message_started',
      'message',
      'session_idle',
      'session_cancelled',
      'sandbox_ready',
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
