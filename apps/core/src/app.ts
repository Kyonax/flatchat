// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's HTTP service (DR-05): the sign-in and sign-up pages, and the JSON API the client uses.
// Built as a function so tests run every route in-process (Fastify's inject) against a real
// PostgreSQL database, and main.ts only adds the socket, the migrations and the signals.
import { timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { accountById, checkInvitation, checkSignIn, makeDecoy, type SignUpProblem, signUp } from './accounts.ts';
import { ADMIN_COOKIE, ADMIN_SESSION_MS, adminFromCookie, adminSigninPage, type AdminWorld, adminWorldsPage, endAdminSession, startAdminSession } from './admin-web.ts';
import {
  APPEAL_MAX,
  appealDecision,
  appealToken,
  appealWorldBan,
  decidePlatformAppeal,
  decideWorldAppeal,
  HOST_AGREEMENT_VERSION,
  moderateAccount,
  myWorldAppeal,
  pendingPlatformAppeals,
  pendingUnbans,
  standing,
  unbanDelivered,
  worldAppeals,
} from './moderation.ts';
import type { AgePolicy } from './age.ts';
import type { Db } from './db.ts';
import { HOST_PROTOCOL, HostRegistry, RelayError } from './hosts.ts';
import { DEFAULT_STUN, type IceConfig, IceServers } from './ice.ts';
import { LIMITS, RateLimiter } from './limits.ts';
import { agreementPage, CSS, messagePage, PAGE_POLICY, privacyPage, signinPage, signupPage, type SignupValues, standingPage } from './pages.ts';
import { openWorldKey, type PasswordCost, sealingKey, STANDARD_COST } from './secrets.ts';
import {
  authenticate,
  completeLoginRequest,
  createLoginRequest,
  exchangeCode,
  loginRequestState,
  refreshSession,
  revokeSession,
  type Tokens,
  validChallenge,
  validPort,
} from './sessions.ts';
import { type Lang, pickLang, STRINGS } from './strings.ts';
import { DEFAULT_TRUST, type TrustRule, trustOf } from './trust.ts';
import {
  approveWorld,
  cleanAddress,
  cleanWorldName,
  connectToken,
  favouriteWorlds,
  listedWorlds,
  MAX_CAPACITY,
  registerWorld,
  revokeWorld,
  setFavourite,
  updateOwnWorld,
  type World,
  worldById,
} from './worlds.ts';

export const CORE_VERSION = '0.1.0';

export interface CoreOptions {
  db: Db;
  /** The core's 32-byte secret; it seals the world keys. */
  secret: Uint8Array;
  /** Where people reach the core, for the links it hands out (https in production). */
  publicUrl: string;
  /** Who runs this core and how to reach them, for the privacy notice. */
  operator: string;
  contact: string;
  cost?: PasswordCost;
  policy?: AgePolicy;
  now?: () => Date;
  /** Behind a Cloudflare Tunnel: the client's address comes from the tunnel's forwarding header. */
  behindTunnel?: boolean;
  /** One JSON line per request (method, route, status, time); never a query, a body or a token. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** STUN and TURN for players and worlds (S1.13); STUN only by default. */
  ice?: IceConfig;
  /** Trust levels' thresholds (S3.09). */
  trust?: TrustRule[];
}

type Problem = { status: number; error: string; message: string };

const problem = (status: number, error: string, message: string): Problem => ({ status, error, message });

function sendProblem(reply: FastifyReply, p: Problem, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs) reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
  return reply.code(p.status).send({ error: p.error, message: p.message });
}

function tokensBody(t: Tokens, account: { id: string; displayName: string }): Record<string, unknown> {
  return {
    access: t.access,
    refresh: t.refresh,
    accessExpiresAt: t.accessExpiresAt.toISOString(),
    refreshExpiresAt: t.refreshExpiresAt.toISOString(),
    account: { id: account.id, displayName: account.displayName },
  };
}

const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : '');

