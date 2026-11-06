import { expect, it } from 'vitest';
import {
  activitySummary,
  toolActivities,
  type TranscriptItem,
} from '../src/store';

const tool = (
  name: string,
  input: Record<string, unknown>
): TranscriptItem => ({
  key: 'tool',
  kind: 'tool',
  text: name,
  tool: { name, input },
});

it('shows native read and search actions instead of a shell wrapper', () => {
  const activities = toolActivities(
    tool('Bash', {
      command: 'bash -lc compound',
      commandActions: [
        {
          type: 'read',
          name: 'SessionChat.tsx',
          path: '/workspace/SessionChat.tsx',
        },
        { type: 'search', query: 'isError', path: 'ledger.ts' },
        { type: 'unknown', command: 'pnpm test' },
      ],
    })
  );
  expect(activities).toEqual([
    { kind: 'read', label: 'Read', detail: '/workspace/SessionChat.tsx' },
    { kind: 'search', label: 'Searched', detail: 'for isError in ledger.ts' },
    { kind: 'command', label: 'Ran', detail: 'pnpm test' },
  ]);
  expect(activitySummary(activities)).toBe(
    'Read files, searched code, ran commands'
  );
});

it('preserves opaque shell commands and supports Claude file tools', () => {
  expect(
    toolActivities(tool('Bash', { command: 'echo "cat file.ts"' }))
  ).toEqual([{ kind: 'command', label: 'Ran', detail: 'echo "cat file.ts"' }]);
  expect(
    toolActivities(tool('Read', { file_path: '/workspace/app.py' }))
  ).toEqual([{ kind: 'read', label: 'Read', detail: '/workspace/app.py' }]);
});

it('shows each file in a native edit without dumping its JSON', () => {
  expect(
    toolActivities(
      tool('Edit', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] })
    ).map((row) => row.detail)
  ).toEqual(['a.ts', 'b.ts']);
});

it('keeps commands visible if native action metadata is malformed', () => {
  expect(
    toolActivities(
      tool('Bash', { command: 'pnpm test', commandActions: [null] })
    )
  ).toEqual([{ kind: 'command', label: 'Ran', detail: 'pnpm test' }]);
});
