// SPDX-License-Identifier: AGPL-3.0-or-later
// Friends and blocks (S3.10, S3.11): asked and accepted; a minor takes no request from a stranger
// but may ask; a block is two-way, ends a friendship and stops new ones; the connect token carries
// the blocked pairs both ways and a minor's friends, never an adult's.
import { randomBytes } from 'node:crypto';
import { openToken } from '@flatchat/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld, registerWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
const secret = randomBytes(32);
const form = { 'content-type': 'application/x-www-form-urlencoded' };

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let people = 0;
async function account(name: string, minor = false): Promise<{ id: string; bearer: Record<string, string> }> {
  people += 1;
  const email = `${name.toLowerCase()}@example.org`;
  const code = (await createInvitation(db, {}, new Date())).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.91.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: name, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  // Sign-up refuses minors until Stage 3's gate opens (OQ-16): a test minor is made by hand, with
  // its guardian's authorization already given (S3.04), so it may join worlds.
  if (minor) {
    await db.query('update accounts set birth_year = $2 where id = $1', [id, new Date().getUTCFullYear() - 15]);
    await db.query("insert into guardian_links (teen_id, guardian_email_key, teen_agreed_at, authorized_at, method, created_at) values ($1, 'guardian@example.org', now(), now(), 'test', now())", [id]);
  }
  return { id, bearer: { authorization: `Bearer ${(await startSession(db, id, new Date())).access}` } };
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: { bearer: Record<string, string> }) => app.inject({ method, url, headers: who.bearer });

describe('friends', () => {
  it('are asked and accepted, and either side ends it', async () => {
    const ana = await account('AnaF');
    const bo = await account('BoF');
    expect((await call('POST', `/api/v1/me/friends/${bo.id}`, ana)).json()).toEqual({ status: 'requested' });
    expect(((await call('GET', '/api/v1/me/friends', bo)).json() as { incoming: unknown[] }).incoming).toEqual([{ account: ana.id, name: 'AnaF' }]);
    expect((await call('POST', `/api/v1/me/friends/${ana.id}`, bo)).json()).toEqual({ status: 'accepted' });
    expect((await call('GET', '/api/v1/me/friends', ana)).json()).toEqual({ friends: [{ account: bo.id, name: 'BoF' }], incoming: [], outgoing: [] });
    expect((await call('DELETE', `/api/v1/me/friends/${ana.id}`, bo)).statusCode).toBe(204);
    expect(((await call('GET', '/api/v1/me/friends', ana)).json() as { friends: unknown[] }).friends).toEqual([]);
    expect((await call('POST', `/api/v1/me/friends/${ana.id}`, ana)).statusCode).toBe(403);
  });

  it('never come to a minor from a stranger; the minor may ask', async () => {
    const teen = await account('TeenF', true);
    const stranger = await account('StrangerF');
    const cousin = await account('CousinF');
    expect((await call('GET', '/api/v1/me', teen)).json()).toMatchObject({ under18: true });
    const refused = await call('POST', `/api/v1/me/friends/${teen.id}`, stranger);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'friend-minor' });
    expect((await call('POST', `/api/v1/me/friends/${cousin.id}`, teen)).json()).toEqual({ status: 'requested' });
    expect((await call('POST', `/api/v1/me/friends/${teen.id}`, cousin)).json()).toEqual({ status: 'accepted' });
  });
});

describe('blocks', () => {
  it('are two-way, end a friendship, stop new ones, and ride in the connect token both ways', async () => {
    const owner = await account('OwnerB');
    const ana = await account('AnaB');
    const bo = await account('BoB');
    const teen = await account('TeenB', true);
    const world = await registerWorld(db, { name: 'Block Plaza', ownerId: owner.id, address: 'relay', agreement: 1 }, new Date());
    const key = await approveWorld(db, sealingKey(secret), world.id, 'admin:test', '', new Date());
    const claims = async (who: { bearer: Record<string, string> }) => {
      const t = (await call('POST', `/api/v1/worlds/${world.id}/join`, who)).json() as { token: string };
      return (await openToken(new Uint8Array(Buffer.from(t.token, 'base64url')), { key, world: world.id, now: Math.floor(Date.now() / 1000) })).claims;
    };

    await call('POST', `/api/v1/me/friends/${bo.id}`, ana);
    await call('POST', `/api/v1/me/friends/${ana.id}`, bo);
    expect((await call('PUT', `/api/v1/me/blocks/${bo.id}`, ana)).statusCode).toBe(204);
    expect(((await call('GET', '/api/v1/me/friends', ana)).json() as { friends: unknown[] }).friends).toEqual([]);
    expect((await call('POST', `/api/v1/me/friends/${ana.id}`, bo)).json()).toMatchObject({ error: 'friend-blocked' });
    expect((await call('GET', '/api/v1/me/blocks', ana)).json()).toEqual({ accounts: [bo.id] });
    expect((await claims(ana)).blocks).toEqual([bo.id]);
    expect((await claims(bo)).blocks).toEqual([ana.id]);
    // The block follows the accounts into another world too.
    const other = await registerWorld(db, { name: 'Other Plaza', ownerId: owner.id, address: 'relay', agreement: 1 }, new Date());
    const otherKey = await approveWorld(db, sealingKey(secret), other.id, 'admin:test', '', new Date());
    const there = (await call('POST', `/api/v1/worlds/${other.id}/join`, bo)).json() as { token: string };
    expect((await openToken(new Uint8Array(Buffer.from(there.token, 'base64url')), { key: otherKey, world: other.id, now: Math.floor(Date.now() / 1000) })).claims.blocks).toEqual([ana.id]);
    expect((await call('PUT', `/api/v1/me/blocks/${ana.id}`, ana)).statusCode).toBe(400);

    // A minor's friends ride in its token; an adult's never do.
    await call('POST', `/api/v1/me/friends/${ana.id}`, teen);
    await call('POST', `/api/v1/me/friends/${teen.id}`, ana);
    expect((await claims(teen)).friends).toEqual([ana.id]);
    expect((await claims(teen)).contact).toBe('friends');
    expect((await claims(ana)).friends).toEqual([]);

    expect((await call('DELETE', `/api/v1/me/blocks/${bo.id}`, ana)).statusCode).toBe(204);
    expect((await claims(bo)).blocks).toEqual([]);
  });
});
