import { describe, expect, it, vi } from 'vitest';
import { AgentKind, Ellipsis, GithubAction, SessionStatus } from '../src';
import type { AgentConfig, AgentConfigOutput } from '../src';

describe('enums and models', () => {
  it('names an enum member by its wire string', () => {
    expect(GithubAction.ContentsPush).toBe('contents.push');
    expect(AgentKind.Agent).toBe('agent');
    expect(SessionStatus.Running).toBe('running');
  });

  it('takes an agent directly, with enum members beside plain strings', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 201 })
    );
    const client = new Ellipsis({
      apiKey: 'sk_test',
      baseUrl: 'http://api',
      fetch,
    });
    const agent: AgentConfig = {
      ellipsis: { kind: AgentKind.Agent, name: 'dependency-upgrades' },
      trigger: { type: 'cron', schedule: '0 9 * * 1' },
      session: {
        claude_code: { model: 'claude-opus-5-5', prompt: 'Upgrade.' },
        permissions: {
          github: [
            { allow: GithubAction.ContentsPush },
            { allow: 'pull_requests.create', branch: 'ellipsis/*', limit: 1 },
          ],
        },
      },
    };
    await client.agents.create(agent);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api/v1/agents');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      agent,
    });
  });

  it('accepts an agent the API returned wherever one is written', () => {
    const accept = (_config: AgentConfig) => undefined;
    const returned = {} as AgentConfigOutput;
    expect(accept(returned)).toBeUndefined();
  });
});
