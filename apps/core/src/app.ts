// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's HTTP service (DR-05): the sign-in and sign-up pages, and the JSON API the client uses.
// Built as a function so tests run every route in-process (Fastify's inject) against a real
// PostgreSQL database, and main.ts only adds the socket, the migrations and the signals.
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { accountById, checkInvitation, checkSignIn, makeDecoy, type SignUpProblem, signUp } from './accounts.ts';
import type { AgePolicy } from './age.ts';
import type { Db } from './db.ts';
import { HOST_PROTOCOL, HostRegistry, RelayError } from './hosts.ts';
import { DEFAULT_STUN, type IceConfig, IceServers } from './ice.ts';
import { LIMITS, RateLimiter } from './limits.ts';
import { CSS, messagePage, PAGE_POLICY, privacyPage, signinPage, signupPage, type SignupValues } from './pages.ts';
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
import { cleanAddress, cleanWorldName, connectToken, listWorlds, registerWorld, worldById } from './worlds.ts';

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
    if (!result.ok) {
      const error = result.problem === 'suspended' ? s.signinSuspended : result.problem === 'banned' ? s.signinBanned : s.signinWrong;
      return htmlPage(reply.code(401), signinPage(lang, request, { email, error }));
    }
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
      trust: a.trust,
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
    if (!name || !address || !Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
      return sendProblem(reply, problem(400, 'bad-request', 'a name (3-48 characters), an address (https, or http on a private address) and a capacity (1-1000)'));
    }
    const w = await registerWorld(o.db, { name, ownerId: who.accountId, address, capacity }, now());
    return reply.code(201).send({ id: w.id, name: w.name, status: w.status, capacity: w.capacity });
  });

  // The approved worlds (S1.05; the public list with favourites and capacity comes in S2.09).
  app.get('/api/v1/worlds', async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const worlds = await listWorlds(o.db, 'approved');
    return { worlds: worlds.map((w) => ({ id: w.id, name: w.name, capacity: w.capacity })) };
  });

  app.get('/api/v1/worlds/:id', async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const w = await worldById(o.db, (req.params as { id: string }).id);
    if (!w) return sendProblem(reply, problem(404, 'no-world', 'no such world'));
    return { id: w.id, name: w.name, status: w.status, capacity: w.capacity, ...(w.status === 'approved' ? { address: w.address } : {}) };
  });

  app.post('/api/v1/worlds/:id/join', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.joinByAccount, who.accountId, reply)) return reply;
    const worldId = (req.params as { id: string }).id;
    const result = await connectToken(o.db, sealing, who.accountId, worldId, now());
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
        send({ type: 'ice', iceServers: await ice.for(`world-${worldId}`, now(), 86_400) });
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
