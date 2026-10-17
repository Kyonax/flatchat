// SPDX-License-Identifier: MPL-2.0
// The client's side of the core's API (apps/core): sign-in requests, the code exchange, refresh,
// sign-out, the account, the world list and connect tokens. Only the main process talks to the
// core; the page never holds an account token. `fetch` is injected so tests need no network.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Account {
  id: string;
  displayName: string;
}

export interface CoreTokens {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  account: Account;
}

export interface WorldSummary {
  id: string;
  name: string;
  capacity: number;
}

export interface JoinTicket {
  /** The connect token, sealed for one world; the client hands it over unread. */
  token: Uint8Array;
  /** Where the world takes its WebRTC offer. */
  address: string;
  expiresAt: number;
}

export class CoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.status = status;
    this.code = code;
  }
}

/** The core's address if it is one the client may use: https, or http on this machine (development). */
export function coreBase(text: unknown): URL | undefined {
  if (typeof text !== 'string' || text.length > 200) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

const TIMEOUT_MS = 15_000;

export class CoreApi {
  readonly base: URL;
  private readonly fetchImpl: Fetch;

  constructor(base: URL, fetchImpl: Fetch = fetch) {
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string): string {
    return new URL(path.replace(/^\//, ''), this.base.href.endsWith('/') ? this.base.href : `${this.base.href}/`).href;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, access?: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (access) headers['authorization'] = `Bearer ${access}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      throw new CoreError(0, 'unreachable', `the core did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 204) return undefined as T;
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON: handled below
    }
    if (!res.ok) throw new CoreError(res.status, typeof data['error'] === 'string' ? data['error'] : 'error', typeof data['message'] === 'string' ? data['message'] : `HTTP ${res.status}`);
    return data as T;
  }

  async loginRequest(challenge: string, port: number): Promise<{ request: string; signinUrl: URL }> {
    const r = await this.call<{ request?: unknown; signinUrl?: unknown }>('POST', '/api/v1/login-requests', { challenge, port });
    if (typeof r.request !== 'string' || typeof r.signinUrl !== 'string') throw new CoreError(502, 'bad-answer', 'the core sent no sign-in page');
    const page = new URL(r.signinUrl);
    // The browser opens only the core's own sign-in page.
    if (page.origin !== this.base.origin || !page.pathname.endsWith('/signin')) throw new CoreError(502, 'bad-answer', 'the sign-in page is not on the core');
    return { request: r.request, signinUrl: page };
  }

  private tokens(r: Record<string, unknown>): CoreTokens {
    const account = r['account'] as Partial<Account> | undefined;
    if (
      typeof r['access'] !== 'string' ||
      typeof r['refresh'] !== 'string' ||
      typeof account?.id !== 'string' ||
      typeof account.displayName !== 'string' ||
      typeof r['accessExpiresAt'] !== 'string' ||
      typeof r['refreshExpiresAt'] !== 'string'
    ) {
      throw new CoreError(502, 'bad-answer', 'the core sent no session');
    }
    return {
      access: r['access'],
      refresh: r['refresh'],
      accessExpiresAt: Date.parse(r['accessExpiresAt']),
      refreshExpiresAt: Date.parse(r['refreshExpiresAt']),
      account: { id: account.id, displayName: account.displayName },
    };
  }

  async exchange(request: string, code: string, verifier: string): Promise<CoreTokens> {
    return this.tokens(await this.call('POST', '/api/v1/sessions', { request, code, verifier }));
  }

  async refresh(refresh: string): Promise<CoreTokens> {
    return this.tokens(await this.call('POST', '/api/v1/sessions/refresh', { refresh }));
  }

  async revoke(access: string): Promise<void> {
    await this.call('POST', '/api/v1/sessions/revoke', {}, access);
  }

  async worlds(): Promise<WorldSummary[]> {
    const r = await this.call<{ worlds?: unknown }>('GET', '/api/v1/worlds');
    if (!Array.isArray(r.worlds)) return [];
    return r.worlds.flatMap((w: Partial<WorldSummary>) =>
      typeof w.id === 'string' && typeof w.name === 'string' && typeof w.capacity === 'number' ? [{ id: w.id, name: w.name.slice(0, 48), capacity: w.capacity }] : [],
    );
  }

  async join(access: string, worldId: string): Promise<JoinTicket> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    const r = await this.call<{ token?: unknown; address?: unknown; expiresAt?: unknown }>('POST', `/api/v1/worlds/${worldId}/join`, {}, access);
    if (typeof r.token !== 'string' || typeof r.address !== 'string' || typeof r.expiresAt !== 'number') throw new CoreError(502, 'bad-answer', 'the core sent no connect token');
    return { token: new Uint8Array(Buffer.from(r.token, 'base64url')), address: r.address, expiresAt: r.expiresAt };
  }
}
