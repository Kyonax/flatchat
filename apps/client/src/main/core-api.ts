// SPDX-License-Identifier: MPL-2.0
// The client's side of the core's API (apps/core): sign-in requests, the code exchange, refresh,
// sign-out, the account, the world browser (the public list, a world by its id, favourites) and
// connect tokens; avatars, the standard bodies, items and outfits. Only the main process talks to the
// core; the page never holds an account token. `fetch` is injected so tests need no network.
import { ANIMATION_USES, type AnimationUse, BODY_KITS, type BodyKit, fitWornAdjust, type Licence, LicenceError, readLicence, type Slot, SLOTS, type WornAdjust } from '@flatchat/content';

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

/** Someone in the friends list (S3.10). */
export interface Person {
  account: string;
  name: string;
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

/** One of the account's avatars (S4.01). */
export interface AvatarItem {
  id: string;
  name: string;
  /** `removed`: taken down from FlatChat (S5.09); its problems say why. */
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed' | 'removed';
  rank: string | null;
  problems: string[];
  /** The converted avatar's manifest hash (what others fetch it by). */
  manifest: string | null;
  createdAt: string;
  wearing: boolean;
  /** The standard body it is (S5.05), when it is one. */
  kit: BodyKit | null;
  /** Its gallery entry when the account published it, or the entry it was taken from (S5.06). */
  published: string | null;
  fromGallery: string | null;
}

const STATUSES = new Set(['uploading', 'converting', 'ready', 'refused', 'failed', 'removed']);
const HEX64 = /^[0-9a-f]{64}$/;
const isKit = (v: unknown): v is BodyKit => typeof v === 'string' && (BODY_KITS as readonly string[]).includes(v);
const UUID = /^[0-9a-f-]{36}$/;
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const lines = (v: unknown, n = 10): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').slice(0, n).map((p) => p.slice(0, 300)) : []);

/** One of the account's items (S5.05). */
export interface ItemEntry {
  id: string;
  name: string;
  status: AvatarItem['status'];
  slot: Slot | null;
  /** The standard bodies it fits; none for an attachment, which goes on any avatar. */
  fits: BodyKit[];
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: string;
  published: string | null;
  fromGallery: string | null;
  /** The starter wardrobe's id for it, when it is one (P.08). */
  starter: string | null;
}

/** Keeps only well-formed items from the core's answer. */
export function cleanItems(raw: unknown): ItemEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).flatMap((a): ItemEntry[] => {
    const v = a as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(v['id']) || typeof v['status'] !== 'string' || !STATUSES.has(v['status'])) return [];
    return [
      {
        id: v['id'],
        name: typeof v['name'] === 'string' ? v['name'].slice(0, 64) : '',
        status: v['status'] as ItemEntry['status'],
        slot: typeof v['slot'] === 'string' && v['slot'] in SLOTS ? (v['slot'] as Slot) : null,
        fits: Array.isArray(v['fits']) ? v['fits'].filter(isKit) : [],
        problems: lines(v['problems']),
        warnings: lines(v['warnings']),
        manifest: typeof v['manifest'] === 'string' && HEX64.test(v['manifest']) ? v['manifest'] : null,
        createdAt: typeof v['createdAt'] === 'string' ? v['createdAt'] : '',
        published: uuidOrNull(v['published']),
        fromGallery: uuidOrNull(v['fromGallery']),
        starter: typeof v['starter'] === 'string' && STARTER_ID.test(v['starter']) ? v['starter'] : null,
      },
    ];
  });
}

/** A starter item's id (kits/items/wardrobe.json). */
export const STARTER_ID = /^[a-z0-9-]{1,64}$/;

/** One of the account's emotes and dances (S5.07). */
export interface AnimationEntry {
  id: string;
  name: string;
  use: AnimationUse;
  status: AvatarItem['status'];
  /** What the upload was: vrma, gltf, bvh or fbx, once converted. */
  source: string;
  /** It has a sound, and the sound moves the mouth. */
  sound: boolean;
  mouth: boolean;
  duration: number | null;
  loop: boolean;
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: string;
}

