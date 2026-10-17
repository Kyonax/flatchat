// SPDX-License-Identifier: AGPL-3.0-or-later
// Moderation in the core (S3.07): a platform ban ends the sessions and blocks sign-in and joining,
// the account is shown the reason and appeals, and the owner's reversal lifts it; an upheld appeal
// shows its answer; an appeal against a world's ban goes to that world's owner, whose reversal
// reaches the world over its host channel, now or when it next connects; the host agreement is
// required to ask for a world, and a world revoked for breaking it tells its host why.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
let base = '';
const secret = randomBytes(32);
const PASSWORD = 'a long enough password';

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const form = { 'content-type': 'application/x-www-form-urlencoded' };

// Each person signs up and signs in from an address of its own, as people do: the core's limits
// count per address.
let people = 0;
const address = (email: string): string => `10.77.${[...email].reduce((n, c) => (n + c.charCodeAt(0)) % 250, 0)}.${(people % 250) + 1}`;

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const code = (await createInvitation(db, {}, new Date())).code;
  people += 1;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: address(email),
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: PASSWORD, displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  const t = await startSession(db, id, new Date());
  return { id, bearer: { authorization: `Bearer ${t.access}` } };
}

/** Signs in through the browser page as the client starts it: the status code and the page. */
async function signIn(email: string): Promise<{ status: number; body: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const lr = (await app.inject({ method: 'POST', url: '/api/v1/login-requests', payload: { challenge: createHash('sha256').update(verifier).digest('base64url'), port: 50_000 } })).json() as { request: string };
  const r = await app.inject({ method: 'POST', url: '/signin?lang=en', remoteAddress: address(email), headers: form, payload: new URLSearchParams({ request: lr.request, email, password: PASSWORD }).toString() });
  return { status: r.statusCode, body: r.body };
}

async function adminSession(email: string): Promise<{ cookie: string; csrf: string; page: () => Promise<string> }> {
  const { id } = await account(email);
  await db.query('update accounts set admin = true where id = $1', [id]);
  const r = await app.inject({ method: 'POST', url: '/admin/signin', headers: form, payload: new URLSearchParams({ email, password: PASSWORD }).toString() });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const page = async (): Promise<string> => (await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page())![1]!;
  return { cookie, csrf, page };
}

const post = (url: string, cookie: string, fields: Record<string, string>) => app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(fields).toString() });

