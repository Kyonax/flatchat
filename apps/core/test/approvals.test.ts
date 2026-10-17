// SPDX-License-Identifier: AGPL-3.0-or-later
// Approvals for other hosts (S2.10): a host asks, the owner approves on the admin page, the host
// fetches its key, the owner revokes; with the refusals around each step.
import { randomBytes } from 'node:crypto';
import { openToken } from '@flatchat/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret: randomBytes(32), publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const form = (fields: Record<string, string>, cookie?: string) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  payload: new URLSearchParams(fields).toString(),
});

async function account(email: string, admin = false): Promise<{ id: string; bearer: Record<string, string> }> {
  const code = (await createInvitation(db, {}, new Date())).code;
  const r = await app.inject({ method: 'POST', url: '/signup', ...form({ invitation: code, email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }) });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  if (admin) await db.query('update accounts set admin = true where id = $1', [id]);
  const t = await startSession(db, id, new Date());
  return { id, bearer: { authorization: `Bearer ${t.access}` } };
}

describe('approving another host’s world', () => {
  it('runs from the request to the key to the revocation', async () => {
    const host = await account('host@example.org');
    await account('owner@example.org', true);
    const stranger = await account('stranger@example.org');

    // 1. The host asks: a relayed world, pending.
    const made = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name: 'Second Home', address: 'relay', capacity: 30 } });
    const world = made.json() as { id: string; status: string };
    expect(world.status).toBe('pending');
    expect((await app.inject({ method: 'GET', url: '/api/v1/my/worlds', headers: host.bearer })).json()).toMatchObject({ worlds: [{ id: world.id, status: 'pending' }] });
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}/key`, headers: host.bearer })).json()).toMatchObject({ error: 'not-approved' });

    // 2. The admin page: only an admin signs in; forms need the session's CSRF token.
    expect((await app.inject({ method: 'GET', url: '/admin' })).headers.location).toBe('/admin/signin');
    const notAdmin = await app.inject({ method: 'POST', url: '/admin/signin', ...form({ email: 'host@example.org', password: 'a long enough password' }) });
    expect(notAdmin.statusCode).toBe(401);
    const signin = await app.inject({ method: 'POST', url: '/admin/signin', ...form({ email: 'owner@example.org', password: 'a long enough password' }) });
    expect(signin.statusCode).toBe(303);
    const setCookie = String(signin.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    const page = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Second Home');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    expect((await app.inject({ method: 'POST', url: `/admin/worlds/${world.id}/approve`, ...form({ csrf: 'wrong' }, cookie) })).statusCode).toBe(403);
    const approved = await app.inject({ method: 'POST', url: `/admin/worlds/${world.id}/approve`, ...form({ csrf }, cookie) });
    expect(approved.headers.location).toBe('/admin?done=approved');

    // 3. The host fetches its key; nobody else can.
    const keyed = (await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}/key`, headers: host.bearer })).json() as { key: string };
    expect(keyed.key).toMatch(/^[0-9a-f]{64}$/);
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}/key`, headers: stranger.bearer })).statusCode).toBe(404);
    // Tokens for the world open with that key.
    const join = (await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: stranger.bearer })).json() as { token: string };
    const opened = await openToken(new Uint8Array(Buffer.from(join.token, 'base64url')), { key: new Uint8Array(Buffer.from(keyed.key, 'hex')), world: world.id, now: Math.floor(Date.now() / 1000) });
    expect(opened.claims.name).toBe('stranger');

    // 4. Revoked: no key, no tokens.
    await app.inject({ method: 'POST', url: `/admin/worlds/${world.id}/revoke`, ...form({ csrf }, cookie) });
    expect((await app.inject({ method: 'GET', url: `/api/v1/worlds/${world.id}/key`, headers: host.bearer })).json()).toMatchObject({ error: 'not-approved' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: stranger.bearer })).statusCode).toBe(403);
    const events = await db.query<{ kind: string; actor: string }>('select kind, actor from world_events where world_id = $1 order by id', [world.id]);
    expect(events.map((e) => e.kind)).toEqual(['registered', 'approved', 'revoked']);

    // 5. Signing out ends the session.
    await app.inject({ method: 'GET', url: '/admin/signout', headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).headers.location).toBe('/admin/signin');
  });
});
