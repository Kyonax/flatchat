// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's HTTP service (DR-05): the sign-in and sign-up pages, and the JSON API the client uses.
// Built as a function so tests run every route in-process (Fastify's inject) against a real
// PostgreSQL database, and main.ts only adds the socket, the migrations and the signals.
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import { ANIMATION_AUDIO_LIMIT, ANIMATION_SOURCE_LIMIT, AVATAR_SOURCE_LIMIT, ITEM_SOURCE_LIMIT } from '@flatchat/content';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { accountById, checkInvitation, checkSignIn, cleanEmail, makeDecoy, type SignUpProblem, signUp } from './accounts.ts';
import { AbuseError, ABUSE_KINDS, type AbuseKind, abuseCases, markRemoved, markSent, openAbuseCase, purgeCases } from './abuse.ts';
import { Animations } from './animations.ts';
import { Avatars } from './avatars.ts';
import { Items } from './items.ts';
import { browse as browseGallery, copyRefused, entry as galleryEntry, publish, take, withdraw } from './gallery.ts';
import { ContentProblem } from './sandbox.ts';
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
import { MAX_MUTES, mutesOf, setMute } from './mutes.ts';
import { MailError, type Mailer, noMailer } from './mail.ts';
import { newVerification, verifyEmail } from './verify.ts';
import { emailKey } from './accounts.ts';
import {
  askGuardian,
  authorize,
  GUARDIAN_COOKIE,
  GUARDIAN_SESSION_MS,
  guardianFromCookie,
  guardianStep,
  guards,
  inviteOf,
  setContact,
  startGuardianSession,
  supervisionOf,
  teensOf,
} from './guardians.ts';
import { befriend, blocksOf, friendsOf, MAX_BLOCKS, setBlock, unfriend } from './social.ts';
import { isMinor } from './age.ts';
import { guardianAskPage, guardianInvitePage, guardianPage, guardianSigninPage } from './pages.ts';
import { agreementPage, CSS, messagePage, PAGE_POLICY, privacyPage, reportPage, signinPage, signupPage, type SignupValues, standingPage, takedownPage, takedownStatusPage } from './pages.ts';
import { struckAccounts } from './copies.ts';
import { decideTakedown, fileTakedown, removeContent, takedownProblem, takedownQueue, takedownStatus } from './takedowns.ts';
import { CLIP_MAX, cleanEvidence, decideReport, fileReport, myReports, purgeReports, REPORT_CATEGORIES, type ReportCategory, ReportError, reportClip, reportQueue, TARGET_KINDS, type TargetKind, TEXT_MAX } from './reports.ts';
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
import { type FileStore, localStore } from './store.ts';
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
  /** Sign-up by invitation only (the closed test, the default), or open with a verified email (S3.03). */
  signup?: 'invite' | 'open';
  /** How the core sends mail (S3.03): verification links, a guardian's invitation. */
  mailer?: Mailer;
  /** The file store (S4.04): avatars' levels and sources; a folder under the system's temporary
   *  directory when left out (tests). */
  store?: FileStore;
  /** Avatar and item conversion (S4.01, S5.05): KTX2 textures on (the default) or off (tests). */
  avatars?: { ktx2?: boolean };
  /** Headless Blender's executable (S5.07, S5.08), for FBX, OBJ and .blend avatars and items and
   *  FBX animations; without it those are refused. */
  blender?: string;
  /** Animation conversion (S5.07): Rhubarb Lip Sync's executable, for a sound's mouth track
   *  (without it the mouth does not follow). */
  animations?: { rhubarb?: string };
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
  const open = o.signup === 'open';
  const mailer = o.mailer ?? noMailer;
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
    reportByAccount: new RateLimiter(LIMITS.reportByAccount),
    reportByAddress: new RateLimiter(LIMITS.reportByAddress),
    takedownByAddress: new RateLimiter(LIMITS.takedownByAddress),
    uploadByAccount: new RateLimiter(LIMITS.uploadByAccount),
  };
  const hosts = new HostRegistry();
  const store = o.store ?? localStore(join(tmpdir(), `flatchat-core-store-${process.pid}`), o.secret, publicUrl);
  const blender = o.blender ? { blender: o.blender } : {};
  const avatars = new Avatars({ db: o.db, store, secret: o.secret, publicUrl, ...blender, ...(o.avatars?.ktx2 === false ? { ktx2: false } : {}), ...(o.log ? { log: o.log } : {}) });
  const items = new Items({ db: o.db, store, secret: o.secret, publicUrl, ...blender, ...(o.avatars?.ktx2 === false ? { ktx2: false } : {}), ...(o.log ? { log: o.log } : {}) });
  const animations = new Animations({ db: o.db, store, secret: o.secret, publicUrl, ...blender, ...(o.animations?.rhubarb ? { rhubarb: o.animations.rhubarb } : {}), ...(o.log ? { log: o.log } : {}) });
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
  // A conversion under way finishes before the database closes.
  app.addHook('onClose', async () => avatars.idle());
  app.addHook('onClose', async () => items.idle());
  app.addHook('onClose', async () => animations.idle());
  // Reports' evidence is kept for its time, then purged (S3.02), and so are the abuse path's sealed
  // packages after their year (S3.12): at start and every six hours.
  const purge = (): void => {
    void purgeReports(o.db, now())
      .then((n) => n > 0 && o.log?.('reports-purged', { reports: n }))
      .catch(() => undefined);
    void purgeCases(o.db, now())
      .then((n) => n > 0 && o.log?.('abuse-packages-purged', { cases: n }))
      .catch(() => undefined);
  };
  purge();
  const purgeTimer = setInterval(purge, 6 * 3_600_000);
  purgeTimer.unref();
  app.addHook('onClose', async () => clearInterval(purgeTimer));

  // Avatar files arrive as they are (S4.01): only the source route lifts the body limit for them.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
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

  // The public report form (S3.02, OQ-12): for people without an account.
  app.get('/report', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    return htmlPage(reply, reportPage(lang, REPORT_CATEGORIES));
  });

  app.post('/report', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const b = (req.body ?? {}) as Record<string, unknown>;
    const category = str(b['category'], 16) as ReportCategory;
    const what = str(b['what'], 300).trim();
    const text = str(b['text'], TEXT_MAX).trim();
    const contact = str(b['contact'], 254).trim();
    if (!REPORT_CATEGORIES.includes(category)) return reply.code(400).send();
    if (!text) return htmlPage(reply.code(400), reportPage(lang, REPORT_CATEGORIES, { category, what, contact, error: s.reportEmpty }));
    if (!limits.reportByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), reportPage(lang, REPORT_CATEGORIES, { category, what, text, contact, error: s.tooMany }));
    // A world's link or id names the world; anything else is kept as the reporter wrote it.
    const world = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(what)?.[0];
    const r = await fileReport(o.db, { contact, category, target: { kind: world ? 'world' : 'other', ...(world ? { world } : {}), ref: what }, text }, now());
    o.log?.('report', { category, from: 'public form' });
    return htmlPage(reply, messagePage(lang, s.reportSentTitle, s.reportSent.replace('{receipt}', r.receipt)));
  });

  // Takedown requests from rights holders (S5.09, G-10), and their decisions by reference.
  app.get('/takedown', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    return htmlPage(reply, takedownPage(lang));
  });

  app.post('/takedown', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = { name: str(b['name'], 200), contact: str(b['contact'], 254), work: str(b['work'], 2000), target: str(b['target'], 2000), statement: b['statement'] === 'yes', signature: str(b['signature'], 200) };
    const missing = takedownProblem(t);
    if (missing) return htmlPage(reply.code(400), takedownPage(lang, { ...t, error: s.takedownMissing[missing] }));
    if (!limits.takedownByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), takedownPage(lang, { ...t, error: s.tooMany }));
    const r = await fileTakedown(o.db, t, now());
    o.log?.('takedown-requested', {});
    return htmlPage(reply, messagePage(lang, s.takedownSentTitle, s.takedownSent.replace('{receipt}', r.receipt)));
  });

  app.get('/takedown/status', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const receipt = str(q['receipt'], 11).trim().toUpperCase();
    if (!receipt) return htmlPage(reply, takedownStatusPage(lang, '', null));
    if (!limits.takedownByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), messagePage(lang, STRINGS[lang].takedownStatusTitle, STRINGS[lang].tooMany, true));
    return htmlPage(reply, takedownStatusPage(lang, receipt, await takedownStatus(o.db, receipt)));
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
    // Open sign-up (S3.03) takes anyone without an invitation; the closed test needs one.
    if (!invitation && open) return htmlPage(reply, signupPage(lang, ''));
    const state = invitation ? await checkInvitation(o.db, invitation, now()) : 'unknown';
    if (state !== 'ok') return htmlPage(reply.code(410), messagePage(lang, s.invitationTitle, signupProblem(lang, `invitation-${state}` as SignUpProblem), true));
    return htmlPage(reply, signupPage(lang, invitation));
  });

  /** Mails a verification link for an account's address (S3.03); false when no mail went out. */
  async function sendVerification(lang: Lang, account: { id: string; email: string }): Promise<boolean> {
    const token = await newVerification(o.db, account.id, emailKey(account.email), now());
    if (!token) return false;
    const s = STRINGS[lang];
    try {
      await mailer.send({ to: account.email, subject: s.verifySubject, text: s.verifyText.replace('{link}', `${publicUrl}/verify?token=${encodeURIComponent(token)}&lang=${lang}`) });
      return true;
    } catch (err) {
      if (!(err instanceof MailError)) throw err;
      o.log?.('mail-failed', { kind: mailer.kind, why: err.message });
      return false;
    }
  }

  app.get('/verify', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    if (!limits.signinByAddress.take(req.ip, now().getTime())) return htmlPage(reply.code(429), messagePage(lang, s.verifiedTitle, s.tooMany, true));
    const r = await verifyEmail(o.db, str(q['token'], 64), now());
    return r === 'verified' ? htmlPage(reply, messagePage(lang, s.verifiedTitle, s.verified)) : htmlPage(reply.code(410), messagePage(lang, s.verifiedTitle, s.verifyExpired, true));
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
      { now: now(), cost, policy, open },
    );
    if (result.ok) {
      o.log?.('signup', { account: result.account.id });
      // Aged 13 to 17 (S3.04): name a guardian and agree to supervision before playing.
      if (isMinor(result.account.birthYear, result.account.birthMonth, now())) {
        if (!result.account.emailVerified) await sendVerification(lang, result.account);
        return htmlPage(reply.code(201), guardianAskPage(lang, await guardianStep(o.db, result.account.id, now())));
      }
      // An address no invitation vouched for is verified by mail (S3.03).
      if (!result.account.emailVerified) {
        const sent = await sendVerification(lang, result.account);
        return htmlPage(reply.code(201), messagePage(lang, s.createdTitle, sent ? s.createdCheckMail : s.created));
      }
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
    actioned: 'Report closed: acted on. The reporter reads your answer.',
    dismissed: 'Report closed: no action. The reporter reads your answer.',
    'underage-confirmed': 'The account was deleted, with its worlds.',
    'underage-cleared': 'The account’s suspension was lifted.',
    abuse: 'Taken down and preserved. File each draft on its official site, then record the reference it gave.',
    sent: 'Recorded as sent.',
    removed: 'Recorded as removed by hand.',
    'takedown-removed': 'Taken down everywhere. The claimant reads your note by their reference.',
    'takedown-rejected': 'Request rejected. The claimant reads your note by their reference.',
    'takedown-nothing': 'Nothing to remove: the request names no live gallery entry. Give its manifest’s SHA-256.',
    'content-removed': 'Taken down everywhere.',
    'remove-nothing': 'Nothing matched: no gallery entry or ready avatar or item by that ID or SHA-256.',
  };

  app.get('/admin', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const done = str((req.query as Record<string, unknown>)['done'], 24);
    return htmlPage(reply, adminWorldsPage(admin, await adminWorlds(), adminNotices[done], await pendingPlatformAppeals(o.db), await reportQueue(o.db), now(), await abuseCases(o.db), await takedownQueue(o.db), await struckAccounts(o.db)));
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
      // A world connected to the core ends its sessions at once (S3.12).
      hosts.revoke(id);
    }
    o.log?.(`world-${action}d`, { world: id });
    return reply.code(303).header('location', `/admin?done=${action}d`).send();
  });

  // The triage queue's decisions and a report's voice clip (S3.02, S3.07).
  app.post('/admin/reports/:id', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const decision = str(b['decision'], 24);
    const id = (req.params as { id: string }).id;
    if (!['actioned', 'dismissed', 'underage-confirmed', 'underage-cleared'].includes(decision) || !/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send();
    if (!(await decideReport(o.db, id, decision as 'actioned', str(b['note'], 1000).trim(), `admin:${admin.accountId}`, now()))) return reply.code(404).send();
    o.log?.('report-decided', { decision });
    return reply.code(303).header('location', `/admin?done=${decision}`).send();
  });

  // The abuse path (S3.12): from a report, take it down, preserve it and draft the authorities'
  // forms; then record each form filed by hand, and anything removed by hand.
  app.post('/admin/reports/:id/abuse', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const kind = str(b['kind'], 12) as AbuseKind;
    if (!ABUSE_KINDS.includes(kind)) return reply.code(400).send();
    try {
      const c = await openAbuseCase(
        o.db,
        o.secret,
        { kind, reportId: (req.params as { id: string }).id, ukLinked: b['uk'] === 'yes', actor: `admin:${admin.accountId}`, operator: o.operator, contact: o.contact },
        now(),
      );
      if (c.revokedWorld) hosts.revoke(c.revokedWorld);
      o.log?.('abuse-case-opened', { kind, forms: c.destinations.length });
    } catch (err) {
      if (err instanceof AbuseError) return reply.code(404).send();
      throw err;
    }
    return reply.code(303).header('location', '/admin?done=abuse').send();
  });

  app.post('/admin/abuse/:id/:what', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const { id, what } = req.params as { id: string; what: string };
    const done =
      what === 'sent'
        ? (await markSent(o.db, id, str(b['destination'], 16), str(b['reference'], 200), now())) && 'sent'
        : what === 'removed'
          ? (await markRemoved(o.db, id, str(b['how'], 300), now())) && 'removed'
          : false;
    if (!done) return reply.code(404).send();
    return reply.code(303).header('location', `/admin?done=${done}`).send();
  });

  app.get('/admin/reports/:id/clip', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(404).send();
    const clip = await reportClip(o.db, (req.params as { id: string }).id);
    if (!clip) return reply.code(404).send();
    return reply.type('audio/wav').header('cache-control', 'no-store').header('content-disposition', 'inline').send(clip);
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

  // Takedowns and removals (S5.09): a request's decision, and removing for the content rules.
  app.post('/admin/takedowns/:id', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const decision = str(b['decision'], 8);
    if (decision !== 'remove' && decision !== 'reject') return reply.code(400).send();
    const manifest = str(b['manifest'], 64).trim().toLowerCase();
    const r = await decideTakedown(o.db, (req.params as { id: string }).id, { decision, note: str(b['note'], 1000).trim(), ...(manifest ? { manifest } : {}), ban: b['ban'] === 'yes' }, `admin:${admin.accountId}`, now());
    if (!r.ok && r.why === 'not-found') return reply.code(404).send();
    // Every connected world takes it off whoever wears it there.
    if (r.ok && r.removal) hosts.each((_, send) => send({ type: 'removed', manifests: [r.removal!.manifest] }));
    o.log?.('takedown-decided', { decision, ...(r.ok && r.removal ? { avatars: r.removal.avatars, items: r.removal.items } : {}) });
    return reply.code(303).header('location', `/admin?done=${r.ok ? `takedown-${decision === 'remove' ? 'removed' : 'rejected'}` : 'takedown-nothing'}`).send();
  });

  app.post('/admin/remove', async (req, reply) => {
    const admin = await adminFromCookie(o.db, req.headers.cookie, now());
    if (!admin) return reply.code(303).header('location', '/admin/signin').send();
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!sameToken(str(b['csrf'], 64), admin.csrf)) return htmlPage(reply.code(403), adminSigninPage('The form expired. Sign in again.'));
    const what = str(b['what'], 64).trim().toLowerCase();
    const reason = str(b['reason'], 500).trim();
    if (!what || !reason) return reply.code(400).send();
    const removal = await removeContent(o.db, /^[0-9a-f]{64}$/.test(what) ? { manifest: what } : { gallery: what }, reason, now());
    if (!removal) return reply.code(303).header('location', '/admin?done=remove-nothing').send();
    hosts.each((_, send) => send({ type: 'removed', manifests: [removal.manifest] }));
    if (b['ban'] === 'yes') for (const u of removal.uploaders) await moderateAccount(o.db, u, 'ban', `uploaded what breaks the content rules: ${reason}`, `admin:${admin.accountId}`, now());
    o.log?.('content-removed', { avatars: removal.avatars, items: removal.items });
    return reply.code(303).header('location', '/admin?done=content-removed').send();
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
      // The client keeps a minor's defaults itself too (S3.10): its microphone starts muted, and
      // it drops strangers' voices and chat; the teen always sees its supervision (S3.04).
      under18: isMinor(a.birthYear, a.birthMonth, now()),
      ...(isMinor(a.birthYear, a.birthMonth, now()) ? { supervision: (await supervisionOf(o.db, a.id)).state } : {}),
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

  // Reports from the client (S3.02): the target, the text, the evidence and the reporter's voice
  // clip (a WAV the client cut from what it heard); the receipt now, the decision later.
  // ---------------------------------------------------------------- avatars (S4.01, S4.04)
  const contentProblem = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (!(err instanceof ContentProblem)) throw err;
    const status = { 'upload-trust': 403, 'upload-limit': 409, 'too-large': 413, 'bad-request': 400, 'not-found': 404, 'not-ready': 409, mismatch: 400, 'slot-expired': 410, 'outfit-limit': 409, 'publish-trust': 403, licence: 403 }[err.code];
    return sendProblem(reply, problem(status, err.code, err.message));
  };

  // An upload slot: the file's size and SHA-256 first, the file to the signed link after.
  app.post('/api/v1/avatars', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (limited(limits.uploadByAccount, a.id, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const copy = await copyRefused(o.db, a.id, str(b['sha256'], 64));
      if (copy) return sendProblem(reply, problem(403, 'licence', copy));
      const slot = await avatars.slot({ id: a.id, trust: trustOf(a, now(), o.trust ?? DEFAULT_TRUST), tester: a.tester, status: a.status }, { name: str(b['name'], 200), bytes: Number(b['bytes']), sha256: str(b['sha256'], 64) }, now());
      return reply.code(201).send({ id: slot.id, upload: { url: slot.url, method: slot.method, expiresAt: slot.expires.toISOString() } });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.put('/api/v1/avatars/:id/source', { bodyLimit: AVATAR_SOURCE_LIMIT + 1024 }, async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    if (!Buffer.isBuffer(req.body)) return sendProblem(reply, problem(415, 'bad-request', 'send the file as application/octet-stream'));
    try {
      await avatars.receive((req.params as { id: string }).id, { e: str(q['e'], 16), s: str(q['s'], 64) }, new Uint8Array(req.body), now());
      return reply.code(202).send({ status: 'converting' });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.get('/api/v1/avatars', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const list = await avatars.list(o.db, who.accountId);
    return { avatars: list.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) };
  });

  app.delete('/api/v1/avatars/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await avatars.remove(o.db, who.accountId, (req.params as { id: string }).id, now()))) return sendProblem(reply, problem(404, 'not-found', 'no such avatar'));
    return reply.code(204).send();
  });

  app.put('/api/v1/me/avatar', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const v = ((req.body ?? {}) as Record<string, unknown>)['avatar'];
    try {
      await avatars.wear(o.db, who.accountId, typeof v === 'string' ? v : null);
      return reply.code(204).send();
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  // One of the three standard bodies (S5.05): any active account takes one, with no upload.
  app.post('/api/v1/avatars/kit', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (limited(limits.uploadByAccount, a.id, reply)) return reply;
    try {
      const k = await avatars.kit({ id: a.id, status: a.status }, str(((req.body ?? {}) as Record<string, unknown>)['kit'], 32), now());
      return reply.code(k.status === 'ready' ? 200 : 202).send(k);
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  // A worn avatar's manifest and signed links, for anyone signed in (they see it in a world); a
  // standard body says which (`kit`), so the client puts the items made for it on it.
  app.get('/api/v1/avatar-files/:manifest', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const d = await avatars.delivery(o.db, (req.params as { manifest: string }).manifest, now());
    if (!d) return sendProblem(reply, problem(404, 'not-found', 'no such avatar'));
    return reply.header('cache-control', 'private, max-age=600').send(d);
  });

  // ---------------------------------------------------------------- items and outfits (S5.05)
  // An upload slot, as for avatars: the file's size and SHA-256 first, the file to the signed link after.
  app.post('/api/v1/items', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (limited(limits.uploadByAccount, a.id, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const copy = await copyRefused(o.db, a.id, str(b['sha256'], 64));
      if (copy) return sendProblem(reply, problem(403, 'licence', copy));
      const slot = await items.slot({ id: a.id, trust: trustOf(a, now(), o.trust ?? DEFAULT_TRUST), tester: a.tester, status: a.status }, { name: str(b['name'], 200), bytes: Number(b['bytes']), sha256: str(b['sha256'], 64), ...(b['declaration'] !== undefined ? { declaration: b['declaration'] } : {}) }, now());
      return reply.code(201).send({ id: slot.id, upload: { url: slot.url, method: slot.method, expiresAt: slot.expires.toISOString() } });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  // The starter wardrobe (P.08): any active account takes one of its items, with no upload.
  app.post('/api/v1/items/starter', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (limited(limits.uploadByAccount, a.id, reply)) return reply;
    try {
      const s = await items.starter({ id: a.id, status: a.status }, str(((req.body ?? {}) as Record<string, unknown>)['starter'], 64), now());
      return reply.code(s.status === 'ready' ? 200 : 202).send(s);
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.put('/api/v1/items/:id/source', { bodyLimit: ITEM_SOURCE_LIMIT + 1024 }, async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    if (!Buffer.isBuffer(req.body)) return sendProblem(reply, problem(415, 'bad-request', 'send the file as application/octet-stream'));
    try {
      await items.receive((req.params as { id: string }).id, { e: str(q['e'], 16), s: str(q['s'], 64) }, new Uint8Array(req.body), now());
      return reply.code(202).send({ status: 'converting' });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.get('/api/v1/items', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const list = await items.list(o.db, who.accountId);
    return { items: list.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) };
  });

  app.delete('/api/v1/items/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await items.remove(o.db, who.accountId, (req.params as { id: string }).id, now()))) return sendProblem(reply, problem(404, 'not-found', 'no such item'));
    return reply.code(204).send();
  });

  // A worn item's manifest and signed links to its fits (by body) or its prop, for anyone signed in.
  app.get('/api/v1/item-files/:manifest', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const d = await items.delivery(o.db, (req.params as { manifest: string }).manifest, now());
    if (!d) return sendProblem(reply, problem(404, 'not-found', 'no such item'));
    return reply.header('cache-control', 'private, max-age=600').send(d);
  });

  // ---------------------------------------------------------------- emotes and dances (S5.07)
  app.post('/api/v1/animations', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (limited(limits.uploadByAccount, a.id, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sound = b['audio'] && typeof b['audio'] === 'object' ? (b['audio'] as Record<string, unknown>) : undefined;
    try {
      const slot = await animations.slot(
        { id: a.id, trust: trustOf(a, now(), o.trust ?? DEFAULT_TRUST), tester: a.tester, status: a.status },
        { name: str(b['name'], 200), bytes: Number(b['bytes']), sha256: str(b['sha256'], 64), use: b['use'], ...(sound ? { audio: { bytes: Number(sound['bytes']), sha256: str(sound['sha256'], 64) } } : {}) },
        now(),
      );
      return reply.code(201).send({ id: slot.id, upload: { url: slot.url, method: slot.method, expiresAt: slot.expires.toISOString() }, ...(slot.audio ? { audio: { url: slot.audio, method: 'PUT' } } : {}) });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.put('/api/v1/animations/:id/source', { bodyLimit: ANIMATION_SOURCE_LIMIT + 1024 }, async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    if (!Buffer.isBuffer(req.body)) return sendProblem(reply, problem(415, 'bad-request', 'send the file as application/octet-stream'));
    try {
      await animations.receive((req.params as { id: string }).id, { e: str(q['e'], 16), s: str(q['s'], 64) }, new Uint8Array(req.body), now());
      return reply.code(202).send({ status: 'converting' });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  // The sound, to its own slot (S5.07).
  app.put('/api/v1/animations/:id/audio', { bodyLimit: ANIMATION_AUDIO_LIMIT + 1024 }, async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    if (!Buffer.isBuffer(req.body)) return sendProblem(reply, problem(415, 'bad-request', 'send the file as application/octet-stream'));
    try {
      await animations.receive((req.params as { id: string }).id, { e: str(q['e'], 16), s: str(q['s'], 64) }, new Uint8Array(req.body), now(), 'audio');
      return reply.code(202).send({ status: 'received' });
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.get('/api/v1/animations', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const list = await animations.list(o.db, who.accountId);
    return { animations: list.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) };
  });

  app.delete('/api/v1/animations/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await animations.remove(o.db, who.accountId, (req.params as { id: string }).id, now()))) return sendProblem(reply, problem(404, 'not-found', 'no such animation'));
    return reply.code(204).send();
  });

  // A ready animation's manifest and a signed link to its VRMA, for anyone signed in.
  app.get('/api/v1/animation-files/:manifest', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const d = await animations.delivery(o.db, (req.params as { manifest: string }).manifest, now());
    if (!d) return sendProblem(reply, problem(404, 'not-found', 'no such animation'));
    return reply.header('cache-control', 'private, max-age=600').send(d);
  });

  // ---------------------------------------------------------------- the free gallery (S5.06)
  const galleryJson = (e: Awaited<ReturnType<typeof galleryEntry>>): Record<string, unknown> => ({ ...e!, publishedAt: e!.publishedAt.toISOString() });
  app.get('/api/v1/gallery', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const q = req.query as Record<string, unknown>;
    const page = await browseGallery(o.db, who.accountId, { kind: q['kind'], slot: q['slot'], body: q['body'], text: str(q['q'], 64), before: str(q['before'], 80) });
    return { entries: page.entries.map((e) => galleryJson(e)), next: page.next };
  });

  app.get('/api/v1/gallery/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const e = await galleryEntry(o.db, who.accountId, (req.params as { id: string }).id);
    if (!e) return sendProblem(reply, problem(404, 'not-found', 'no such entry'));
    return galleryJson(e);
  });

  // Publishing: one of the account's own ready avatars or items, under licence fields.
  app.post('/api/v1/gallery', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const e = await publish(o.db, store, { id: a.id, trust: trustOf(a, now(), o.trust ?? DEFAULT_TRUST), tester: a.tester, status: a.status, displayName: a.displayName }, { kind: b['kind'], id: b['id'], name: str(b['name'], 200), licence: b['licence'], affirm: b['affirm'] }, now());
      return reply.code(201).send(galleryJson(e));
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  // Taking an entry: the account's own ready copy, worn like its own.
  app.post('/api/v1/gallery/:id/take', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    try {
      return await take(o.db, { id: a.id, status: a.status }, (req.params as { id: string }).id, now());
    } catch (err) {
      return contentProblem(reply, err);
    }
  });

  app.delete('/api/v1/gallery/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await withdraw(o.db, who.accountId, (req.params as { id: string }).id, now()))) return sendProblem(reply, problem(404, 'not-found', 'no such entry of yours'));
    return reply.code(204).send();
  });

  app.get('/api/v1/outfits', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return { outfits: (await items.outfits(o.db, who.accountId)).map((v) => ({ ...v, updatedAt: v.updatedAt.toISOString() })) };
  });

  const saveOutfit = async (req: FastifyRequest, reply: FastifyReply, id: string | null): Promise<FastifyReply> => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const saved = await items.saveOutfit(o.db, who.accountId, id, { name: str(b['name'], 200), items: b['items'] }, now());
      return reply.code(id === null ? 201 : 200).send({ ...saved, updatedAt: saved.updatedAt.toISOString() });
    } catch (err) {
      return contentProblem(reply, err);
    }
  };
  app.post('/api/v1/outfits', async (req, reply) => saveOutfit(req, reply, null));
  app.put('/api/v1/outfits/:id', async (req, reply) => saveOutfit(req, reply, (req.params as { id: string }).id));

  app.delete('/api/v1/outfits/:id', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await items.removeOutfit(o.db, who.accountId, (req.params as { id: string }).id))) return sendProblem(reply, problem(404, 'not-found', 'no such outfit'));
    return reply.code(204).send();
  });

  // The local store's files by signed link (S4.04): immutable, so a cache keeps them for good.
  app.get('/api/v1/files/:hash', async (req, reply) => {
    if (limited(limits.apiByAddress, req.ip, reply)) return reply;
    const hash = (req.params as { hash: string }).hash;
    const q = req.query as Record<string, unknown>;
    const check = store.verify(hash, str(q['e'], 16), str(q['s'], 64), now());
    if (check !== 'ok') return sendProblem(reply, problem(check === 'expired' ? 410 : 403, `link-${check}`, check === 'expired' ? 'the link expired: ask for a new one' : 'not a link to this file'));
    if (req.headers['if-none-match'] === `"${hash}"`) return reply.code(304).send();
    const bytes = store.read(hash);
    if (!bytes) return sendProblem(reply, problem(404, 'not-found', 'no such file'));
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'public, max-age=31536000, immutable').header('etag', `"${hash}"`).send(Buffer.from(bytes));
  });

  app.post('/api/v1/reports', { bodyLimit: Math.ceil((CLIP_MAX * 4) / 3) + 128 * 1024 }, async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.reportByAccount, who.accountId, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = (typeof b['target'] === 'object' && b['target'] !== null ? b['target'] : {}) as Record<string, unknown>;
    const category = b['category'] as ReportCategory;
    const kind = t['kind'] as TargetKind;
    const text = str(b['text'], TEXT_MAX).trim();
    if (!REPORT_CATEGORIES.includes(category) || !TARGET_KINDS.includes(kind)) return sendProblem(reply, problem(400, 'bad-request', `category (${REPORT_CATEGORIES.join(', ')}) and target.kind (${TARGET_KINDS.join(', ')})`));
    const clip = typeof b['clip'] === 'string' && b['clip'] ? new Uint8Array(Buffer.from(b['clip'], 'base64')) : undefined;
    try {
      const r = await fileReport(
        o.db,
        {
          reporter: who.accountId,
          category,
          target: { kind, ...(typeof t['account'] === 'string' ? { account: t['account'] } : {}), ...(typeof t['world'] === 'string' ? { world: t['world'] } : {}), ref: str(t['ref'], 300) },
          text,
          evidence: cleanEvidence(b['evidence']),
          ...(clip ? { clip } : {}),
        },
        now(),
      );
      o.log?.('report', { category, clip: clip !== undefined });
      return reply.code(201).send({ receipt: r.receipt, status: 'open' });
    } catch (err) {
      if (err instanceof ReportError) return sendProblem(reply, problem(400, 'bad-clip', err.message));
      throw err;
    }
  });

  // ------------------------------------------------------------- the guardian link (S3.04)

  app.post('/guardian/ask', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const b = (req.body ?? {}) as Record<string, unknown>;
    const step = str(b['step'], 64);
    const email = cleanEmail(str(b['guardianEmail'], 254));
    if (!email || b['agree'] !== 'yes') return htmlPage(reply.code(400), guardianAskPage(lang, step, s.teenEmpty));
    if (!limits.signupByAddress.take(`guardian:${req.ip}`, now().getTime())) return htmlPage(reply.code(429), messagePage(lang, s.teenTitle, s.tooMany, true));
    const asked = await askGuardian(o.db, step, emailKey(email), now());
    if (asked === 'expired') return htmlPage(reply.code(410), messagePage(lang, s.teenTitle, s.guardianExpired, true));
    const teen = await accountById(o.db, asked.teen);
    const name = teen?.displayName ?? '';
    try {
      await mailer.send({
        to: email,
        subject: s.guardianMailSubject.replace('{name}', name),
        text: s.guardianMailText.replaceAll('{name}', name).replace('{link}', `${publicUrl}/guardian/invite?invite=${encodeURIComponent(asked.invite)}&lang=${lang}`),
      });
    } catch (err) {
      if (!(err instanceof MailError)) throw err;
      o.log?.('mail-failed', { kind: mailer.kind, why: err.message });
    }
    o.log?.('guardian-asked', {});
    return htmlPage(reply, messagePage(lang, s.teenSentTitle, s.teenSent));
  });

  app.get('/guardian/invite', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const invite = str(q['invite'], 64);
    const found = await inviteOf(o.db, invite, now());
    if (!found) return htmlPage(reply.code(410), messagePage(lang, s.guardianTitle, s.guardianExpired, true));
    return htmlPage(reply, guardianInvitePage(lang, invite, found.teenName, o.contact));
  });

  app.post('/guardian/authorize', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const s = STRINGS[lang];
    const b = (req.body ?? {}) as Record<string, unknown>;
    const invite = str(b['invite'], 64);
    const found = await inviteOf(o.db, invite, now());
    if (!found) return htmlPage(reply.code(410), messagePage(lang, s.guardianTitle, s.guardianExpired, true));
    const again = (error: string, code = 400) => htmlPage(reply.code(code), guardianInvitePage(lang, invite, found.teenName, o.contact, error));
    if (b['authorize'] !== 'yes' || b['abroad'] !== 'yes') return again(s.guardianNeedsBoth);
    const t = now().getTime();
    if (!limits.signinByAddress.take(req.ip, t)) return again(s.tooMany, 429);
    let guardianId: string;
    if (b['mode'] === 'new') {
      const year = Number(str(b['birthYear'], 8));
      const month = Number(str(b['birthMonth'], 4));
      const made = await signUp(
        o.db,
        { invitation: '', email: str(b['email'], 254), password: str(b['password'], 1024), displayName: str(b['displayName'], 128), birthYear: year, birthMonth: month, country: str(b['country'], 4), consent: b['consent'] === 'yes' },
        { now: now(), cost, policy: { minors: false }, open: true },
      );
      if (!made.ok) return again(made.problem === 'age' ? s.guardianNotAdult : signupProblem(lang, made.problem));
      guardianId = made.account.id;
      // The link reached this address, so it is verified.
      if (emailKey(made.account.email) === found.emailKey) await o.db.query('update accounts set email_verified = true where id = $1', [guardianId]);
    } else {
      const signedIn = await checkSignIn(o.db, str(b['email'], 254), str(b['password'], 1024), decoy);
      if (!signedIn.ok) return again(s.signinWrong, 401);
      guardianId = signedIn.account.id;
    }
    const guardian = (await accountById(o.db, guardianId))!;
    const r = await authorize(o.db, invite, { id: guardian.id, emailKey: emailKey(guardian.email), birthYear: guardian.birthYear, birthMonth: guardian.birthMonth }, true, now());
    if (r !== 'ok') return again(r === 'not-adult' ? s.guardianNotAdult : r === 'wrong-email' ? s.guardianWrongEmail : s.guardianExpired, r === 'expired' ? 410 : 400);
    o.log?.('guardian-authorized', {});
    return htmlPage(reply, messagePage(lang, s.guardianDoneTitle, s.guardianDone.replace('{name}', found.teenName).replace('{page}', `${publicUrl}/guardian`)));
  });

  app.get('/guardian', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const lang = pickLang(q['lang'], req.headers['accept-language']);
    const g = await guardianFromCookie(o.db, req.headers.cookie, now());
    if (!g) return htmlPage(reply, guardianSigninPage(lang));
    return htmlPage(reply, guardianPage(lang, g.csrf, await teensOf(o.db, g.accountId), str(q['done'], 8) === 'saved' ? STRINGS[lang].supervisionSaved : undefined));
  });

  app.post('/guardian/signin', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = str(b['email'], 254);
    const t = now().getTime();
    if (!limits.signinByAddress.take(req.ip, t) || !limits.signinByEmail.take(`guardian:${email.trim().toLowerCase()}`, t)) return htmlPage(reply.code(429), guardianSigninPage(lang, STRINGS[lang].tooMany));
    const r = await checkSignIn(o.db, email, str(b['password'], 1024), decoy);
    if (!r.ok) return htmlPage(reply.code(401), guardianSigninPage(lang, STRINGS[lang].signinWrong));
    const session = await startGuardianSession(o.db, r.account.id, now());
    return reply
      .code(303)
      .header('set-cookie', `${GUARDIAN_COOKIE}=${session.cookie}; Max-Age=${GUARDIAN_SESSION_MS / 1000}; Path=/guardian; HttpOnly; SameSite=Strict${secureCookie}`)
      .header('location', `/guardian?lang=${lang}`)
      .send();
  });

  // A guardian's changes: who may reach the teen, and removing a friend (CSRF-checked).
  app.post('/guardian/teens/:teen', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const g = await guardianFromCookie(o.db, req.headers.cookie, now());
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!g || !sameToken(str(b['csrf'], 64), g.csrf)) return reply.code(303).header('location', `/guardian?lang=${lang}`).send();
    const contact = str(b['contact'], 16);
    if (contact !== 'friends' && contact !== 'everyone' && contact !== 'none') return reply.code(400).send();
    if (!(await setContact(o.db, g.accountId, (req.params as { teen: string }).teen, contact))) return reply.code(404).send();
    return reply.code(303).header('location', `/guardian?lang=${lang}&done=saved`).send();
  });

  app.post('/guardian/teens/:teen/unfriend/:account', async (req, reply) => {
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    const g = await guardianFromCookie(o.db, req.headers.cookie, now());
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!g || !sameToken(str(b['csrf'], 64), g.csrf)) return reply.code(303).header('location', `/guardian?lang=${lang}`).send();
    const { teen, account } = req.params as { teen: string; account: string };
    if (!(await guards(o.db, g.accountId, teen))) return reply.code(404).send();
    await unfriend(o.db, teen, account);
    return reply.code(303).header('location', `/guardian?lang=${lang}&done=saved`).send();
  });

  // A new verification link for the account's address (S3.03), one every ten minutes.
  app.post('/api/v1/me/verify', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    const a = await accountById(o.db, who.accountId);
    if (!a) return sendProblem(reply, problem(401, 'unauthorized', 'sign in again'));
    if (a.emailVerified) return { status: 'verified' };
    const lang = pickLang((req.query as Record<string, unknown>)['lang'], req.headers['accept-language']);
    if (!(await sendVerification(lang, a))) return sendProblem(reply, problem(429, 'not-sent', 'a link went out in the last ten minutes, or this core sends no mail'));
    return reply.code(202).send({ status: 'sent' });
  });

  // Friends (S3.10): asked and accepted; a minor takes no request from someone it did not ask.
  app.get('/api/v1/me/friends', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return friendsOf(o.db, who.accountId);
  });

  app.post('/api/v1/me/friends/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (limited(limits.joinByAccount, who.accountId, reply)) return reply;
    const r = await befriend(o.db, who.accountId, (req.params as { account: string }).account, now());
    if (r === 'requested' || r === 'accepted' || r === 'already') return reply.code(r === 'requested' ? 201 : 200).send({ status: r });
    return sendProblem(reply, problem(r === 'no-account' ? 404 : 403, `friend-${r}`, r === 'minor' ? 'this player takes friend requests only from people it asked' : 'not possible'));
  });

  app.delete('/api/v1/me/friends/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    await unfriend(o.db, who.accountId, (req.params as { account: string }).account);
    return reply.code(204).send();
  });

  // Blocks (S3.11): two-way, in every world; the worlds learn them from the connect token.
  app.get('/api/v1/me/blocks', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return { accounts: await blocksOf(o.db, who.accountId) };
  });

  app.put('/api/v1/me/blocks/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await setBlock(o.db, who.accountId, (req.params as { account: string }).account, true, now()))) return sendProblem(reply, problem(400, 'bad-block', `an account other than yours; ${MAX_BLOCKS} at most`));
    return reply.code(204).send();
  });

  app.delete('/api/v1/me/blocks/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    await setBlock(o.db, who.accountId, (req.params as { account: string }).account, false, now());
    return reply.code(204).send();
  });

  // Personal mutes (S3.08): the accounts this player does not hear, in every world.
  app.get('/api/v1/me/mutes', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return { accounts: await mutesOf(o.db, who.accountId) };
  });

  app.put('/api/v1/me/mutes/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    if (!(await setMute(o.db, who.accountId, (req.params as { account: string }).account, true, now()))) return sendProblem(reply, problem(400, 'bad-mute', `an account other than yours; ${MAX_MUTES} at most`));
    return reply.code(204).send();
  });

  app.delete('/api/v1/me/mutes/:account', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    await setMute(o.db, who.accountId, (req.params as { account: string }).account, false, now());
    return reply.code(204).send();
  });

  app.get('/api/v1/reports', async (req, reply) => {
    const who = await bearer(req, reply);
    if (!who) return reply;
    return { reports: (await myReports(o.db, who.accountId)).map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null })) };
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