describe('platform decisions', () => {
  it('end the sessions, block sign-in and joining, show the reason, and are lifted by a reversed appeal', async () => {
    const admin = await adminSession('mod-admin@example.org');
    const ana = await account('ana-banned@example.org');
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: ana.bearer })).statusCode).toBe(200);

    expect((await post('/admin/accounts', admin.cookie, { csrf: admin.csrf, email: 'ana-banned@example.org', action: 'ban', reason: '' })).statusCode).toBe(400);
    expect((await post('/admin/accounts', admin.cookie, { csrf: admin.csrf, email: 'ana-banned@example.org', action: 'ban', reason: 'Threats in chat' })).statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: ana.bearer })).statusCode).toBe(401);

    const shown = await signIn('ana-banned@example.org');
    expect(shown.status).toBe(403);
    expect(shown.body).toContain('The reason: Threats in chat');
    const token = /name="token" value="([^"]+)"/.exec(shown.body)![1]!;
    const sent = await app.inject({ method: 'POST', url: '/appeal?lang=en', headers: form, payload: new URLSearchParams({ token, text: 'I was quoting a film.' }).toString() });
    expect(sent.statusCode).toBe(200);
    // One appeal per decision; the token was used once.
    expect((await app.inject({ method: 'POST', url: '/appeal?lang=en', headers: form, payload: new URLSearchParams({ token, text: 'again' }).toString() })).statusCode).toBe(410);
    expect((await signIn('ana-banned@example.org')).body).toContain('is waiting for a decision');

    const page = await admin.page();
    expect(page).toContain('I was quoting a film.');
    const appeal = /action="\/admin\/appeals\/([0-9a-f-]{36})"/.exec(page)![1]!;
    expect((await post(`/admin/appeals/${appeal}`, admin.cookie, { csrf: admin.csrf, decision: 'reverse', note: 'Understood.' })).statusCode).toBe(303);
    expect((await signIn('ana-banned@example.org')).status).toBe(303);
    const actions = await db.query<{ action: string; reason: string }>('select action, reason from moderation_actions where account_id = $1 order by id', [ana.id]);
    expect(actions).toEqual([
      { action: 'ban', reason: 'Threats in chat' },
      { action: 'lift', reason: 'reversed on appeal: Understood.' },
    ]);
  });

  it('show an upheld appeal’s answer, and offer no second appeal', async () => {
    const admin = await adminSession('mod-admin2@example.org');
    await account('bo-suspended@example.org');
    await post('/admin/accounts', admin.cookie, { csrf: admin.csrf, email: 'bo-suspended@example.org', action: 'suspend', reason: 'Spam' });
    const token = /name="token" value="([^"]+)"/.exec((await signIn('bo-suspended@example.org')).body)![1]!;
    await app.inject({ method: 'POST', url: '/appeal?lang=en', headers: form, payload: new URLSearchParams({ token, text: 'It was one message.' }).toString() });
    const appeal = /action="\/admin\/appeals\/([0-9a-f-]{36})"/.exec(await admin.page())![1]!;
    await post(`/admin/appeals/${appeal}`, admin.cookie, { csrf: admin.csrf, decision: 'uphold', note: 'It was forty.' });
    const shown = await signIn('bo-suspended@example.org');
    expect(shown.status).toBe(403);
    expect(shown.body).toContain('the decision stands');
    expect(shown.body).toContain('The answer: It was forty.');
    expect(shown.body).not.toContain('name="token"');
  });
});

interface FakeWorld {
  ws: WebSocket;
  got: Array<Record<string, unknown>>;
}

