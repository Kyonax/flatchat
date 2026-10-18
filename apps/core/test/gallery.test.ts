// SPDX-License-Identifier: AGPL-3.0-or-later
// The free gallery (S5.06): publishing needs trust level 2, the publisher's word and a full licence
// that lets everyone wear it, never looser than the avatar's own file; anyone browses it by kind,
// slot, body and words; taking an entry gives a ready copy worn and saved in outfits like one's
// own; withdrawing (or deleting the original) takes an entry out while copies stay; an exact copy
// of someone else's entry is refused at upload unless its licence allows copies.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRICT_LICENCE } from '@flatchat/content';
import { sampleAvatar } from '@flatchat/converter/samples';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { localStore } from '../src/store.ts';
import { freshDb } from './db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEE = new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb')));

let db: Db;
let app: FastifyInstance;
let dir: string;
let clock = new Date('2026-10-18T12:00:00Z');
const secret = randomBytes(32);
const PUBLIC = 'http://127.0.0.1:1';

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'fccoregallery-'));
  app = await buildCore({ db, secret, publicUrl: PUBLIC, operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, store: localStore(dir, secret, PUBLIC), avatars: { ktx2: false } });
});
afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Who {
  id: string;
  auth: Record<string, string>;
}
let people = 0;
async function account(name: string, trust = 0): Promise<Who> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const email = `${name}@example.org`;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.97.${people}.1`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: name, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  if (trust) await db.query('update accounts set trust = $2 where id = $1', [id, trust]);
  return { id, auth: { authorization: `Bearer ${(await startSession(db, id, clock)).access}` } };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const local = (url: string): string => url.slice(PUBLIC.length);
const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: who.auth, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function upload(who: Who, kind: 'items' | 'avatars', bytes: Uint8Array, name: string): Promise<Record<string, unknown>> {
  const slot = await call(who, 'POST', `/api/v1/${kind}`, { name, bytes: bytes.length, sha256: sha(bytes) });
  expect(slot.statusCode, slot.body).toBe(201);
  const { id, upload: u } = slot.json() as { id: string; upload: { url: string } };
  expect((await app.inject({ method: 'PUT', url: local(u.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) })).statusCode).toBe(202);
  const end = Date.now() + 120_000;
  for (;;) {
    const list = (await call(who, 'GET', `/api/v1/${kind}`)).json() as Record<string, Array<Record<string, unknown>>>;
    const a = list[kind]!.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let maker: Who;
let avatar: Record<string, unknown>;
let tee: Record<string, unknown>;
let avatarEntry: Record<string, unknown>;
let teeEntry: Record<string, unknown>;

describe('publishing', () => {
  it('needs trust level 2, the publisher’s word, and a full licence everyone may wear under, no looser than the file', async () => {
    const newcomer = await account('newcomer', 1);
    expect((await call(newcomer, 'POST', '/api/v1/gallery', { kind: 'avatar', id: '00000000-0000-4000-8000-000000000001', licence: STRICT_LICENCE, affirm: true })).json()).toMatchObject({ error: 'publish-trust' });

    maker = await account('maker', 2);
    avatar = await upload(maker, 'avatars', await sampleAvatar('vrm1'), 'Sample');
    expect(avatar['status']).toBe('ready');
    const publish = (licence: unknown, affirm = true) => call(maker, 'POST', '/api/v1/gallery', { kind: 'avatar', id: avatar['id'], name: 'Sample for all', licence, affirm });
    const half = await publish({ avatarPermission: 'everyone' });
    expect(half.statusCode).toBe(400);
    expect((half.json() as { message: string }).message).toMatch(/creditNotation: one of/);
    expect((await publish({ ...STRICT_LICENCE, avatarPermission: 'onlyAuthor' })).json()).toMatchObject({ error: 'licence' });
    expect((await publish(STRICT_LICENCE, false)).statusCode).toBe(400);
    // The sample's own file allows no profit: the publisher may not allow more.
    const looser = await publish({ ...STRICT_LICENCE, commercialUsage: 'corporation' });
    expect(looser.json()).toMatchObject({ error: 'licence' });
    expect((looser.json() as { message: string }).message).toMatch(/commercialUsage/);

    const done = await publish(STRICT_LICENCE);
    expect(done.statusCode, done.body).toBe(201);
    avatarEntry = done.json() as Record<string, unknown>;
    expect(avatarEntry).toMatchObject({ kind: 'avatar', name: 'Sample for all', authors: ['FlatChat tests'], licence: STRICT_LICENCE, rank: avatar['rank'], publisher: 'maker', mine: true, taken: false, takes: 0 });
    expect((await publish(STRICT_LICENCE)).json()).toMatchObject({ error: 'bad-request' });
    expect(((await call(maker, 'GET', '/api/v1/avatars')).json() as { avatars: Array<Record<string, unknown>> }).avatars[0]).toMatchObject({ published: avatarEntry['id'], fromGallery: null });

    tee = await upload(maker, 'items', TEE, 'Tee');
    clock = new Date(clock.getTime() + 1000);
    const t = await call(maker, 'POST', '/api/v1/gallery', { kind: 'item', id: tee['id'], licence: { ...STRICT_LICENCE, allowRedistribution: true, creditNotation: 'unnecessary' }, affirm: true });
    expect(t.statusCode, t.body).toBe(201);
    teeEntry = t.json() as Record<string, unknown>;
    expect(teeEntry).toMatchObject({ kind: 'item', name: 'Tee', slot: 'top', fits: ['feminine', 'masculine', 'neutral'] });
  }, 180_000);
});

describe('browsing', () => {
  it('lists what is live, newest first, by kind, slot, body and words', async () => {
    const viewer = await account('viewer');
    const ids = async (q = ''): Promise<unknown[]> => ((await call(viewer, 'GET', `/api/v1/gallery${q}`)).json() as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
    expect(await ids()).toEqual([teeEntry['id'], avatarEntry['id']]);
    expect(await ids('?kind=avatar')).toEqual([avatarEntry['id']]);
    expect(await ids('?kind=item&slot=top&body=neutral')).toEqual([teeEntry['id']]);
    expect(await ids('?q=sample')).toEqual([avatarEntry['id']]);
    expect(await ids('?q=nothing%25like')).toEqual([]);
    expect((await call(viewer, 'GET', `/api/v1/gallery/${String(avatarEntry['id'])}`)).json()).toMatchObject({ mine: false, taken: false, licence: STRICT_LICENCE });
    expect((await app.inject({ method: 'GET', url: '/api/v1/gallery' })).statusCode).toBe(401);
  });
});

describe('taking', () => {
  it('gives a ready copy, worn and saved in outfits like one’s own, once', async () => {
    const taker = await account('taker');
    const got = await call(taker, 'POST', `/api/v1/gallery/${String(avatarEntry['id'])}/take`);
    expect(got.statusCode, got.body).toBe(200);
    const copy = got.json() as { kind: string; id: string };
    expect(copy.kind).toBe('avatar');
    expect((await call(taker, 'POST', `/api/v1/gallery/${String(avatarEntry['id'])}/take`)).json()).toEqual(copy);
    expect((await call(taker, 'PUT', '/api/v1/me/avatar', { avatar: copy.id })).statusCode).toBe(204);
    expect(((await call(taker, 'GET', '/api/v1/avatars')).json() as { avatars: Array<Record<string, unknown>> }).avatars[0]).toMatchObject({ id: copy.id, status: 'ready', manifest: avatar['manifest'], wearing: true, fromGallery: avatarEntry['id'], published: null });
    expect((await call(taker, 'GET', `/api/v1/gallery/${String(avatarEntry['id'])}`)).json()).toMatchObject({ taken: true, takes: 1 });

    const shirt = (await call(taker, 'POST', `/api/v1/gallery/${String(teeEntry['id'])}/take`)).json() as { id: string };
    expect((await call(taker, 'POST', '/api/v1/outfits', { name: 'Borrowed tee', items: [{ item: tee['manifest'] }] })).statusCode).toBe(201);
    expect(((await call(taker, 'GET', '/api/v1/items')).json() as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ id: shirt.id, status: 'ready', slot: 'top', fromGallery: teeEntry['id'] });
    // The publisher has the original already.
    expect((await call(maker, 'POST', `/api/v1/gallery/${String(teeEntry['id'])}/take`)).json()).toEqual({ kind: 'item', id: tee['id'] });
  });
});

describe('withdrawing', () => {
  it('takes an entry out of the gallery while the copies stay, and so does deleting the original', async () => {
    const viewer = await account('second-viewer');
    expect((await call(viewer, 'DELETE', `/api/v1/gallery/${String(avatarEntry['id'])}`)).statusCode).toBe(404);
    expect((await call(maker, 'DELETE', `/api/v1/gallery/${String(avatarEntry['id'])}`)).statusCode).toBe(204);
    expect((await call(viewer, 'GET', `/api/v1/gallery/${String(avatarEntry['id'])}`)).statusCode).toBe(404);
    expect((await call(viewer, 'POST', `/api/v1/gallery/${String(avatarEntry['id'])}/take`)).statusCode).toBe(404);
    // The taker still wears it, and everyone still gets its files.
    expect((await call(viewer, 'GET', `/api/v1/avatar-files/${String(avatar['manifest'])}`)).statusCode).toBe(200);

    expect((await call(maker, 'DELETE', `/api/v1/items/${String(tee['id'])}`)).statusCode).toBe(204);
    expect(((await call(viewer, 'GET', '/api/v1/gallery')).json() as { entries: unknown[] }).entries).toEqual([]);
    expect((await call(viewer, 'GET', `/api/v1/item-files/${String(tee['manifest'])}`)).statusCode).toBe(200);
  });
});

describe('copies of gallery entries', () => {
  it('are refused at upload unless the licence allows copies; the publisher may upload their own', async () => {
    const bytes = await sampleAvatar('vrm0');
    const original = await upload(maker, 'avatars', bytes, 'Classic');
    expect((await call(maker, 'POST', '/api/v1/gallery', { kind: 'avatar', id: original['id'], licence: STRICT_LICENCE, affirm: true })).statusCode).toBe(201);
    const copier = await account('copier', 1);
    const refused = await call(copier, 'POST', '/api/v1/avatars', { name: 'Mine now', bytes: bytes.length, sha256: sha(bytes) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'licence' });
    expect((refused.json() as { message: string }).message).toMatch(/take it from the gallery/);
    expect((await call(maker, 'POST', '/api/v1/avatars', { name: 'Again', bytes: bytes.length, sha256: sha(bytes) })).statusCode).toBe(201);

    // A licence that allows copies lets them through.
    const cap = await upload(maker, 'items', TEE, 'Tee again');
    expect((await call(maker, 'POST', '/api/v1/gallery', { kind: 'item', id: cap['id'], licence: { ...STRICT_LICENCE, allowRedistribution: true }, affirm: true })).statusCode).toBe(201);
    expect((await call(copier, 'POST', '/api/v1/items', { name: 'Tee copy', bytes: TEE.length, sha256: sha(TEE) })).statusCode).toBe(201);
  }, 180_000);
});
