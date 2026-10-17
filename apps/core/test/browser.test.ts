// SPDX-License-Identifier: AGPL-3.0-or-later
// The world browser (S2.09): the public list follows each world's live count over its host channel
// and drops a world at its recommended count; unlisted worlds are reached by id only; favourites
// follow the account; a host lists, unlists and caps its own world.
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { cleanStatus } from '../src/hosts.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld, MAX_FAVOURITES } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
let base = '';
const secret = randomBytes(32);

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

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const code = (await createInvitation(db, {}, new Date())).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  const t = await startSession(db, id, new Date());
  return { id, bearer: { authorization: `Bearer ${t.access}` } };
}

interface FakeWorld {
  ws: WebSocket;
  got: Array<Record<string, unknown>>;
  status(players: number, recommended: number, maximum: number): void;
}

/** A world on its host channel: proves its key, then reports what the test tells it to. */
function world(id: string, key: Uint8Array): Promise<FakeWorld> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/v1/worlds/${id}/host`, 'flatchat-host-1');
    const got: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      got.push(m);
      if (m['type'] === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: createHmac('sha256', key).update(`flatchat host v1 ${String(m['nonce'])}`).digest('base64url') }));
      if (m['type'] === 'ice') resolve({ ws, got, status: (players, recommended, maximum) => ws.send(JSON.stringify({ type: 'status', players, recommended, maximum })) });
    });
    ws.addEventListener('close', () => reject(new Error('closed before it was online')));
  });
}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Listed = { id: string; name: string; online: boolean; players: number; recommended: number; capacity: number };
const publicList = async (): Promise<Listed[]> => ((await app.inject({ method: 'GET', url: '/api/v1/worlds' })).json() as { worlds: Listed[] }).worlds;
const one = async (id: string): Promise<Record<string, unknown>> => (await app.inject({ method: 'GET', url: `/api/v1/worlds/${id}` })).json() as Record<string, unknown>;

describe('the world browser', () => {
  it('reads only well-formed status reports', () => {
    expect(cleanStatus({ players: 3, recommended: 40, maximum: 50 })).toEqual({ players: 3, recommended: 40, maximum: 50 });
    expect(cleanStatus({ players: 3, recommended: 80, maximum: 50 })).toEqual({ players: 3, recommended: 50, maximum: 50 });
    for (const bad of [{ players: -1, recommended: 1, maximum: 1 }, { players: 1.5, recommended: 1, maximum: 1 }, { players: 1, recommended: 0, maximum: 1 }, { players: 1, recommended: 1, maximum: 5000 }, { players: '1', recommended: 1, maximum: 1 }]) {
      expect(cleanStatus(bad)).toBeUndefined();
    }
  });

  it('lists online worlds below their recommended count, busiest first, and drops them at it', async () => {
    const host = await account('host@example.org');
    const player = await account('player@example.org');
    const make = async (name: string, extra: Record<string, unknown>): Promise<{ id: string; key: Uint8Array }> => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name, address: 'relay', ...extra } });
      expect(r.statusCode).toBe(201);
      const id = (r.json() as { id: string }).id;
      return { id, key: await approveWorld(db, sealingKey(secret), id, 'admin:test', '', new Date()) };
    };
    // Capacity is the host's, up to 200 (Q-L19).
    expect((await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name: 'Too Big', address: 'relay', capacity: 201 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name: 'Odd', address: 'relay', listed: 'yes' } })).statusCode).toBe(400);
    const plaza = await make('Plaza', { capacity: 6 });
    const cafe = await make('Cafe', { capacity: 20 });
    const hidden = await make('Hidden Room', { capacity: 10, listed: false });

    // Approved but offline: not on the list, and its page says so.
    expect(await publicList()).toEqual([]);
    expect(await one(plaza.id)).toMatchObject({ online: false, players: 0, capacity: 6, recommended: 6, listed: true, status: 'approved' });

    // Online: the core tells the world its approved capacity before anything else.
    const p = await world(plaza.id, plaza.key);
    expect(p.got.map((m) => m['type'])).toEqual(['challenge', 'welcome', 'limits', 'ice']);
    expect(p.got[2]).toEqual({ type: 'limits', maximum: 6 });
    // Its own numbers count, capped by the approved capacity: maximum 8 asked, 6 approved.
    p.status(0, 4, 8);
    await until('the plaza on the list', async () => ((await publicList()).find((w) => w.id === plaza.id)?.recommended === 4 ? true : undefined));
    expect((await publicList()).find((w) => w.id === plaza.id)).toEqual({ id: plaza.id, name: 'Plaza', online: true, players: 0, recommended: 4, capacity: 6 });

    const c = await world(cafe.id, cafe.key);
    c.status(2, 15, 20);
    const h = await world(hidden.id, hidden.key);
    h.status(1, 8, 10);
    p.status(3, 4, 8);
    // Busiest first; the unlisted world never shows, but its id finds it.
    await until('both listed worlds', async () => {
      const list = await publicList();
      return list.length === 2 && list[0]!.players === 3 ? list : undefined;
    }).then((list) => expect(list.map((w) => w.name)).toEqual(['Plaza', 'Cafe']));
    expect(await one(hidden.id)).toMatchObject({ online: true, players: 1, listed: false });

    // At the recommended count the plaza drops off the list, and still takes joins up to 6.
    p.status(4, 4, 8);
    await until('the plaza off the list', async () => ((await publicList()).some((w) => w.id === plaza.id) ? undefined : true));
    expect(await one(plaza.id)).toMatchObject({ players: 4, recommended: 4, capacity: 6 });
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${plaza.id}/join`, headers: player.bearer })).statusCode).toBe(200);
    p.status(6, 4, 8);
    await until('the plaza full', async () => ((await one(plaza.id))['players'] === 6 ? true : undefined));
    expect((await app.inject({ method: 'POST', url: `/api/v1/worlds/${plaza.id}/join`, headers: player.bearer })).json()).toMatchObject({ error: 'full' });

    // Players leave: back on the list.
    p.status(1, 4, 8);
    await until('the plaza back', async () => ((await publicList()).some((w) => w.id === plaza.id) ? true : undefined));

    // The host unlists it, then caps it lower: the world hears the new capacity at once.
    const stranger = await account('stranger@example.org');
    expect((await app.inject({ method: 'POST', url: `/api/v1/my/worlds/${plaza.id}`, headers: stranger.bearer, payload: { listed: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/my/worlds/${plaza.id}`, headers: host.bearer, payload: { capacity: 500 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/my/worlds/${plaza.id}`, headers: host.bearer, payload: { listed: false, capacity: 5 } })).json()).toMatchObject({ listed: false, capacity: 5 });
    await until('the new capacity at the world', async () => (p.got.some((m) => m['type'] === 'limits' && m['maximum'] === 5) ? true : undefined));
    expect((await publicList()).map((w) => w.id)).not.toContain(plaza.id);
    expect((await app.inject({ method: 'GET', url: '/api/v1/my/worlds', headers: host.bearer })).json()).toMatchObject({ worlds: expect.arrayContaining([expect.objectContaining({ id: plaza.id, listed: false, online: true, players: 1 })]) });

    // Offline again: off every list.
    c.ws.close();
    await until('the cafe gone', async () => ((await publicList()).some((w) => w.id === cafe.id) ? undefined : true));
    p.ws.close();
    h.ws.close();
  });

  it('keeps favourites with the account, whatever the world’s state', async () => {
    const host = await account('host2@example.org');
    const player = await account('fan@example.org');
    const ids: string[] = [];
    for (const name of ['First Fav', 'Second Fav']) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name, address: 'relay' } });
      ids.push((r.json() as { id: string }).id);
    }
    const [a, b] = ids as [string, string];
    const key = await approveWorld(db, sealingKey(secret), a, 'admin:test', '', new Date());
    const favs = async (who = player): Promise<Array<{ id: string; online: boolean; status: string }>> =>
      ((await app.inject({ method: 'GET', url: '/api/v1/me/favourites', headers: who.bearer })).json() as { worlds: Array<{ id: string; online: boolean; status: string }> }).worlds;

    expect((await app.inject({ method: 'GET', url: '/api/v1/me/favourites' })).statusCode).toBe(401);
    expect(await favs()).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favourites/${a}`, headers: player.bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favourites/${b}`, headers: player.bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favourites/${a}`, headers: player.bearer })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favourites/00000000-0000-4000-8000-000000000000', headers: player.bearer })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/favourites/not-an-id', headers: player.bearer })).statusCode).toBe(404);
    // A pending world can be a favourite too; it shows its status.
    expect((await favs()).map((w) => [w.id, w.status, w.online])).toEqual([
      [a, 'approved', false],
      [b, 'pending', false],
    ]);
    const w = await world(a, key);
    w.status(2, 40, 50);
    await until('the favourite online', async () => ((await favs())[0]?.online ? true : undefined));
    expect(await favs(host)).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/me/favourites/${a}`, headers: player.bearer })).statusCode).toBe(204);
    expect((await favs()).map((x) => x.id)).toEqual([b]);
    w.ws.close();

    // At most MAX_FAVOURITES.
    await db.query(
      "insert into worlds (name, owner_id, address) select 'Bulk ' || n, $1, 'relay' from generate_series(1, $2::int) as n",
      [host.id, MAX_FAVOURITES],
    );
    await db.query("insert into favourites (account_id, world_id) select $1, id from worlds where name like 'Bulk %' order by name limit $2", [player.id, MAX_FAVOURITES - 1]);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/favourites/${a}`, headers: player.bearer })).json()).toMatchObject({ error: 'too-many' });
  });
});
