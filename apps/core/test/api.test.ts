// SPDX-License-Identifier: AGPL-3.0-or-later
// The core end to end, in-process against a real PostgreSQL: invitations and sign-up with the age
// rule (S1.02, S1.03), sign-in through the browser and sessions (S1.04), worlds and their approval
// (S1.05), connect tokens (S1.06).
import { randomBytes } from 'node:crypto';
import { openToken, TokenError } from '@flatchat/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { challengeOf, newToken, sealingKey, TEST_COST } from '../src/secrets.ts';
import { approveWorld, revokeWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
let clock = new Date('2026-10-17T15:00:00Z');
const secret = randomBytes(32);
const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({
    db,
    secret,
    publicUrl: 'http://127.0.0.1:8787',
    operator: 'Test Operator',
    contact: 'privacy@example.org',
    cost: TEST_COST,
    now: () => clock,
    log: (event, fields) => lines.push({ event, fields }),
  });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(fields).toString(),
});

let ip = 0;
/** A different client address per call where rate limits are not the subject. */
const fresh = (): string => `10.0.${Math.floor(++ip / 250)}.${ip % 250}`;

function signupFields(invitation: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    invitation,
    email: 'ana@example.org',
    password: 'a long enough password',
    displayName: 'Ana María',
    birthMonth: '5',
    birthYear: '1995',
    country: 'CO',
    consent: 'yes',
    ...over,
  };
}

async function invite(email?: string): Promise<string> {
  return (await createInvitation(db, { note: 'test', ...(email ? { email } : {}) }, clock)).code;
}

async function signupWith(fields: Record<string, string>, cookie?: string) {
  return app.inject({ method: 'POST', url: '/signup?lang=en', remoteAddress: fresh(), ...form(fields), headers: { ...form(fields).headers, ...(cookie ? { cookie } : {}) } });
}