/** Keeps only well-formed animations from the core's answer. */
export function cleanAnimations(raw: unknown): AnimationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((a): AnimationEntry[] => {
    const v = a as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !UUID.test(v['id']) || typeof v['status'] !== 'string' || !STATUSES.has(v['status']) || !(ANIMATION_USES as readonly unknown[]).includes(v['use'])) return [];
    return [
      {
        id: v['id'],
        name: typeof v['name'] === 'string' ? v['name'].slice(0, 64) : '',
        use: v['use'] as AnimationUse,
        status: v['status'] as AnimationEntry['status'],
        source: typeof v['source'] === 'string' ? v['source'].slice(0, 8) : '',
        sound: v['sound'] === true,
        mouth: v['mouth'] === true,
        duration: typeof v['duration'] === 'number' && Number.isFinite(v['duration']) ? v['duration'] : null,
        loop: v['loop'] === true,
        problems: lines(v['problems']),
        warnings: lines(v['warnings']),
        manifest: typeof v['manifest'] === 'string' && HEX64.test(v['manifest']) ? v['manifest'] : null,
        createdAt: typeof v['createdAt'] === 'string' ? v['createdAt'] : '',
      },
    ];
  });
}

/** One entry of the free gallery (S5.06). */
export interface GalleryEntry {
  id: string;
  kind: 'avatar' | 'item';
  name: string;
  authors: string[];
  licence: Licence;
  slot: Slot | null;
  fits: BodyKit[];
  rank: string | null;
  takes: number;
  publishedAt: string;
  publisher: string;
  manifest: string;
  mine: boolean;
  taken: boolean;
}

/** Keeps only well-formed gallery entries, each with a licence that reads. */
export function cleanGallery(raw: unknown): GalleryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((e): GalleryEntry[] => {
    const v = (e ?? {}) as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !UUID.test(v['id']) || (v['kind'] !== 'avatar' && v['kind'] !== 'item') || typeof v['manifest'] !== 'string' || !HEX64.test(v['manifest'])) return [];
    let licence: Licence;
    try {
      licence = readLicence(v['licence']);
    } catch (err) {
      if (err instanceof LicenceError) return [];
      throw err;
    }
    return [
      {
        id: v['id'],
        kind: v['kind'],
        name: typeof v['name'] === 'string' ? v['name'].slice(0, 64) : '',
        authors: lines(v['authors']).map((a) => a.slice(0, 80)),
        licence,
        slot: typeof v['slot'] === 'string' && v['slot'] in SLOTS ? (v['slot'] as Slot) : null,
        fits: Array.isArray(v['fits']) ? v['fits'].filter(isKit) : [],
        rank: typeof v['rank'] === 'string' ? v['rank'].slice(0, 16) : null,
        takes: typeof v['takes'] === 'number' && Number.isInteger(v['takes']) && v['takes'] >= 0 ? v['takes'] : 0,
        publishedAt: typeof v['publishedAt'] === 'string' ? v['publishedAt'] : '',
        publisher: typeof v['publisher'] === 'string' ? v['publisher'].slice(0, 64) : '',
        manifest: v['manifest'],
        mine: v['mine'] === true,
        taken: v['taken'] === true,
      },
    ];
  });
}

/** A worn item as an outfit keeps it and the protocol carries it (S5.05). */
export interface WornEntry {
  item: string;
  adjust?: WornAdjust;
}

/** One of the account's saved outfits (S5.05). */
export interface OutfitEntry {
  id: string;
  name: string;
  items: WornEntry[];
  updatedAt: string;
}

/** A worn list from anywhere (the core, the settings file, the page): only well-formed entries,
 *  each adjustment fitted to the limits, 16 at most. */
export function cleanWorn(raw: unknown): WornEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WornEntry[] = [];
  for (const e of raw.slice(0, 16)) {
    const v = (e ?? {}) as Record<string, unknown>;
    if (typeof v['item'] !== 'string' || !HEX64.test(v['item']) || out.some((w) => w.item === v['item'])) continue;
    const a = v['adjust'] as Record<string, unknown> | undefined;
    const num = (k: string, d: number): number => (typeof a?.[k] === 'number' ? (a[k] as number) : d);
    out.push(a && typeof a === 'object' ? { item: v['item'], adjust: fitWornAdjust({ x: num('x', 0), y: num('y', 0), z: num('z', 0), rx: num('rx', 0), ry: num('ry', 0), rz: num('rz', 0), scale: num('scale', 100) }) } : { item: v['item'] });
  }
  return out;
}

