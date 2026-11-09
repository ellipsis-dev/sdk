import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BASE_URL,
  resolveBaseUrl,
  Transport,
} from '../src/core/transport';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveBaseUrl', () => {
  it('prefers the explicit base URL over the environment', () => {
    vi.stubEnv('ELLIPSIS_API_BASE_URL', 'http://from-env');
    expect(resolveBaseUrl('http://explicit/')).toBe('http://explicit');
  });

  it('reads ELLIPSIS_API_BASE_URL when none is passed', () => {
    vi.stubEnv('ELLIPSIS_API_BASE_URL', 'http://from-env/');
    expect(resolveBaseUrl()).toBe('http://from-env');
  });

  it('falls back to the default', () => {
    vi.stubEnv('ELLIPSIS_API_BASE_URL', '');
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it('sends requests to the environment base URL', async () => {
    vi.stubEnv('ELLIPSIS_API_BASE_URL', 'http://from-env');
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    );
    await new Transport({ apiKey: 'sk_test', fetch }).request('GET', '/v1/me');
    expect(fetch.mock.calls[0]?.[0]).toBe('http://from-env/v1/me');
  });
});
