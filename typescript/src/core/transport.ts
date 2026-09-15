// The hand-written transport: base URL, bearer auth, retries, error mapping.
// Written once; its size is independent of the route count. Zero-dependency
// on purpose (global fetch) so the CLI's `bun --compile` can bundle it.

import { apiErrorFor, TransportError } from './errors';

export const DEFAULT_BASE_URL = 'https://api.ellipsis.dev';
export const DEFAULT_TIMEOUT_MS = 60_000;
// 429 and 5xx retry with exponential backoff + jitter; every retried status
// means the request was not applied.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
export const MAX_RETRIES = 2;

export interface TransportOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  // Injectable for tests and exotic runtimes; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
}

export type QueryValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Array<string | number | boolean | Date>;

function queryScalar(value: string | number | boolean | Date): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// Drop omitted params; explode arrays into repeated keys (FastAPI's list
// convention).
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, queryScalar(item));
    } else {
      search.append(key, queryScalar(value));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

// Serialize a request body: omitted (undefined/null) fields stay off the wire
// so the server applies its own defaults.
export function buildBody(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  }
  return 2 ** attempt * 500 + Math.random() * 250;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Transport {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TransportOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.headers = { Authorization: `Bearer ${options.apiKey}` };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    options: { query?: string; body?: unknown } = {}
  ): Promise<T> {
    const url = this.baseUrl + path + (options.query ?? '');
    const init: RequestInit = { method, headers: { ...this.headers } };
    if (options.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] =
        'application/json';
      init.body = JSON.stringify(options.body);
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new TransportError(String(error));
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }
      if (response.status >= 400) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = await response.text().catch(() => null);
        }
        throw apiErrorFor(response.status, body);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }
}
