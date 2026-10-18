// SPDX-License-Identifier: AGPL-3.0-or-later
// Hosting from home (S1.13): TURN credentials, and a world taking its offers through the core over
// a real WebSocket, proving its key.
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { coturnCredentials, IceServers } from '../src/ice.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

describe('TURN credentials', () => {
  it("follow coturn's shared-secret scheme", () => {
    const now = new Date('2026-10-17T00:00:00Z');
    const c = coturnCredentials('s3cret', 'acct', now, 3600);
    expect(c.username).toBe(`${Math.floor(now.getTime() / 1000) + 3600}:acct`);
    expect(c.credential).toBe(createHmac('sha1', 's3cret').update(c.username).digest('base64'));
  });

  it('come with STUN, from coturn and from Cloudflare (cached)', async () => {
    let calls = 0;
    const fetchFake = async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }));
    };
    const ice = new IceServers({ stun: ['stun:a:3478'], turnUrls: ['turn:t.example.org:3478'], turnSecret: 'x', cloudflare: { keyId: 'k', token: 't' } }, fetchFake);
    const now = new Date();
    const servers = await ice.for('acct', now, 60);
    expect(servers[0]).toEqual({ urls: ['stun:a:3478'] });
    expect(servers[1]).toMatchObject({ urls: ['turn:t.example.org:3478'] });
    expect(servers[2]).toEqual({ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' });
    await ice.for('other', now, 60);
    expect(calls).toBe(1);
  });
});

let db: Db;
let app: FastifyInstance;
let base = '';
const secret = randomBytes(32);

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: ['stun:s.example.org:3478'], turnUrls: [] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

function proof(key: Uint8Array, nonce: string): string {
  return createHmac('sha256', key).update(`flatchat host v1 ${nonce}`).digest('base64url');
}

/** A fake world: connects, answers the challenge with `key`, answers offers. */
function world(id: string, key: Uint8Array): Promise<{ ws: WebSocket; got: Array<Record<string, unknown>>; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/v1/worlds/${id}/host`, 'flatchat-host-1');
    const got: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      got.push(m);
      if (m['type'] === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proof(key, String(m['nonce'])) }));
      if (m['type'] === 'offer') ws.send(JSON.stringify({ type: 'answer', id: m['id'], sdp: `answer:${String(m['sdp'])}` }));
      if (m['type'] === 'ice') resolve({ ws, got, closed });
    });
    ws.addEventListener('close', () => reject(new Error('closed before it was online')));
  });
}

describe('a world hosted from home', () => {
  it('takes offers through the core once it proves its key, and is refused with the wrong one', async () => {
    const code = (await createInvitation(db, {}, new Date())).code;
    const signup = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ invitation: code, email: 'host@example.org', password: 'a long enough password', displayName: 'Host', birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
    });
    expect(signup.statusCode).toBe(201);
    const account = (await db.query<{ id: string }>("select id from accounts where email_key = 'host@example.org'"))[0]!.id;
    const id = (await db.query<{ id: string }>("insert into worlds (name, owner_id, address) values ('Home', $1, 'relay') returning id", [account]))[0]!.id;
    const key = await approveWorld(db, sealingKey(secret), id, 'admin:test', '', new Date());
    const t = await startSession(db, account, new Date());
    const auth = { authorization: `Bearer ${t.access}` };

    // Before the world is online: the join names the relay, and a signal finds nobody.
    const join = (await app.inject({ method: 'POST', url: `/api/v1/worlds/${id}/join`, headers: auth })).json() as { address: string; iceServers: unknown };
    expect(join.address).toBe(`http://127.0.0.1:1/api/v1/worlds/${id}/signal`);
    expect(join.iceServers).toEqual([{ urls: ['stun:s.example.org:3478'] }]);
    const offline = await app.inject({ method: 'POST', url: `/api/v1/worlds/${id}/signal`, headers: auth, payload: { type: 'offer', sdp: 'v=0' } });
    expect(offline.json()).toMatchObject({ error: 'world-offline' });

    // A wrong key is refused.
    const wrong = new WebSocket(`ws://${base}/api/v1/worlds/${id}/host`, 'flatchat-host-1');
    wrong.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; nonce: string };
      if (m.type === 'challenge') wrong.send(JSON.stringify({ type: 'auth', proof: proof(new Uint8Array(32), m.nonce) }));
    });
    expect(await new Promise((r) => wrong.addEventListener('close', (e) => r(e.code)))).toBe(4003);

    // The right key: online, with its ICE servers, answering a player's offer.
    const w = await world(id, key);
    expect(w.got.map((m) => m['type'])).toEqual(['challenge', 'welcome', 'limits', 'ice']);
    const answered = await app.inject({ method: 'POST', url: `/api/v1/worlds/${id}/signal`, headers: auth, payload: { type: 'offer', sdp: 'v=0 hello' } });
    expect(answered.json()).toEqual({ type: 'answer', sdp: 'answer:v=0 hello' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${id}/signal`, payload: { type: 'offer', sdp: 'x' } })).statusCode).toBe(401);
    // A second connection replaces the first.
    const again = await world(id, key);
    expect(await w.closed).toBe(4009);

    // What the platform takes down reaches the world, which takes it off whoever wears it (S5.09).
    const manifest = 'ab'.repeat(32);
    await db.query("insert into avatars (owner_id, name, status, source_sha256, source_bytes, manifest_sha256, created_at) values ($1, 'Worn', 'ready', $2, 1, $3, now())", [account, 'cd'.repeat(32), manifest]);
    await db.query('update accounts set admin = true where id = $1', [account]);
    const signin = await app.inject({ method: 'POST', url: '/admin/signin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ email: 'host@example.org', password: 'a long enough password' }).toString() });
    const cookie = String(signin.headers['set-cookie']).split(';')[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec((await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body)![1]!;
    const removed = await app.inject({ method: 'POST', url: '/admin/remove', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, payload: new URLSearchParams({ csrf, what: manifest, reason: 'a test' }).toString() });
    expect(removed.headers.location).toBe('/admin?done=content-removed');
    const end = Date.now() + 5000;
    while (!again.got.some((m) => m['type'] === 'removed') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(again.got.filter((m) => m['type'] === 'removed')).toEqual([{ type: 'removed', manifests: [manifest] }]);
    again.ws.close();
  });
});
