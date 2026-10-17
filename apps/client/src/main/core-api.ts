// SPDX-License-Identifier: MPL-2.0
// The client's side of the core's API (apps/core): sign-in requests, the code exchange, refresh,
// sign-out, the account, the world browser (the public list, a world by its id, favourites) and
// connect tokens. Only the main process talks to the
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

/** A world as the world browser shows it (S2.09). */
export interface WorldSummary {
  id: string;
  name: string;
  online: boolean;
  players: number;
  recommended: number;
  capacity: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : 0);

/** Keeps only well-formed worlds from the core's answer. */
export function cleanWorlds(raw: unknown): WorldSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).flatMap((w: Partial<WorldSummary> | null) =>
    w && typeof w.id === 'string' && /^[0-9a-f-]{36}$/i.test(w.id) && typeof w.name === 'string'
      ? [{ id: w.id.toLowerCase(), name: w.name.slice(0, 48), online: w.online === true, players: count(w.players), recommended: count(w.recommended), capacity: count(w.capacity) }]
      : [],
  );
}

/** One ICE server, as browsers take it (RTCIceServer). */
export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface JoinTicket {
  /** The connect token, sealed for one world; the client hands it over unread. */
  token: Uint8Array;
  /** Where the world takes its WebRTC offer: its own signalling URL, or the core's relay. */
  address: string;
  expiresAt: number;
  /** STUN and TURN servers with short-lived credentials (S1.13). */
  iceServers: IceServerSpec[];
}

/** Keeps only well-formed ICE servers with stun: or turn: URLs. */
export function cleanIceServers(raw: unknown): IceServerSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s: Partial<IceServerSpec>) => {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u): u is string => typeof u === 'string' && /^(stun|stuns|turn|turns):[^\s]{1,200}$/.test(u));
    if (urls.length === 0) return [];
    const user = typeof s.username === 'string' ? s.username.slice(0, 256) : '';
    const pass = typeof s.credential === 'string' ? s.credential.slice(0, 256) : '';
    return [{ urls, ...(user ? { username: user } : {}), ...(pass ? { credential: pass } : {}) }];
  });
}

/** A report as the page builds it (S3.02). */
export interface ReportBody {
  category: string;
  target: { kind: string; account?: string; world?: string; ref: string };
  text: string;
  evidence: unknown;
  clip?: Uint8Array;
}

/** One of the account's reports, with its decision. */
export interface MyReport {
  receipt: string;
  category: string;
  status: string;
  decision: string;
  createdAt: string;
}

