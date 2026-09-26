import type { TranscriptItem } from './transcript';

export interface ToolActivity {
  kind: 'read' | 'search' | 'list' | 'edit' | 'command' | 'web' | 'tool';
  label: string;
  detail: string;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

// Use the harness's parsed command actions when available. A shell command
// without that metadata remains a command; guessing from shell text would
// mislabel pipelines, quoted strings, and compound commands.
export function toolActivities(item: TranscriptItem): ToolActivity[] {
  const input = item.tool?.input ?? {};
  const name = item.tool?.name ?? item.text;
  const actions = input.commandActions;
  if (Array.isArray(actions) && actions.length) {
    const parsed = actions.flatMap((value): ToolActivity[] => {
      if (!value || typeof value !== 'object') return [];
      const action = value as Record<string, unknown>;
      switch (action.type) {
        case 'read':
          return [
            {
              kind: 'read',
              label: 'Read',
              detail: text(action.path) || text(action.name),
            },
          ];
        case 'search': {
          const query = text(action.query);
          const path = text(action.path);
          return [
            {
              kind: 'search',
              label: 'Searched',
              detail:
                (query ? `for ${query}` : 'code') + (path ? ` in ${path}` : ''),
            },
          ];
        }
        case 'listFiles':
          return [
            {
              kind: 'list',
              label: 'Listed',
              detail: text(action.path) || 'files',
            },
          ];
        default:
          return [
            {
              kind: 'command',
              label: 'Ran',
              detail: text(action.command) || text(input.command),
            },
          ];
      }
    });
    if (parsed.length) return parsed;
  }
  const path =
    text(input.file_path) || text(input.path) || text(input.notebook_path);
  switch (name.toLowerCase()) {
    case 'read':
      return [{ kind: 'read', label: 'Read', detail: path }];
    case 'edit':
    case 'write':
    case 'multiedit':
      if (Array.isArray(input.changes)) {
        return input.changes.map((change) => ({
          kind: 'edit',
          label: 'Edited',
          detail: text(change?.path),
        }));
      }
      return [
        {
          kind: 'edit',
          label: name.toLowerCase() === 'write' ? 'Wrote' : 'Edited',
          detail: path,
        },
      ];
    case 'grep':
    case 'glob':
      return [
        {
          kind: 'search',
          label: 'Searched',
          detail: `for ${text(input.pattern)}` + (path ? ` in ${path}` : ''),
        },
      ];
    case 'bash':
      return [{ kind: 'command', label: 'Ran', detail: text(input.command) }];
    case 'websearch':
      return [
        { kind: 'web', label: 'Searched the web', detail: text(input.query) },
      ];
    case 'webfetch':
      return [{ kind: 'web', label: 'Opened', detail: text(input.url) }];
    default:
      return [
        {
          kind: 'tool',
          label: name.replace(/^mcp__/, '').replace('__', ':'),
          detail: item.detail ?? '',
        },
      ];
  }
}

export function activitySummary(activities: readonly ToolActivity[]): string {
  const labels: Record<ToolActivity['kind'], string> = {
    read: 'read files',
    search: 'searched code',
    list: 'listed files',
    edit: 'edited files',
    command: 'ran commands',
    web: 'browsed the web',
    tool: 'used tools',
  };
  const summary = [
    ...new Set(activities.map((activity) => labels[activity.kind])),
  ].join(', ');
  return summary ? summary[0].toUpperCase() + summary.slice(1) : 'Activity';
}