/** A world on its host channel: proves its key and keeps what the core sends. */
function connectWorld(id: string, key: Uint8Array): Promise<FakeWorld> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/v1/worlds/${id}/host`, 'flatchat-host-1');
    const got: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      got.push(m);
      if (m['type'] === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: createHmac('sha256', key).update(`flatchat host v1 ${String(m['nonce'])}`).digest('base64url') }));
      if (m['type'] === 'ice') resolve({ ws, got });
    });
    ws.addEventListener('close', () => reject(new Error('closed before it was online')));
  });
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function ownWorld(owner: { bearer: Record<string, string> }, name: string): Promise<{ id: string; key: Uint8Array }> {
  const r = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: owner.bearer, payload: { name, address: 'relay', agreement: 1 } });
  expect(r.statusCode).toBe(201);
  const id = (r.json() as { id: string }).id;
  return { id, key: await approveWorld(db, sealingKey(secret), id, 'admin:test', '', new Date()) };
}

describe('appeals against a world’s ban', () => {
  it('go to the world’s owner, and a reversal reaches the world now or when it next connects', async () => {
    const owner = await account('world-owner@example.org');
    const player = await account('world-player@example.org');
    const stranger = await account('world-stranger@example.org');
    const w = await ownWorld(owner, 'Appeal Plaza');

    const appeal = await app.inject({ method: 'POST', url: `/api/v1/worlds/${w.id}/appeals`, headers: player.bearer, payload: { reason: 'Spam', text: 'I was not spamming.' } });
    expect(appeal.statusCode).toBe(201);
    const id = (appeal.json() as { id: string }).id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${w.id}/appeals`, headers: player.bearer, payload: { text: 'again' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${w.id}/appeal`, headers: player.bearer })).json()).toMatchObject({ id, status: 'pending' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/my/worlds/${w.id}/appeals`, headers: stranger.bearer })).statusCode).toBe(404);
    const listed = (await app.inject({ method: 'GET', url: `/api/v1/my/worlds/${w.id}/appeals`, headers: owner.bearer })).json() as { appeals: Array<Record<string, unknown>> };
    expect(listed.appeals).toEqual([expect.objectContaining({ id, account: player.id, name: 'world-player', reason: 'Spam', text: 'I was not spamming.', status: 'pending' })]);

    // Online: the world hears it at once and confirms it.
    const world = await connectWorld(w.id, w.key);
    const decided = await app.inject({ method: 'POST', url: `/api/v1/my/worlds/${w.id}/appeals/${id}`, headers: owner.bearer, payload: { decision: 'reverse', note: 'Sorry.' } });
    expect(decided.json()).toMatchObject({ status: 'reversed', delivered: true });
    expect(await until('unban', () => world.got.find((m) => m['type'] === 'unban'))).toEqual({ type: 'unban', appeal: id, account: player.id });
    world.ws.send(JSON.stringify({ type: 'unbanned', appeal: id }));
    await until('delivered', async () => (await db.query('select 1 from world_unbans where appeal_id = $1 and delivered_at is not null', [id]))[0]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${w.id}/appeal`, headers: player.bearer })).json()).toMatchObject({ status: 'reversed', note: 'Sorry.' });
    world.ws.close();

    // Offline: the reversal waits until the world connects.
    const second = await app.inject({ method: 'POST', url: `/api/v1/worlds/${w.id}/appeals`, headers: stranger.bearer, payload: { reason: 'Rude', text: 'It was a joke.' } });
    const id2 = (second.json() as { id: string }).id;
    await until('offline', async () => ((await app.inject({ method: 'GET', url: '/api/v1/my/worlds', headers: owner.bearer })).json() as { worlds: Array<{ id: string; online: boolean }> }).worlds.find((x) => x.id === w.id && !x.online));
    expect((await app.inject({ method: 'POST', url: `/api/v1/my/worlds/${w.id}/appeals/${id2}`, headers: owner.bearer, payload: { decision: 'reverse' } })).json()).toMatchObject({ status: 'reversed' });
    const back = await connectWorld(w.id, w.key);
    expect(await until('unban on connect', () => back.got.find((m) => m['type'] === 'unban'))).toEqual({ type: 'unban', appeal: id2, account: stranger.id });
    back.ws.close();
  });
});

describe('the host agreement', () => {
  it('is needed to ask for a world, is shown in both languages, and a revocation tells the host why', async () => {
    const host = await account('agreement-host@example.org');
    const refused = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name: 'No Agreement', address: 'relay' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'agreement-required' });
    expect((await app.inject({ method: 'GET', url: '/host-agreement?lang=en' })).body).toContain('Do not record anyone’s voice');
    expect((await app.inject({ method: 'GET', url: '/host-agreement?lang=es' })).body).toContain('No grabes la voz de nadie');

    const w = await ownWorld(host, 'Breaks Rules');
    expect((await db.query<{ agreement_version: number }>('select agreement_version from worlds where id = $1', [w.id]))[0]!.agreement_version).toBe(1);
    const admin = await adminSession('agreement-admin@example.org');
    expect((await post(`/admin/worlds/${w.id}/revoke`, admin.cookie, { csrf: admin.csrf, note: 'Broke the host agreement: it recorded voice.' })).statusCode).toBe(303);
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/my/worlds', headers: host.bearer })).json() as { worlds: Array<Record<string, unknown>> };
    expect(mine.worlds.find((x) => x['id'] === w.id)).toMatchObject({ status: 'revoked', revokedFor: 'Broke the host agreement: it recorded voice.' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${w.id}/key`, headers: host.bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${w.id}/join`, headers: host.bearer })).json()).toMatchObject({ error: 'not-approved' });
  });
});