describe('sign-up by invitation (S1.02, S1.03)', () => {
  it('shows the form for a valid invitation, in the asked language, under a script-free policy', async () => {
    const code = await invite();
    const r = await app.inject({ method: 'GET', url: `/signup?invite=${code}&lang=es` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Crea tu cuenta de FlatChat');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.body).not.toMatch(/edad|13|18|age/i);
  });

  it('refuses unknown, used and expired invitations', async () => {
    expect((await app.inject({ method: 'GET', url: '/signup?invite=nope' })).statusCode).toBe(410);
    const code = await invite();
    expect((await signupWith(signupFields(code, { email: 'first@example.org' }))).statusCode).toBe(201);
    const again = await signupWith(signupFields(code, { email: 'second@example.org' }));
    expect(again.statusCode).toBe(410);
    expect(again.body).toContain('already used');
    const old = await invite();
    advance(15 * 86_400_000);
    expect((await signupWith(signupFields(old, { email: 'late@example.org' }))).statusCode).toBe(410);
  });

  it('creates the account with its authorization, and a field mistake keeps the invitation', async () => {
    const code = await invite('bea@example.org');
    const short = await signupWith(signupFields(code, { email: 'bea@example.org', password: 'short' }));
    expect(short.statusCode).toBe(400);
    expect(short.body).toContain('at least 10 characters');
    expect(short.body).toContain('value="bea@example.org"');
    const noConsent = await signupWith({ ...signupFields(code, { email: 'bea@example.org' }), consent: '' });
    expect(noConsent.statusCode).toBe(400);
    const other = await signupWith(signupFields(code, { email: 'mallory@example.org' }));
    expect(other.body).toContain('another email address');
    const ok = await signupWith(signupFields(code, { email: 'Bea@Example.org', displayName: 'Bea' }));
    expect(ok.statusCode).toBe(201);
    const [a] = await db.query<{ id: string; email_verified: boolean; country: string; password_hash: string }>(
      "select id, email_verified, country, password_hash from accounts where email_key = 'bea@example.org'",
    );
    expect(a?.email_verified).toBe(true);
    expect(a?.password_hash).toMatch(/^\$argon2id\$/);
    const consents = await db.query<{ kind: string; notice_version: string }>('select kind, notice_version from consents where account_id = $1', [a!.id]);
    expect(consents).toEqual([{ kind: 'data-processing', notice_version: '2026-10-17' }]);
    const dup = await signupWith(signupFields(await invite(), { email: 'bea@example.org' }));
    expect(dup.body).toContain('already exists');
  });

  it('refuses a minor neutrally, keeps nothing, spends the invitation and blocks a second try', async () => {
    const code = await invite();
    const before = Number((await db.query<{ n: string }>('select count(*) as n from accounts'))[0]!.n);
    const r = await signupWith(signupFields(code, { email: 'kid@example.org', birthYear: '2012', birthMonth: '1' }));
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('We cannot create an account for you right now.');
    expect(r.body).not.toMatch(/13|18|age|old/i);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain('fc_signup=refused');
    expect(cookie).toContain('HttpOnly');
    expect(Number((await db.query<{ n: string }>('select count(*) as n from accounts'))[0]!.n)).toBe(before);
    expect((await db.query("select 1 from accounts where email_key = 'kid@example.org'")).length).toBe(0);
    // The same invitation, now with an adult's date: spent.
    expect((await signupWith(signupFields(code, { email: 'kid@example.org', birthYear: '1990' }))).statusCode).toBe(410);
    // Another invitation from the same browser: the cookie answers first.
    const second = await signupWith(signupFields(await invite(), { email: 'kid@example.org', birthYear: '1990' }), 'fc_signup=refused');
    expect(second.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/signup?invite=${await invite()}`, headers: { cookie: 'fc_signup=refused' } })).statusCode).toBe(403);
    // Teens are refused in Stage 1 as well (OQ-16), Australians under 16 and Brazilian minors always.
    for (const [year, month, country] of [['2010', '1', 'CO'], ['2009', '1', 'AU'], ['2009', '1', 'BR']] as const) {
      expect((await signupWith(signupFields(await invite(), { email: `t${year}${country}@example.org`, birthYear: year, birthMonth: month, country }))).statusCode).toBe(403);
    }
  });

  it('checks the birth date and the country', async () => {
    const code = await invite();
    expect((await signupWith(signupFields(code, { email: 'c1@example.org', birthYear: '3000' }))).body).toContain('birth month');
    expect((await signupWith(signupFields(code, { email: 'c1@example.org', birthMonth: '13' }))).body).toContain('birth month');
    expect((await signupWith(signupFields(code, { email: 'c1@example.org', country: 'XX' }))).body).toContain('Choose your country');
    expect((await signupWith(signupFields(code, { email: 'c1@example.org' }))).statusCode).toBe(201);
  });
});

// --------------------------------------------------------------------------- sign-in

async function makeAccount(email: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await signupWith(signupFields(await invite(), { email, displayName: email.split('@')[0]!.padEnd(3, 'x'), ...extra }));
  expect(r.statusCode).toBe(201);
  return (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email.toLowerCase()]))[0]!.id;
}

async function loginRequest(verifier = newToken(32), port = 49_152) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/login-requests', remoteAddress: fresh(), payload: { challenge: challengeOf(verifier), port } });
  expect(r.statusCode).toBe(201);
  return { ...(r.json() as { request: string; signinUrl: string }), verifier, port };
}

async function browserSignin(request: string, email: string, password = 'a long enough password') {
  return app.inject({ method: 'POST', url: '/signin?lang=en', remoteAddress: fresh(), ...form({ request, email, password }) });
}

async function signIn(email: string): Promise<{ access: string; refresh: string }> {
  const lr = await loginRequest();
  const r = await browserSignin(lr.request, email);
  expect(r.statusCode).toBe(303);
  const code = new URL(String(r.headers.location)).searchParams.get('code')!;
  const t = await app.inject({ method: 'POST', url: '/api/v1/sessions', remoteAddress: fresh(), payload: { request: lr.request, code, verifier: lr.verifier } });
  expect(t.statusCode).toBe(200);
  return t.json();
}

describe('sign-in through the system browser (S1.04, DR-22)', () => {
  it('hands the code only to the loopback port, once, for the right verifier', async () => {
    await makeAccount('cam@example.org');
    const lr = await loginRequest(undefined, 51_234);
    expect(lr.signinUrl).toBe(`http://127.0.0.1:8787/signin?request=${lr.request}`);
    const page = await app.inject({ method: 'GET', url: `/signin?request=${lr.request}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('on this computer');
    expect((await browserSignin(lr.request, 'cam@example.org', 'wrong password!')).statusCode).toBe(401);
    expect((await browserSignin(lr.request, 'nobody@example.org')).body).toContain('do not match an account');
    const ok = await browserSignin(lr.request, 'CAM@example.org');
    expect(ok.statusCode).toBe(303);
    const target = new URL(String(ok.headers.location));
    expect(`${target.protocol}//${target.host}${target.pathname}`).toBe('http://127.0.0.1:51234/callback');
    expect(target.searchParams.get('request')).toBe(lr.request);
    const code = target.searchParams.get('code')!;
    // The page cannot be used twice.
    expect((await app.inject({ method: 'GET', url: `/signin?request=${lr.request}` })).statusCode).toBe(410);
    expect((await browserSignin(lr.request, 'cam@example.org')).statusCode).toBe(410);
    // A wrong verifier spends the request.
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { request: lr.request, code, verifier: newToken(32) } });
    expect(wrong.json()).toMatchObject({ error: 'exchange-verifier' });
    const late = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { request: lr.request, code, verifier: lr.verifier } });
    expect(late.json()).toMatchObject({ error: 'exchange-used' });
  });

  it('trades a fresh code for tokens, and not an old one', async () => {
    await makeAccount('dan@example.org');
    const lr = await loginRequest();
    const code = new URL(String((await browserSignin(lr.request, 'dan@example.org')).headers.location)).searchParams.get('code')!;
    const t = await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { request: lr.request, code, verifier: lr.verifier } });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ account: { displayName: 'dan' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { request: lr.request, code, verifier: lr.verifier } })).json()).toMatchObject({
      error: 'exchange-used',
    });
    const slow = await loginRequest();
    const slowCode = new URL(String((await browserSignin(slow.request, 'dan@example.org')).headers.location)).searchParams.get('code')!;
    advance(61_000);
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions', payload: { request: slow.request, code: slowCode, verifier: slow.verifier } })).json()).toMatchObject({
      error: 'exchange-expired',
    });
    const stale = await loginRequest();
    advance(11 * 60_000);
    expect((await app.inject({ method: 'GET', url: `/signin?request=${stale.request}` })).statusCode).toBe(410);
  });

  it('refuses malformed login requests and non-JSON API posts', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/login-requests', payload: { challenge: 'short', port: 50_000 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/login-requests', payload: { challenge: challengeOf(newToken(32)), port: 80 } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/api/v1/login-requests', ...form({ challenge: challengeOf(newToken(32)), port: '50000' }) });
    expect(r.statusCode).toBe(415);
  });

  it('rotates refresh tokens, ends a session whose old refresh token comes back, and signs out', async () => {
    await makeAccount('eve@example.org');
    const first = await signIn('eve@example.org');
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${first.access}` } });
    expect(me.json()).toMatchObject({ email: 'eve@example.org', displayName: 'eve', trust: 0, tester: false });
    expect(me.json()).not.toHaveProperty('birthYear');
    advance(16 * 60_000);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${first.access}` } })).statusCode).toBe(401);
    const second = (await app.inject({ method: 'POST', url: '/api/v1/sessions/refresh', remoteAddress: fresh(), payload: { refresh: first.refresh } })).json() as {
      access: string;
      refresh: string;
    };
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${second.access}` } })).statusCode).toBe(200);
    // The first refresh token again: someone copied it, so the whole session ends.
    const reused = await app.inject({ method: 'POST', url: '/api/v1/sessions/refresh', remoteAddress: fresh(), payload: { refresh: first.refresh } });
    expect(reused.json()).toMatchObject({ error: 'refresh-reused' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${second.access}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/refresh', remoteAddress: fresh(), payload: { refresh: second.refresh } })).json()).toMatchObject({
      error: 'refresh-revoked',
    });
    const third = await signIn('eve@example.org');
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/revoke', headers: { authorization: `Bearer ${third.access}` } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${third.access}` } })).statusCode).toBe(401);
  });

  it('limits sign-in tries per email, whoever tries', async () => {
    await makeAccount('fay@example.org');
    const lr = await loginRequest();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await browserSignin(lr.request, 'fay@example.org', `wrong guess ${i}!`)).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await browserSignin(lr.request, 'fay@example.org')).statusCode).toBe(429);
    advance(61_000);
    expect((await browserSignin(lr.request, 'fay@example.org')).statusCode).toBe(303);
  });

  it('turns away a suspended account at every door', async () => {
    const id = await makeAccount('gus@example.org');
    const t = await signIn('gus@example.org');
    await db.query("update accounts set status = 'suspended' where id = $1", [id]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${t.access}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions/refresh', remoteAddress: fresh(), payload: { refresh: t.refresh } })).json()).toMatchObject({
      error: 'refresh-inactive',
    });
    const lr = await loginRequest();
    expect((await browserSignin(lr.request, 'gus@example.org')).body).toContain('suspended');
  });

  it('never writes a token, a code, an email or a query string to its log', () => {
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/@example\.org|request=|code=|invite=|Bearer|password/);
    expect(lines.some((l) => l.event === 'request' && l.fields['route'] === '/signin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------- worlds

describe('worlds and connect tokens (S1.05, S1.06)', () => {
  it('registers a world, shows it pending, and issues tokens only once approved', async () => {
    const owner = await makeAccount('hal@example.org');
    const t = await signIn('hal@example.org');
    const auth = { authorization: `Bearer ${t.access}` };
    expect((await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: auth, payload: { name: 'Plaza', address: 'http://example.org/rtc' } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: auth, payload: { name: 'Kyonax Plaza', address: 'http://127.0.0.1:7779/rtc', capacity: 60 } });
    expect(created.statusCode).toBe(201);
    const world = created.json() as { id: string; status: string };
    expect(world.status).toBe('pending');
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}` })).json()).not.toHaveProperty('address');
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: auth })).json()).toMatchObject({ error: 'not-approved' });

    const key = await approveWorld(db, sealingKey(secret), world.id, 'admin:test', 'first world', clock);
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}` })).json()).toMatchObject({ status: 'approved', address: 'http://127.0.0.1:7779/rtc', capacity: 60 });
    const join = await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: auth });
    expect(join.statusCode).toBe(200);
    const body = join.json() as { token: string; address: string; expiresAt: number };
    expect(body.address).toBe('http://127.0.0.1:7779/rtc');
    expect(body.expiresAt).toBe(Math.floor(clock.getTime() / 1000) + 60);
    const sealed = new Uint8Array(Buffer.from(body.token, 'base64url'));
    const nowS = Math.floor(clock.getTime() / 1000);
    const opened = await openToken(sealed, { key, world: world.id, now: nowS });
    expect(opened.claims).toEqual({ account: owner, name: 'hal', trust: 0, tester: false, emailVerified: false, under18: false, ageDays: 0 });

    // Expiry, another world, tampering: each refused by the world's own check.
    await expect(openToken(sealed, { key, world: world.id, now: nowS + 60 })).rejects.toMatchObject({ code: 'expired' });
    await expect(openToken(sealed, { key, world: '00000000-0000-4000-8000-000000000000', now: nowS })).rejects.toMatchObject({ code: 'wrong-world' });
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1]! ^= 1;
    await expect(openToken(tampered, { key, world: world.id, now: nowS })).rejects.toBeInstanceOf(TokenError);
    await expect(openToken(sealed, { key: randomBytes(32), world: world.id, now: nowS })).rejects.toMatchObject({ code: 'invalid' });

    // Each token is new (its nonce lets the world refuse a replay).
    const again = (await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: auth })).json() as { token: string };
    expect(again.token).not.toBe(body.token);

    const events = await db.query<{ kind: string }>('select kind from world_events where world_id = $1 order by id', [world.id]);
    expect(events.map((e) => e.kind)).toEqual(['registered', 'approved']);
    await revokeWorld(db, world.id, 'admin:test', 'test', clock);
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: auth })).json()).toMatchObject({ error: 'not-approved' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/worlds/not-a-uuid/join', headers: auth })).statusCode).toBe(404);
  });

  it('tells a world the tester flag and the account age, never the birth date or the email', async () => {
    const id = await makeAccount('ivy@example.org');
    await db.query('update accounts set tester = true, trust = 2 where id = $1', [id]);
    const w = (await db.query<{ id: string }>("insert into worlds (name, owner_id, address) values ('Test', $1, 'http://127.0.0.1:1/rtc') returning id", [id]))[0]!;
    const key = await approveWorld(db, sealingKey(secret), w.id, 'admin:test', '', clock);
    advance(3 * 86_400_000);
    const t = await signIn('ivy@example.org');
    const r = (await app.inject({ method: 'POST', url: `/api/v1/worlds/${w.id}/join`, headers: { authorization: `Bearer ${t.access}` } })).json() as { token: string };
    const { claims } = await openToken(new Uint8Array(Buffer.from(r.token, 'base64url')), { key, world: w.id, now: Math.floor(clock.getTime() / 1000) });
    expect(claims).toMatchObject({ tester: true, trust: 2, ageDays: 3, under18: false });
    expect(JSON.stringify(claims)).not.toMatch(/ivy@|1995/);
  });
});