/** Where an appeal against a world's ban stands (S3.07). */
export interface BanAppeal {
  status: 'pending' | 'upheld' | 'reversed';
  note: string;
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

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, access?: string): Promise<T> {
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

  /** The public list: open worlds below their recommended count, busiest first. */
  async worlds(): Promise<WorldSummary[]> {
    return cleanWorlds((await this.call<{ worlds?: unknown }>('GET', '/api/v1/worlds')).worlds);
  }

  /** One world by its id, listed or not. */
  async world(worldId: string): Promise<WorldSummary> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    const [w] = cleanWorlds([await this.call('GET', `/api/v1/worlds/${worldId}`)]);
    if (!w) throw new CoreError(502, 'bad-answer', 'the core sent no world');
    return w;
  }

  async favourites(access: string): Promise<WorldSummary[]> {
    return cleanWorlds((await this.call<{ worlds?: unknown }>('GET', '/api/v1/me/favourites', undefined, access)).worlds);
  }

  async setFavourite(access: string, worldId: string, on: boolean): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    await this.call(on ? 'PUT' : 'DELETE', `/api/v1/me/favourites/${worldId}`, undefined, access);
  }

  /** A report (S3.02): the target, the text, the evidence and the voice clip (a WAV) the page
   *  built; answers the receipt. */
  async report(access: string, r: ReportBody): Promise<string> {
    const body = { category: r.category, target: r.target, text: r.text, evidence: r.evidence, ...(r.clip ? { clip: Buffer.from(r.clip).toString('base64') } : {}) };
    const answer = await this.call<{ receipt?: unknown }>('POST', '/api/v1/reports', body, access);
    if (typeof answer.receipt !== 'string') throw new CoreError(502, 'bad-answer', 'the core sent no receipt');
    return answer.receipt.slice(0, 32);
  }

  /** The accounts this player muted, in every world (S3.08). */
  async mutes(access: string): Promise<string[]> {
    const r = await this.call<{ accounts?: unknown }>('GET', '/api/v1/me/mutes', undefined, access);
    return (Array.isArray(r.accounts) ? r.accounts : []).filter((a): a is string => typeof a === 'string' && /^[0-9a-f-]{36}$/i.test(a)).slice(0, 1000);
  }

  async setMute(access: string, account: string, on: boolean): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(account)) throw new CoreError(400, 'bad-account', 'not an account id');
    await this.call(on ? 'PUT' : 'DELETE', `/api/v1/me/mutes/${account}`, undefined, access);
  }

  /** The reports this account filed, with their decisions. */
  async reports(access: string): Promise<MyReport[]> {
    const r = await this.call<{ reports?: unknown }>('GET', '/api/v1/reports', undefined, access);
    return (Array.isArray(r.reports) ? r.reports : []).slice(0, 50).flatMap((x: unknown) => {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
      return typeof o['receipt'] === 'string' && typeof o['status'] === 'string'
        ? [{ receipt: o['receipt'].slice(0, 32), category: String(o['category'] ?? '').slice(0, 16), status: String(o['status']).slice(0, 16), decision: typeof o['decision'] === 'string' ? o['decision'].slice(0, 1000) : '', createdAt: String(o['createdAt'] ?? '').slice(0, 32) }]
        : [];
    });
  }

  /** An appeal against a world's ban, to its owner (S3.07): the reason the world gave, and why it
   *  is wrong. */
  async appealBan(access: string, worldId: string, reason: string, text: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    await this.call('POST', `/api/v1/worlds/${worldId}/appeals`, { reason: reason.slice(0, 500), text: text.slice(0, 2000) }, access);
  }

  /** The latest appeal against that world's ban, if any. */
  async banAppeal(access: string, worldId: string): Promise<BanAppeal | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    try {
      const r = await this.call<{ status?: unknown; note?: unknown }>('GET', `/api/v1/worlds/${worldId}/appeal`, undefined, access);
      const status = r.status === 'pending' || r.status === 'upheld' || r.status === 'reversed' ? r.status : 'pending';
      return { status, note: typeof r.note === 'string' ? r.note.slice(0, 1000) : '' };
    } catch (err) {
      if (err instanceof CoreError && err.status === 404) return undefined;
      throw err;
    }
  }

  async join(access: string, worldId: string): Promise<JoinTicket> {
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new CoreError(400, 'bad-world', 'not a world id');
    const r = await this.call<{ token?: unknown; address?: unknown; expiresAt?: unknown; iceServers?: unknown }>('POST', `/api/v1/worlds/${worldId}/join`, {}, access);
    if (typeof r.token !== 'string' || typeof r.address !== 'string' || typeof r.expiresAt !== 'number') throw new CoreError(502, 'bad-answer', 'the core sent no connect token');
    return { token: new Uint8Array(Buffer.from(r.token, 'base64url')), address: r.address, expiresAt: r.expiresAt, iceServers: cleanIceServers(r.iceServers) };
  }

  /** Whether `url` is this core's signalling relay for a world hosted from home. */
  isRelay(url: string): boolean {
    try {
      const u = new URL(url);
      return u.origin === this.base.origin && /\/api\/v1\/worlds\/[0-9a-f-]{36}\/signal$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  /** Sends a WebRTC offer to a world through the core's relay and returns the world's answer. */
  async relaySignal(access: string, url: string, offer: { type: string; sdp: string }): Promise<{ type: string; sdp: string }> {
    if (!this.isRelay(url)) throw new CoreError(400, 'bad-relay', 'not this core’s relay');
    const path = new URL(url).pathname.slice(this.base.pathname.replace(/\/$/, '').length);
    const r = await this.call<{ type?: unknown; sdp?: unknown }>('POST', path, { type: 'offer', sdp: offer.sdp }, access);
    if (r.type !== 'answer' || typeof r.sdp !== 'string' || r.sdp.length > 64 * 1024) throw new CoreError(502, 'bad-answer', 'the world sent no answer');
    return { type: 'answer', sdp: r.sdp };
  }
}