export async function buildCore(o: CoreOptions): Promise<FastifyInstance> {
  const now = o.now ?? (() => new Date());
  const cost = o.cost ?? STANDARD_COST;
  const policy = o.policy ?? { minors: false };
  const sealing = sealingKey(o.secret);
  const decoy = makeDecoy(cost);
  const publicUrl = o.publicUrl.replace(/\/+$/, '');
  const limits = {
    signinByAddress: new RateLimiter(LIMITS.signinByAddress),
    signinByEmail: new RateLimiter(LIMITS.signinByEmail),
    signupByAddress: new RateLimiter(LIMITS.signupByAddress),
    loginByAddress: new RateLimiter(LIMITS.loginByAddress),
    refreshByAddress: new RateLimiter(LIMITS.refreshByAddress),
    joinByAccount: new RateLimiter(LIMITS.joinByAccount),
    apiByAddress: new RateLimiter(LIMITS.apiByAddress),
    hostByAddress: new RateLimiter(LIMITS.hostByAddress),
  };
  const hosts = new HostRegistry();
  const ice = new IceServers(o.ice ?? { stun: DEFAULT_STUN, turnUrls: [] });

  /** A world as the world browser shows it (S2.09): online while its host channel is open, with the
   *  players it reports; its capacity is the smaller of its own and the one the owner approved. */
  function live(w: World): { id: string; name: string; online: boolean; players: number; recommended: number; capacity: number } {
    const h = hosts.status(w.id);
    const capacity = Math.min(w.capacity, h?.status?.maximum ?? w.capacity);
    const recommended = Math.min(capacity, h?.status?.recommended ?? capacity);
    return { id: w.id, name: w.name, online: h !== undefined, players: h?.status?.players ?? 0, recommended, capacity };
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: o.behindTunnel ? ['127.0.0.1', '::1'] : false,
    routerOptions: { ignoreTrailingSlash: true },
  });

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.addHook('onClose', async () => hosts.closeAll());

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    (req as FastifyRequest & { startedAt: number }).startedAt = performance.now();
  });

  // The API speaks JSON only, so a form on another site cannot post to it.
  app.addHook('preValidation', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.method !== 'POST') return;
    const type = String(req.headers['content-type'] ?? '');
    if (req.body !== undefined && !type.startsWith('application/json')) {
      return sendProblem(reply, problem(415, 'json-only', 'the API takes application/json'));
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as FastifyRequest & { startedAt?: number }).startedAt ?? performance.now();
    o.log?.('request', { method: req.method, route: req.routeOptions.url ?? 'unknown', status: reply.statusCode, ms: Math.round(performance.now() - started) });
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) return sendProblem(reply, problem(404, 'not-found', 'no such endpoint'));
    const lang = pickLang(undefined, req.headers['accept-language']);
    return htmlPage(reply.code(404), messagePage(lang, STRINGS[lang].notFound, STRINGS[lang].notFound, true));
  });

  app.setErrorHandler(async (err: { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    o.log?.('error', { route: req.routeOptions.url ?? 'unknown', status, code: err.code ?? '' });
    if (req.url.startsWith('/api/')) return sendProblem(reply, problem(status, status === 500 ? 'internal' : 'bad-request', status === 500 ? 'something went wrong' : 'the request was not understood'));
    const lang = pickLang(undefined, req.headers['accept-language']);
    return htmlPage(reply.code(status), messagePage(lang, STRINGS[lang].error, STRINGS[lang].error, true));
  });

  function htmlPage(reply: FastifyReply, body: string): FastifyReply {
    return reply.header('content-security-policy', PAGE_POLICY).type('text/html; charset=utf-8').send(body);
  }

  function limited(limiter: RateLimiter, key: string, reply: FastifyReply): boolean {
    const t = now().getTime();
    if (limiter.take(key, t)) return false;
    sendProblem(reply, problem(429, 'rate-limited', 'too many requests; wait and try again'), limiter.retryAfter(key, t));
    return true;
  }

  async function bearer(req: FastifyRequest, reply: FastifyReply): Promise<{ sessionId: string; accountId: string } | undefined> {
    if (limited(limits.apiByAddress, req.ip, reply)) return undefined;
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const who = token ? await authenticate(o.db, token, now()) : undefined;
    if (!who) {
      reply.header('www-authenticate', 'Bearer');
      sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
      return undefined;
    }
    return who;
  }

  // ------------------------------------------------------------------------------ pages

  app.get('/static/core.css', async (_req, reply) => reply.type('text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(CSS));

  app.get('/privacy', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    return htmlPage(reply, privacyPage(lang, o.operator, o.contact));
  });

  app.get('/host-agreement', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    return htmlPage(reply, agreementPage(lang, HOST_AGREEMENT_VERSION));
  });

  // An appeal against a suspension or ban (S3.07), from the form its standing page showed.
  app.post('/appeal', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!limits.signinByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), messagePage(lang, s.standingTitle, s.tooMany, true));
    const text = str(b['text'], APPEAL_MAX).trim();
    if (!text) return htmlPage(reply.code(400), messagePage(lang, s.standingTitle, s.appealEmpty, true));
    const r = await appealDecision(o.db, str(b['token'], 64), text, now());
    if (r === 'expired' || r === 'nothing') return htmlPage(reply.code(410), messagePage(lang, s.standingTitle, s.appealExpired, true));
    o.log?.('appeal', { kind: 'platform' });
    return htmlPage(reply, messagePage(lang, s.appealSentTitle, s.appealSent));
  });

  app.get('/signin', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const request = str(q['request'], 64);
    const state = request ? await loginRequestState(o.db, request, now()) : { ok: false as const };
    if (!state.ok) return htmlPage(reply.code(410), messagePage(lang, s.signinTitle, s.requestGone, true));
    return htmlPage(reply, signinPage(lang, request));
  });

  app.post('/signin', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = str(body['request'], 64);
    const email = str(body['email'], 254);
    const password = str(body['password'], 1024);
    const state = request ? await loginRequestState(o.db, request, now()) : { ok: false as const };
    if (!state.ok) return htmlPage(reply.code(410), messagePage(lang, s.signinTitle, s.requestGone, true));
    const t = now().getTime();
    if (!limits.signinByAddress.take(req.ip, t) || !limits.signinByEmail.take(email.trim().toLowerCase(), t)) {
      return htmlPage(reply.code(429), signinPage(lang, request, { email, error: s.tooMany }));
    }
    const result = await checkSignIn(o.db, email, password, decoy);
    if (!result.ok && result.problem !== 'wrong' && result.account) {
      // The password checked: the account sees the decision, its reason and its appeal (S3.07).
      const st = await standing(o.db, result.account);
      const token = st && !st.appeal ? await appealToken(o.db, result.account, now()) : undefined;
      return htmlPage(reply.code(403), standingPage(lang, result.problem, st, token));
    }
    if (!result.ok) return htmlPage(reply.code(401), signinPage(lang, request, { email, error: s.signinWrong }));
    const done = await completeLoginRequest(o.db, request, result.account.id, now());
    if (!done) return htmlPage(reply.code(410), messagePage(lang, s.signinTitle, s.requestGone, true));
    // The code goes only to the loopback port of the client that started this sign-in (RFC 8252).
    const target = `http://127.0.0.1:${done.port}/callback?request=${encodeURIComponent(request)}&code=${encodeURIComponent(done.code)}&lang=${lang}`;
    return reply.code(303).header('location', target).send();
  });

  const signupProblem = (lang: Lang, p: SignUpProblem): string => STRINGS[lang].problems[p];

  app.get('/signup', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    if (req.headers.cookie?.includes('fc_signup=refused')) return htmlPage(reply.code(403), messagePage(lang, s.refusedTitle, s.refused, true));
    const invitation = str(q['invite'], 64);
    const state = invitation ? await checkInvitation(o.db, invitation, now()) : 'unknown';
    if (state !== 'ok') return htmlPage(reply.code(410), messagePage(lang, s.invitationTitle, signupProblem(lang, `invitation-${state}` as SignUpProblem), true));
    return htmlPage(reply, signupPage(lang, invitation));
  });

  app.post('/signup', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    if (req.headers.cookie?.includes('fc_signup=refused')) return htmlPage(reply.code(403), messagePage(lang, s.refusedTitle, s.refused, true));
    if (!limits.signupByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), messagePage(lang, s.signupTitle, s.tooMany, true));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const values: SignupValues = {
      email: str(b['email'], 254),
      displayName: str(b['displayName'], 128),
      birthYear: str(b['birthYear'], 8),
      birthMonth: str(b['birthMonth'], 4),
      country: str(b['country'], 4).toUpperCase(),
    };
    const invitation = str(b['invitation'], 64);
    const year = /^\d{4}$/.test(values.birthYear ?? '') ? Number(values.birthYear) : NaN;
    const month = /^\d{1,2}$/.test(values.birthMonth ?? '') ? Number(values.birthMonth) : NaN;
    const result = await signUp(
      o.db,
      {
        invitation,
        email: values.email ?? '',
        password: str(b['password'], 1024),
        displayName: values.displayName ?? '',
        birthYear: year,
        birthMonth: month,
        country: values.country ?? '',
        consent: b['consent'] === 'yes',
      },
      { now: now(), cost, policy },
    );
    if (result.ok) {
      o.log?.('signup', { account: result.account.id });
      return htmlPage(reply.code(201), messagePage(lang, s.createdTitle, s.created));
    }
    if (result.problem === 'age') {
      // A second try in this browser sees the same answer (rr-015); nothing about the person is kept.
      const secure = publicUrl.startsWith('https:') ? '; Secure' : '';
      reply.header('set-cookie', `fc_signup=refused; Max-Age=2592000; Path=/signup; HttpOnly; SameSite=Lax${secure}`);
      return htmlPage(reply.code(403), messagePage(lang, s.refusedTitle, s.refused, true));
    }
    if (result.problem.startsWith('invitation-')) return htmlPage(reply.code(410), messagePage(lang, s.invitationTitle, signupProblem(lang, result.problem), true));
    return htmlPage(reply.code(400), signupPage(lang, invitation, { ...values, error: signupProblem(lang, result.problem) }));
  });

  // --------------------------------------------------------------------- the admin page (S2.10)

  const secureCookie = publicUrl.startsWith('https:') ? '; Secure' : '';
  const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  async function adminWorlds(): Promise<AdminWorld[]> {
    const rows = await o.db.query<{ id: string; name: string; status: string; email: string; address: string; capacity: number; created_at: Date; agreement_version: number | null }>(
      'select w.id, w.name, w.status, a.email, w.address, w.capacity, w.created_at, w.agreement_version from worlds w join accounts a on a.id = w.owner_id order by w.created_at desc limit 500',
    );
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, owner: r.email, address: r.address, capacity: r.capacity, created: r.created_at, agreement: r.agreement_version }));
  }

  const adminNotices: Record<string, string> = {
    approved: 'Approved. Its host fetches the world key with the host tool.',
    revoked: 'Revoked: no new connect tokens, and its key is gone. Its host sees the reason.',
    suspend: 'Suspended: its sessions ended. It sees the reason when it signs in, and may appeal.',
    ban: 'Banned: its sessions ended. It sees the reason when it signs in, and may appeal.',
    lift: 'Lifted: the account can sign in again.',
    reverse: 'Reversed: the decision is lifted.',
    uphold: 'Upheld: the person sees the answer when they sign in.',
    'no-account': 'No account has that email.',
  };

  app.get('/admin', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const done = str((req.query as Record<string, unknown>)['done'], 16);
    return htmlPage(reply, adminWorldsPage(admin, await adminWorlds(), adminNotices[done], await pendingPlatformAppeals(o.db)));
  });

  app.get('/admin/signin', async (_req, reply) => htmlPage(reply, adminSigninPage()));

  app.post('/admin/signin', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = str(b['email'], 254);
    const t = now().getTime();
    if (!limits.signinByAddress.take(req.ip, t) || !limits.signinByEmail.take(`admin:${email.trim().toLowerCase()}`, t)) {
      return htmlPage(reply.code(429), adminSigninPage('Too many tries. Wait a minute.'));
    }
    const result = await checkSignIn(o.db, email, str(b['password'], 1024), decoy);
    const isAdmin = result.ok && (await o.db.query<{ admin: boolean }>('select admin from accounts where id = $1', [result.account.id]))[0]?.admin === true;
    if (!result.ok || !isAdmin) return htmlPage(reply.code(401), adminSigninPage('That is not an admin account.'));
    const session = await startAdminSession(o.db, result.account.id, now());
    o.log?.('admin-signin', { account: result.account.id });
    return reply
      .code(303)
      .header('set-cookie', `${ADMIN_COOKIE}=${session.cookie}; Max-Age=${ADMIN_SESSION_MS / 1000}; Path=/admin; HttpOnly; SameSite=Strict${secureCookie}`)
      .header('location', '/admin')
      .send();
  });

  app.get('/admin/signout', async (req, reply) => {
    await endAdminSession(o.db, req.headers.cookie);
    return reply.code(303).header('set-cookie', `${ADMIN_COOKIE}=; Max-Age=0; Path=/admin; HttpOnly; SameSite=Strict${secureCookie}`).header('location', '/admin/signin').send();
  });

  app.post('/admin/worlds/:id/:action', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const { id, action } = req.params as { id: string; action: string };
    if (!sameToken(str(((req.body ?? {}) as Record<string, unknown>)['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const world = await worldById(o.db, id);
    if (!world || (action !== 'approve' && action !== 'revoke')) return reply.code(404).send();
    if (action === 'approve') await approveWorld(o.db, sealing, id, `admin:${admin.accountId}`, 'admin page', now());
    else {
      // A revocation says why (S3.07): for a host that broke the host agreement, which rule.
      const note = str(((req.body ?? {}) as Record<string, unknown>)['note'], 500).trim() || 'revoked on the admin page';
      await revokeWorld(o.db, id, `admin:${admin.accountId}`, note, now());
    }
    o.log?.(`world-${action}d`, { world: id });
    return reply.code(303).header('location', `/admin?done=${action}d`).send();
  });

  // The owner suspends, bans or lifts an account, with the reason it is shown (S3.07, G-11).
  app.post('/admin/accounts', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const action = str(b['action'], 16);
    const reason = str(b['reason'], 1000).trim();
    if ((action !== 'suspend' && action !== 'ban' && action !== 'lift') || !reason) return reply.code(400).send();
    const [a] = await o.db.query<{ id: string }>('select id from accounts where email_key = $1', [str(b['email'], 254).trim().toLowerCase()]);
    if (!a) return reply.code(303).header('location', '/admin?done=no-account').send();
    await moderateAccount(o.db, a.id, action, reason, `admin:${admin.accountId}`, now());
    o.log?.('account-moderated', { action });
    return reply.code(303).header('location', `/admin?done=${action}`).send();
  });

  app.post('/admin/appeals/:id', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const decision = str(b['decision'], 16);
    const id = (req.params as { id: string }).id;
    if ((decision !== 'reverse' && decision !== 'uphold') || !/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send();
    if (!(await decidePlatformAppeal(o.db, id, decision, str(b['note'], 1000).trim(), `admin:${admin.accountId}`, now()))) return reply.code(404).send();
    o.log?.('appeal-decided', { kind: 'platform', decision });
    return reply.code(303).header('location', `/admin?done=${decision}`).send();
  });

  // -------------------------------------------------------------------------------- API

  app.get('/api/v1/health', async () => ({ ok: true, version: CORE_VERSION }));

  app.post('/api/v1/login-requests', async (req, reply) => {
    if (limited(limits.loginByAddress, req.ip, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!validChallenge(b['challenge']) || !validPort(b['port'])) return sendProblem(reply, problem(400, 'bad-request', 'challenge (S256, base64url) and port (1024-65535) are required'));
    const { id, expiresAt } = await createLoginRequest(o.db, b['challenge'], b['port'], now());
    return reply.code(201).send({ request: id, signinUrl: `${publicUrl}/signin?request=${encodeURIComponent(id)}`, expiresAt: expiresAt.toISOString() });
  });

  app.post('/api/v1/sessions', async (req, reply) => {
    if (limited(limits.loginByAddress, req.ip, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await exchangeCode(o.db, str(b['request'], 64), str(b['code'], 64), str(b['verifier'], 128), now());
    if (!result.ok) return sendProblem(reply, problem(400, `exchange-${result.problem}`, 'start the sign-in again'));
    const account = await accountById(o.db, result.tokens.accountId);
    return reply.send(tokensBody(result.tokens, account!));
  });

  app.post('/api/v1/sessions/refresh', async (req, reply) => {
    if (limited(limits.refreshByAddress, req.ip, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await refreshSession(o.db, str(b['refresh'], 64), now());
    if (!result.ok) return sendProblem(reply, problem(401, `refresh-${result.problem}`, 'sign in again'));
    const account = await accountById(o.db, result.tokens.accountId);
    return reply.send(tokensBody(result.tokens, account!));
  });

  app.post('/api/v1/sessions/revoke', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    await revokeSession(o.db, who.sessionId, 'signed out', now());
    return reply.code(204).send();
  });

  app.get('/api/v1/me', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    return {
      id: a.id,
      displayName: a.displayName,
      email: a.email,
      emailVerified: a.emailVerified,
      trust: trustOf(a, now(), o.trust ?? DEFAULT_TRUST),
      tester: a.tester,
      createdAt: a.createdAt.toISOString(),
    };
  });

  app.post('/api/v1/worlds', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = cleanWorldName(str(b['name'], 200));
    const address = cleanAddress(str(b['address'], 300));
    const capacity = b['capacity'] === undefined ? 50 : Number(b['capacity']);
    const listed = b['listed'] === undefined ? true : b['listed'];
    if (!name || !address || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY || typeof listed !== 'boolean') {
      return sendProblem(reply, problem(400, 'bad-request', `a name (3-48 characters), an address (https, or http on a private address), a capacity (1-${MAX_CAPACITY}) and listed (true or false)`));
    }
    // Every host accepts the host agreement before a world is registered (S3.07).
    if (b['agreement'] !== HOST_AGREEMENT_VERSION) {
      return sendProblem(reply, problem(400, 'agreement-required', `accept the host agreement (version ${HOST_AGREEMENT_VERSION}, ${publicUrl}/host-agreement): send agreement: ${HOST_AGREEMENT_VERSION}`));
    }
    const w = await registerWorld(o.db, { name, ownerId: who.accountId, address, capacity, listed, agreement: HOST_AGREEMENT_VERSION }, now());
    return reply.code(201).send({ id: w.id, name: w.name, status: w.status, capacity: w.capacity, listed: w.listed });
  });

  // The public list (S2.09, Q-L4, Q-L19): approved, listed worlds that are online and below their
  // recommended count; a world drops off it at that count, and is still reached by its id or a
  // favourite up to its capacity. Busiest first.
  app.get('/api/v1/worlds', async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const open = (await listedWorlds(o.db))
      .map(live)
      .filter((w) => w.online && w.players < w.recommended)
      .sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
    return { worlds: open.slice(0, 200) };
  });

  // Favourites (S2.09, Q-L11): kept with the account, so they follow it to any computer.
  app.get('/api/v1/me/favourites', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return { worlds: (await favouriteWorlds(o.db, who.accountId)).map((w) => ({ ...live(w), status: w.status })) };
  });

  app.put('/api/v1/me/favourites/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const result = await setFavourite(o.db, who.accountId, (req.params as { id: string }).id, true, now());
    if (result === 'no-world') return sendProblem(reply, problem(404, 'no-world', 'no such world'));
    if (result === 'too-many') return sendProblem(reply, problem(409, 'too-many', 'an account keeps up to 100 favourites'));
    return reply.code(204).send();
  });

  app.delete('/api/v1/me/favourites/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const id = (req.params as { id: string }).id;
    if (/^[0-9a-f-]{36}$/i.test(id)) await setFavourite(o.db, who.accountId, id, false, now());
    return reply.code(204).send();
  });

  // A host's own worlds, and an approved world's key (S2.10): only for the account that registered it.
  app.get('/api/v1/my/worlds', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const rows = await o.db.query<{ id: string; name: string; status: string; address: string; capacity: number; listed: boolean; agreement: number | null; note: string | null }>(
      `select w.id, w.name, w.status, w.address, w.capacity, w.listed, w.agreement_version as agreement,
              (select e.note from world_events e where e.world_id = w.id and e.kind = 'revoked' order by e.id desc limit 1) as note
         from worlds w where owner_id = $1 order by created_at`,
      [who.accountId],
    );
    // A revoked world's host reads why (S3.07).
    return { worlds: rows.map(({ note, ...r }) => ({ ...r, ...(r.status === 'revoked' ? { revokedFor: note ?? '' } : {}), online: hosts.online(r.id), players: hosts.status(r.id)?.status?.players ?? 0 })) };
  });

  // Appeals against a world's ban (S3.07): the banned player sends one to the world's owner, who
  // decides with the host tool; a reversal goes to the world over its host channel.
  app.post('/api/v1/worlds/:id/appeals', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.joinByAccount, who.accountId, reply)) return reply;
    const w = await worldById(o.db, (req.params as { id: string }).id);
    if (!w) return sendProblem(reply, problem(404, 'no-world', 'no such world'));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = str(b['text'], APPEAL_MAX).trim();
    if (!text) return sendProblem(reply, problem(400, 'bad-request', 'text: why the ban is wrong'));
    const r = await appealWorldBan(o.db, who.accountId, w.id, str(b['reason'], 500), text, now());
    if (r === 'pending') return sendProblem(reply, problem(409, 'appeal-pending', 'an appeal to this world waits for its owner'));
    o.log?.('appeal', { kind: 'world', world: w.id });
    return reply.code(201).send({ id: r.id, status: 'pending' });
  });

  app.get('/api/v1/worlds/:id/appeal', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await myWorldAppeal(o.db, who.accountId, (req.params as { id: string }).id);
    if (!a) return sendProblem(reply, problem(404, 'no-appeal', 'no appeal to this world'));
    return { id: a.id, status: a.status, createdAt: a.createdAt.toISOString(), decidedAt: a.decidedAt?.toISOString() ?? null, note: a.note };
  });

  const ownWorld = async (accountId: string, id: string): Promise<boolean> =>
    /^[0-9a-f-]{36}$/i.test(id) && (await o.db.query('select 1 from worlds where id = $1 and owner_id = $2', [id, accountId])).length > 0;

  app.get('/api/v1/my/worlds/:id/appeals', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const id = (req.params as { id: string }).id;
    if (!(await ownWorld(who.accountId, id))) return sendProblem(reply, problem(404, 'no-world', 'no such world of yours'));
    return { appeals: (await worldAppeals(o.db, id)).map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })) };
  });

  app.post('/api/v1/my/worlds/:id/appeals/:appeal', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const { id, appeal } = req.params as { id: string; appeal: string };
    if (!(await ownWorld(who.accountId, id))) return sendProblem(reply, problem(404, 'no-world', 'no such world of yours'));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const decision = b['decision'];
    if ((decision !== 'reverse' && decision !== 'uphold') || !/^[0-9a-f-]{36}$/i.test(appeal)) return sendProblem(reply, problem(400, 'bad-request', 'decision: reverse or uphold'));
    const r = await decideWorldAppeal(o.db, id, appeal, decision, str(b['note'], 1000).trim(), `account:${who.accountId}`, now());
    if (!r) return sendProblem(reply, problem(404, 'no-appeal', 'no such appeal waiting'));
    if (r.account) hosts.send(id, { type: 'unban', appeal, account: r.account });
    o.log?.('appeal-decided', { kind: 'world', decision });
    return { id: appeal, status: decision === 'reverse' ? 'reversed' : 'upheld', delivered: r.account ? hosts.online(id) : undefined };
  });

  // A host lists or unlists its world, or changes its capacity (S2.09).
  app.post('/api/v1/my/worlds/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const capacity = b['capacity'] === undefined ? undefined : Number(b['capacity']);
    if ((b['listed'] !== undefined && typeof b['listed'] !== 'boolean') || (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY))) {
      return sendProblem(reply, problem(400, 'bad-request', `listed (true or false) and a capacity (1-${MAX_CAPACITY})`));
    }
    const w = await updateOwnWorld(o.db, who.accountId, (req.params as { id: string }).id, {
      ...(typeof b['listed'] === 'boolean' ? { listed: b['listed'] } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
    });
    if (!w) return sendProblem(reply, problem(404, 'no-world', 'no such world of yours'));
    hosts.limits(w.id, w.capacity);
    return { id: w.id, name: w.name, status: w.status, capacity: w.capacity, listed: w.listed };
  });

  app.get('/api/v1/worlds/:id/key', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const id = (req.params as { id: string }).id;
    const [w] = /^[0-9a-f-]{36}$/i.test(id) ? await o.db.query<{ owner_id: string; status: string; key_sealed: Buffer | null }>('select owner_id, status, key_sealed from worlds where id = $1', [id]) : [];
    if (!w || w.owner_id !== who.accountId) return sendProblem(reply, problem(404, 'no-world', 'no such world of yours'));
    if (w.status !== 'approved' || !w.key_sealed) return sendProblem(reply, problem(403, 'not-approved', 'the world is not approved'));
    o.log?.('world-key', { world: id });
    return { world: id, key: Buffer.from(openWorldKey(sealing, id, w.key_sealed)).toString('hex') };
  });

  app.get('/api/v1/worlds/:id', async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const w = await worldById(o.db, (req.params as { id: string }).id);
    if (!w) return sendProblem(reply, problem(404, 'no-world', 'no such world'));
    return { ...live(w), status: w.status, listed: w.listed, ...(w.status === 'approved' ? { address: w.address } : {}) };
  });

  app.post('/api/v1/worlds/:id/join', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.joinByAccount, who.accountId, reply)) return reply;
    const worldId = (req.params as { id: string }).id;
    // A world that reports itself full takes no one else, whatever its own count says (S2.09).
    const known = hosts.status(worldId)?.status;
    const w = known ? await worldById(o.db, worldId) : undefined;
    if (w && known && known.players >= live(w).capacity) return sendProblem(reply, problem(403, 'full', 'this world is full'));
    const result = await connectToken(o.db, sealing, who.accountId, worldId, now(), o.trust ?? DEFAULT_TRUST);
    if (!result.ok) return sendProblem(reply, problem(result.problem === 'no-world' ? 404 : 403, result.problem, 'this world cannot be joined now'));
    const sealed = Buffer.from(result.token).toString('base64url');
    // A world hosted from home takes its offers through the core (S1.13).
    const address = result.address === 'relay' ? `${publicUrl}/api/v1/worlds/${worldId}/signal` : result.address;
    return { token: sealed, address, expiresAt: result.expiresAt, iceServers: await ice.for(who.accountId, now(), 3600) };
  });

  // ------------------------------------------------------------- hosting from home (S1.13)

  // A world's host channel: an outbound WebSocket from the world server, which proves it holds the
  // world's key and then answers the offers relayed below.
  app.get('/api/v1/worlds/:id/host', { websocket: true }, (socket, req) => {
    const worldId = (req.params as { id: string }).id;
    if (!limits.hostByAddress.take(req.ip, now().getTime()) || !String(req.headers['sec-websocket-protocol'] ?? '').includes(HOST_PROTOCOL)) {
      socket.close(4029, 'refused');
      return;
    }
    hosts.accept(
      worldId,
      socket,
      async () => {
        const w = /^[0-9a-f-]{36}$/i.test(worldId) ? (await o.db.query<{ status: string; key_sealed: Buffer | null }>('select status, key_sealed from worlds where id = $1', [worldId]))[0] : undefined;
        return w?.status === 'approved' && w.key_sealed ? openWorldKey(sealing, worldId, w.key_sealed) : undefined;
      },
      async (send) => {
        o.log?.('host-online', { world: worldId });
        // The capacity the owner approved: the world takes no more players than this (S2.09).
        const w = await worldById(o.db, worldId);
        if (w) send({ type: 'limits', maximum: w.capacity });
        send({ type: 'ice', iceServers: await ice.for(`world-${worldId}`, now(), 86_400) });
        // Bans its owner reversed on appeal while it was away (S3.07).
        for (const u of await pendingUnbans(o.db, worldId)) send({ type: 'unban', appeal: u.appeal, account: u.account });
      },
      async (m) => {
        if (m['type'] === 'unbanned' && typeof m['appeal'] === 'string' && /^[0-9a-f-]{36}$/i.test(m['appeal'])) await unbanDelivered(o.db, worldId, m['appeal'], now());
      },
    );
  });

  app.post('/api/v1/worlds/:id/signal', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.joinByAccount, who.accountId, reply)) return reply;
    const worldId = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b['type'] !== 'offer' || typeof b['sdp'] !== 'string' || b['sdp'].length > 64 * 1024) return sendProblem(reply, problem(400, 'bad-offer', 'an offer is { type: "offer", sdp }'));
    const w = await worldById(o.db, worldId);
    if (!w || w.status !== 'approved' || w.address !== 'relay') return sendProblem(reply, problem(404, 'no-world', 'no such world takes offers here'));
    try {
      return { type: 'answer', sdp: await hosts.relay(worldId, b['sdp']) };
    } catch (err) {
      const code = err instanceof RelayError ? err.code : 'world-error';
      return sendProblem(reply, problem(code === 'world-timeout' ? 504 : 503, code, 'the world cannot be reached right now'));
    }
  });

  return app;
}
