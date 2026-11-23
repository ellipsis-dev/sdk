import { afterEach, describe, expect, it, vi } from 'vitest';
import { EllipsisError } from '../src/core/errors';
import {
  buildBody,
  DEFAULT_BASE_URL,
  resolveApiKey,
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

describe('resolveApiKey', () => {
  it('prefers the explicit key over the environment', () => {
    vi.stubEnv('ELLIPSIS_API_TOKEN', 'sk_from_env');
    expect(resolveApiKey('sk_explicit')).toBe('sk_explicit');
  });

  it('reads ELLIPSIS_API_TOKEN when none is passed', () => {
    vi.stubEnv('ELLIPSIS_API_TOKEN', 'sk_from_env');
    expect(resolveApiKey()).toBe('sk_from_env');
  });

  it('refuses a client with no key', () => {
    vi.stubEnv('ELLIPSIS_API_TOKEN', '');
    expect(() => new Transport()).toThrow(EllipsisError);
    expect(() => new Transport()).toThrow(
      'No API key. Pass apiKey or set ELLIPSIS_API_TOKEN.'
    );
  });

  it('sends the environment key as the bearer', async () => {
    vi.stubEnv('ELLIPSIS_API_TOKEN', 'sk_from_env');
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 })
    );
    await new Transport({ fetch }).request('GET', '/v1/me');
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer sk_from_env',
    });
  });
});

describe('buildBody', () => {
  it('sends null and leaves out undefined', () => {
    expect(
      buildBody({ environment: null, mcp: undefined, metadata: { labels: [] } })
    ).toEqual({ environment: null, metadata: { labels: [] } });
  });
});