export function cleanOutfits(raw: unknown): OutfitEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).flatMap((o): OutfitEntry[] => {
    const v = o as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(v['id']) || typeof v['name'] !== 'string') return [];
    return [{ id: v['id'], name: v['name'].slice(0, 64), items: cleanWorn(v['items']), updatedAt: typeof v['updatedAt'] === 'string' ? v['updatedAt'] : '' }];
  });
}

/** Keeps only well-formed avatars from the core's answer. */
export function cleanAvatars(raw: unknown): AvatarItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((a): AvatarItem[] => {
    const v = a as Record<string, unknown>;
    if (typeof v['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(v['id']) || typeof v['status'] !== 'string' || !STATUSES.has(v['status'])) return [];
    return [
      {
        id: v['id'],
        name: typeof v['name'] === 'string' ? v['name'].slice(0, 64) : '',
        status: v['status'] as AvatarItem['status'],
        rank: typeof v['rank'] === 'string' ? v['rank'].slice(0, 16) : null,
        problems: Array.isArray(v['problems']) ? v['problems'].filter((p): p is string => typeof p === 'string').slice(0, 10).map((p) => p.slice(0, 300)) : [],
        manifest: typeof v['manifest'] === 'string' && HEX64.test(v['manifest']) ? v['manifest'] : null,
        createdAt: typeof v['createdAt'] === 'string' ? v['createdAt'] : '',
        wearing: v['wearing'] === true,
        kit: isKit(v['kit']) ? v['kit'] : null,
        published: uuidOrNull(v['published']),
        fromGallery: uuidOrNull(v['fromGallery']),
      },
    ];
  });
}

/** The largest file the client fetches through a link (a level, a manifest, a thumbnail). */
export const FILE_MAX = 128 * 1024 * 1024;

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

  /** Whether this account is under 18 (S3.10; its client keeps a minor's defaults too) and
   *  whether its address is verified (S3.03). */
  async standing(access: string): Promise<{ under18: boolean; verified: boolean; supervision: string }> {
    const r = await this.call<{ under18?: unknown; emailVerified?: unknown; supervision?: unknown }>('GET', '/api/v1/me', undefined, access);
    return { under18: r.under18 === true, verified: r.emailVerified === true, supervision: typeof r.supervision === 'string' ? r.supervision.slice(0, 16) : 'none' };
  }

  /** Asks the core to mail a new verification link (S3.03); false when one went out lately. */
  async resendVerification(access: string): Promise<boolean> {
    try {
      await this.call('POST', '/api/v1/me/verify', {}, access);
      return true;
    } catch (err) {
      if (err instanceof CoreError && err.status === 429) return false;
      throw err;
    }
  }

  /** Friends, and requests both ways (S3.10). */
  async friends(access: string): Promise<{ friends: Person[]; incoming: Person[]; outgoing: Person[] }> {
    const r = await this.call<Record<string, unknown>>('GET', '/api/v1/me/friends', undefined, access);
    const people = (v: unknown): Person[] =>
      (Array.isArray(v) ? v : []).slice(0, 500).flatMap((p: unknown) => {
        const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
        return typeof o['account'] === 'string' && /^[0-9a-f-]{36}$/i.test(o['account']) ? [{ account: o['account'], name: String(o['name'] ?? '').slice(0, 64) }] : [];
      });
    return { friends: people(r['friends']), incoming: people(r['incoming']), outgoing: people(r['outgoing']) };
  }

  /** Asks to be friends, or accepts; answers `requested`, `accepted` or `already`. */
  async befriend(access: string, account: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(account)) throw new CoreError(400, 'bad-account', 'not an account id');
    const r = await this.call<{ status?: unknown }>('POST', `/api/v1/me/friends/${account}`, {}, access);
    return typeof r.status === 'string' ? r.status.slice(0, 16) : 'requested';
  }

  async unfriend(access: string, account: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(account)) throw new CoreError(400, 'bad-account', 'not an account id');
    await this.call('DELETE', `/api/v1/me/friends/${account}`, undefined, access);
  }

  /** The accounts this player blocked (S3.11). */
  async blocks(access: string): Promise<string[]> {
    const r = await this.call<{ accounts?: unknown }>('GET', '/api/v1/me/blocks', undefined, access);
    return (Array.isArray(r.accounts) ? r.accounts : []).filter((a): a is string => typeof a === 'string' && /^[0-9a-f-]{36}$/i.test(a)).slice(0, 1000);
  }

  async setBlock(access: string, account: string, on: boolean): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(account)) throw new CoreError(400, 'bad-account', 'not an account id');
    await this.call(on ? 'PUT' : 'DELETE', `/api/v1/me/blocks/${account}`, undefined, access);
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
  // ---------------------------------------------------------------- avatars (S4.01, S4.04)

  async avatars(access: string): Promise<AvatarItem[]> {
    return cleanAvatars((await this.call<{ avatars?: unknown }>('GET', '/api/v1/avatars', undefined, access)).avatars);
  }

  /** An upload slot for a file of this size and SHA-256. */
  async avatarSlot(access: string, file: { name: string; bytes: number; sha256: string }): Promise<{ id: string; url: string }> {
    const r = await this.call<{ id?: unknown; upload?: { url?: unknown; method?: unknown } }>('POST', '/api/v1/avatars', file, access);
    if (typeof r.id !== 'string' || typeof r.upload?.url !== 'string' || r.upload.method !== 'PUT') throw new CoreError(502, 'bad-answer', 'the core sent no upload slot');
    return { id: r.id, url: this.onCore(r.upload.url) };
  }

  /** A file to its slot (an avatar's, an item's). Only the core's own links are followed (its R2
   *  store's come later). */
  async sendUpload(url: string, bytes: Uint8Array): Promise<void> {
    const target = this.onCore(url);
    let res: Response;
    try {
      res = await this.fetchImpl(target, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(10 * 60_000), redirect: 'error' });
    } catch (err) {
      throw new CoreError(0, 'unreachable', `the upload did not finish: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new CoreError(res.status, typeof data['error'] === 'string' ? data['error'] : 'error', typeof data['message'] === 'string' ? data['message'] : `HTTP ${res.status}`);
    }
  }

  async wearAvatar(access: string, id: string | null): Promise<void> {
    if (id !== null && !/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an avatar id');
    await this.call('PUT', '/api/v1/me/avatar', { avatar: id }, access);
  }

  async deleteAvatar(access: string, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an avatar id');
    await this.call('DELETE', `/api/v1/avatars/${id}`, undefined, access);
  }

  /** A worn avatar's manifest and signed links to its files, and the standard body it is. */
  async avatarFiles(access: string, manifest: string): Promise<{ manifest: unknown; links: Record<string, string>; kit?: BodyKit }> {
    if (!HEX64.test(manifest)) throw new CoreError(400, 'bad-request', 'not a manifest hash');
    const r = await this.call<{ manifest?: unknown; links?: unknown; kit?: unknown }>('GET', `/api/v1/avatar-files/${manifest}`, undefined, access);
    return { manifest: r.manifest, links: this.linksOf(r.links), ...(isKit(r.kit) ? { kit: r.kit } : {}) };
  }

  private linksOf(raw: unknown): Record<string, string> {
    const links = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(links).filter((e): e is [string, string] => typeof e[1] === 'string').map(([k, v]) => [k, this.onCore(v)]));
  }

  // ---------------------------------------------------------------- standard bodies, items and outfits (S5.05)

  /** One of the standard bodies as the account's avatar: ready, or converting. */
  async takeKit(access: string, kit: BodyKit): Promise<{ id: string; status: 'ready' | 'converting' }> {
    const r = await this.call<{ id?: unknown; status?: unknown }>('POST', '/api/v1/avatars/kit', { kit }, access);
    if (typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id)) throw new CoreError(502, 'bad-answer', 'the core sent no avatar');
    return { id: r.id, status: r.status === 'ready' ? 'ready' : 'converting' };
  }

  /** One of the starter wardrobe's items (P.08), with no upload. */
  async takeStarter(access: string, starter: string): Promise<{ id: string; status: 'ready' | 'converting' }> {
    const r = await this.call<{ id?: unknown; status?: unknown }>('POST', '/api/v1/items/starter', { starter }, access);
    if (typeof r.id !== 'string' || !/^[0-9a-f-]{36}$/.test(r.id)) throw new CoreError(502, 'bad-answer', 'the core sent no item');
    return { id: r.id, status: r.status === 'ready' ? 'ready' : 'converting' };
  }

  async items(access: string): Promise<ItemEntry[]> {
    return cleanItems((await this.call<{ items?: unknown }>('GET', '/api/v1/items', undefined, access)).items);
  }

  async itemSlot(access: string, file: { name: string; bytes: number; sha256: string; declaration?: unknown }): Promise<{ id: string; url: string }> {
    const r = await this.call<{ id?: unknown; upload?: { url?: unknown; method?: unknown } }>('POST', '/api/v1/items', file, access);
    if (typeof r.id !== 'string' || typeof r.upload?.url !== 'string' || r.upload.method !== 'PUT') throw new CoreError(502, 'bad-answer', 'the core sent no upload slot');
    return { id: r.id, url: this.onCore(r.upload.url) };
  }

  async deleteItem(access: string, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an item id');
    await this.call('DELETE', `/api/v1/items/${id}`, undefined, access);
  }

  /** A worn item's manifest and signed links to its fits (by body) or its prop. */
  async itemFiles(access: string, manifest: string): Promise<{ manifest: unknown; links: Record<string, string> }> {
    if (!HEX64.test(manifest)) throw new CoreError(400, 'bad-request', 'not a manifest hash');
    const r = await this.call<{ manifest?: unknown; links?: unknown }>('GET', `/api/v1/item-files/${manifest}`, undefined, access);
    return { manifest: r.manifest, links: this.linksOf(r.links) };
  }

  async outfits(access: string): Promise<OutfitEntry[]> {
    return cleanOutfits((await this.call<{ outfits?: unknown }>('GET', '/api/v1/outfits', undefined, access)).outfits);
  }

  /** Saves an outfit, new (`id` null) or in place of one. */
  async saveOutfit(access: string, id: string | null, outfit: { name: string; items: WornEntry[] }): Promise<OutfitEntry> {
    if (id !== null && !/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an outfit id');
    const r = await this.call<unknown>(id ? 'PUT' : 'POST', id ? `/api/v1/outfits/${id}` : '/api/v1/outfits', { name: outfit.name.slice(0, 64), items: cleanWorn(outfit.items) }, access);
    const saved = cleanOutfits([r])[0];
    if (!saved) throw new CoreError(502, 'bad-answer', 'the core sent no outfit');
    return saved;
  }

  async deleteOutfit(access: string, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an outfit id');
    await this.call('DELETE', `/api/v1/outfits/${id}`, undefined, access);
  }

  // ---------------------------------------------------------------- emotes and dances (S5.07)

  async animations(access: string): Promise<AnimationEntry[]> {
    return cleanAnimations((await this.call<{ animations?: unknown }>('GET', '/api/v1/animations', undefined, access)).animations);
  }

  /** An upload slot for an animation, and for its sound when it has one (S5.07). */
  async animationSlot(access: string, file: { name: string; bytes: number; sha256: string; use: AnimationUse; audio?: { bytes: number; sha256: string } }): Promise<{ id: string; url: string; audio?: string }> {
    const r = await this.call<{ id?: unknown; upload?: { url?: unknown; method?: unknown }; audio?: { url?: unknown } }>('POST', '/api/v1/animations', file, access);
    if (typeof r.id !== 'string' || typeof r.upload?.url !== 'string' || r.upload.method !== 'PUT') throw new CoreError(502, 'bad-answer', 'the core sent no upload slot');
    if (file.audio && typeof r.audio?.url !== 'string') throw new CoreError(502, 'bad-answer', 'the core sent no slot for the sound');
    return { id: r.id, url: this.onCore(r.upload.url), ...(file.audio ? { audio: this.onCore(r.audio!.url as string) } : {}) };
  }

  async deleteAnimation(access: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw new CoreError(400, 'bad-request', 'not an animation id');
    await this.call('DELETE', `/api/v1/animations/${id}`, undefined, access);
  }

  /** A ready animation's manifest and signed links to it and its VRMA. */
  async animationFiles(access: string, manifest: string): Promise<{ manifest: unknown; links: Record<string, string> }> {
    if (!HEX64.test(manifest)) throw new CoreError(400, 'bad-request', 'not a manifest hash');
    const r = await this.call<{ manifest?: unknown; links?: unknown }>('GET', `/api/v1/animation-files/${manifest}`, undefined, access);
    return { manifest: r.manifest, links: this.linksOf(r.links) };
  }

  // ---------------------------------------------------------------- the free gallery (S5.06)

  /** A page of the gallery: by kind, slot, body and words; `before` is the last page's `next`. */
  async gallery(access: string, q: { kind?: string; slot?: string; body?: string; q?: string; before?: string }): Promise<{ entries: GalleryEntry[]; next: string | null }> {
    const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '').map(([k, v]) => [k, v.slice(0, 80)]));
    const r = await this.call<{ entries?: unknown; next?: unknown }>('GET', `/api/v1/gallery${params.size > 0 ? `?${params}` : ''}`, undefined, access);
    return { entries: cleanGallery(r.entries), next: typeof r.next === 'string' ? r.next.slice(0, 80) : null };
  }

  /** Puts one of the account's own ready avatars or items in the gallery, under a licence. */
  async publish(access: string, req: { kind: 'avatar' | 'item'; id: string; name: string; licence: Licence; affirm: boolean }): Promise<GalleryEntry> {
    if (!/^[0-9a-f-]{36}$/.test(req.id)) throw new CoreError(400, 'bad-request', 'not an id');
    const r = await this.call<unknown>('POST', '/api/v1/gallery', { kind: req.kind, id: req.id, name: req.name.slice(0, 64), licence: req.licence, affirm: req.affirm === true }, access);
    const e = cleanGallery([r])[0];
    if (!e) throw new CoreError(502, 'bad-answer', 'the core sent no entry');
    return e;
  }

  /** Takes a gallery entry: the account's own ready copy. */
  async take(access: string, id: string): Promise<{ kind: 'avatar' | 'item'; id: string }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an entry id');
    const r = await this.call<{ kind?: unknown; id?: unknown }>('POST', `/api/v1/gallery/${id}/take`, undefined, access);
    if ((r.kind !== 'avatar' && r.kind !== 'item') || typeof r.id !== 'string' || !UUID.test(r.id)) throw new CoreError(502, 'bad-answer', 'the core sent no copy');
    return { kind: r.kind, id: r.id };
  }

  async withdraw(access: string, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new CoreError(400, 'bad-request', 'not an entry id');
    await this.call('DELETE', `/api/v1/gallery/${id}`, undefined, access);
  }

  /** A file through a signed link, at most FILE_MAX bytes. */
  async file(url: string): Promise<Uint8Array> {
    const target = this.onCore(url);
    let res: Response;
    try {
      res = await this.fetchImpl(target, { signal: AbortSignal.timeout(5 * 60_000), redirect: 'error' });
    } catch (err) {
      throw new CoreError(0, 'unreachable', `the file did not come: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new CoreError(res.status, res.status === 410 ? 'link-expired' : 'error', `HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > FILE_MAX) throw new CoreError(413, 'too-large', 'the file is too large');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > FILE_MAX) throw new CoreError(413, 'too-large', 'the file is too large');
    return bytes;
  }

  /** A link only if it points at the core itself. */
  private onCore(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CoreError(502, 'bad-answer', 'the core sent a link that is not one');
    }
    if (u.origin !== this.base.origin) throw new CoreError(502, 'bad-answer', 'the core sent a link elsewhere');
    return u.href;
  }

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
