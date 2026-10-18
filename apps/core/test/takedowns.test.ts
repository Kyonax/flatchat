// SPDX-License-Identifier: AGPL-3.0-or-later
// Fingerprints and takedowns (S5.09). A rights holder asks on the public form and keeps a receipt;
// the admin page shows the request with the gallery entry it names. Removing takes the avatar down
// everywhere: its entry, the publisher's original, the copy another account took and wears, its
// files' delivery; the claimant reads the decision by the receipt. A rejected request leaves all
// as it was. Removing for the content rules, by a manifest, takes an item out of the outfits that
// held it and can ban its uploader. A re-exported copy of what was taken down is caught at upload
// and is a strike the admin page lists; a re-exported copy of someone else's gallery entry is
// refused while its licence allows no copies, and taken once it allows them. What a standard body
// explains is no evidence: a kit avatar taken down catches no one else's kit avatar.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRICT_LICENCE } from '@flatchat/content';
import { avatarIO } from '@flatchat/converter/avatar';
import { daeOf, sampleDae } from '@flatchat/converter/format-samples';
import { sampleAvatar } from '@flatchat/converter/samples';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import { beyondKits, readKitFingerprints } from '../src/copies.ts';
import type { Db } from '../src/db.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { localStore } from '../src/store.ts';
import { freshDb } from './db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEE = new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb')));
const FEMININE = new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', 'feminine', 'feminine.vrm')));
const PASSWORD = 'a long enough password';
const form = { 'content-type': 'application/x-www-form-urlencoded' };

let db: Db;
let app: FastifyInstance;
let dir: string;
const clock = new Date('2026-10-18T12:00:00Z');
const secret = randomBytes(32);
const PUBLIC = 'http://127.0.0.1:1';

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'fccoretakedowns-'));
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
async function account(name: string, trust = 1): Promise<Who> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const email = `${name}@example.org`;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.98.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: PASSWORD, displayName: name, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  await db.query('update accounts set trust = $2 where id = $1', [id, trust]);
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
  return settled(who, kind, id);
}

async function settled(who: Who, kind: 'items' | 'avatars', id: string): Promise<Record<string, unknown>> {
  const end = Date.now() + 120_000;
  for (;;) {
    const list = (await call(who, 'GET', `/api/v1/${kind}`)).json() as Record<string, Array<Record<string, unknown>>>;
    const a = list[kind]!.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const row = async (who: Who, kind: 'items' | 'avatars', id: unknown): Promise<Record<string, unknown> | undefined> =>
  ((await call(who, 'GET', `/api/v1/${kind}`)).json() as Record<string, Array<Record<string, unknown>>>)[kind]!.find((v) => v['id'] === id);

async function adminSession(): Promise<{ cookie: string; csrf: string; page: () => Promise<string> }> {
  const { id } = await account('owner', 3);
  await db.query('update accounts set admin = true where id = $1', [id]);
  const r = await app.inject({ method: 'POST', url: '/admin/signin', remoteAddress: '10.98.200.1', headers: form, payload: new URLSearchParams({ email: 'owner@example.org', password: PASSWORD }).toString() });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const page = async (): Promise<string> => (await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body;
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(await page())![1]!, page };
}
const post = (url: string, cookie: string, fields: Record<string, string>) => app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(fields).toString() });
const ask = (fields: Record<string, string>, ip = '10.98.250.1') => app.inject({ method: 'POST', url: '/takedown?lang=en', remoteAddress: ip, headers: form, payload: new URLSearchParams(fields).toString() });
const takedownId = async (receipt: string): Promise<string> => (await db.query<{ id: string }>('select id from takedowns where receipt = $1', [receipt]))[0]!.id;

/** A copy of a model with the same shape and new bytes: a node renamed, as a re-save does. */
async function resaved(bytes: Uint8Array): Promise<Uint8Array> {
  const io = avatarIO();
  const doc = await io.readBinary(bytes);
  doc.getRoot().listNodes()[0]!.setName('resaved');
  return io.writeBinary(doc);
}

let admin: Awaited<ReturnType<typeof adminSession>>;
let maker: Who;
let taker: Who;
let avatar: Record<string, unknown>;
let tee: Record<string, unknown>;
let avatarEntry: string;
let teeEntry: string;
let receipt: string;

describe('a takedown request', () => {
  it('is asked on the public form, kept with a receipt, and shown on the admin page with its entry', async () => {
    admin = await adminSession();
    maker = await account('maker', 2);
    taker = await account('taker');
    avatar = await upload(maker, 'avatars', await sampleAvatar('glb'), 'Sample');
    expect(avatar['status']).toBe('ready');
    avatarEntry = ((await call(maker, 'POST', '/api/v1/gallery', { kind: 'avatar', id: avatar['id'], name: 'Sample for all', licence: STRICT_LICENCE, affirm: true })).json() as { id: string }).id;
    tee = await upload(maker, 'items', TEE, 'Tee');
    teeEntry = ((await call(maker, 'POST', '/api/v1/gallery', { kind: 'item', id: tee['id'], licence: { ...STRICT_LICENCE, allowRedistribution: true }, affirm: true })).json() as { id: string }).id;
    // The taker takes both, wears the avatar and saves an outfit with the tee.
    const copy = (await call(taker, 'POST', `/api/v1/gallery/${avatarEntry}/take`)).json() as { id: string };
    expect((await call(taker, 'PUT', '/api/v1/me/avatar', { avatar: copy.id })).statusCode).toBe(204);
    const shirt = (await call(taker, 'POST', `/api/v1/gallery/${teeEntry}/take`)).json() as { id: string };
    const outfit = await call(taker, 'POST', '/api/v1/outfits', { name: 'Day', items: [{ item: (await row(taker, 'items', shirt.id))!['manifest'] }] });
    expect(outfit.statusCode, outfit.body).toBe(201);

    expect((await app.inject({ method: 'GET', url: '/takedown?lang=es' })).body).toContain('Pedir el retiro de una copia');
    const missing = await ask({ name: 'Ada Artist', contact: 'ada@example.org', work: 'My avatar', target: avatarEntry, signature: 'Ada Artist' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('Tick the statement to send the request.');
    const sent = await ask({ name: 'Ada Artist', contact: 'ada@example.org', work: 'My avatar, on my site since 2024', target: `https://flatchat.example/gallery/${avatarEntry}`, statement: 'yes', signature: 'Ada Artist' });
    expect(sent.statusCode).toBe(200);
    receipt = /T-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(sent.body)![0];
    expect((await app.inject({ method: 'GET', url: `/takedown/status?receipt=${receipt}&lang=en` })).body).toContain('Received: it waits for review.');
    expect((await app.inject({ method: 'GET', url: '/takedown/status?receipt=T-0000-0000&lang=en' })).body).toContain('There is no request with that reference.');
    const page = await admin.page();
    expect(page).toContain(receipt);
    expect(page).toContain('avatar “Sample for all” by maker@example.org');
  }, 240_000);

  it('rejected leaves all as it was', async () => {
    const sent = await ask({ name: 'Bo', contact: 'bo@example.org', work: 'A tee I drew', target: teeEntry, statement: 'yes', signature: 'Bo' });
    const r = /T-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(sent.body)![0];
    expect((await post(`/admin/takedowns/${await takedownId(r)}`, admin.cookie, { csrf: admin.csrf, decision: 'reject', note: 'The tee is the platform’s own test garment.' })).headers.location).toBe('/admin?done=takedown-rejected');
    expect((await call(taker, 'GET', `/api/v1/gallery/${teeEntry}`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/takedown/status?receipt=${r}` })).body).toContain('the platform’s own test garment');
  });

  it('removed takes the avatar down everywhere: its entry, the original, the copy worn, its files', async () => {
    const manifest = avatar['manifest'] as string;
    expect((await call(taker, 'GET', `/api/v1/avatar-files/${manifest}`)).statusCode).toBe(200);
    expect((await post(`/admin/takedowns/${await takedownId(receipt)}`, admin.cookie, { csrf: admin.csrf, decision: 'remove', note: 'It copies her published avatar.' })).headers.location).toBe('/admin?done=takedown-removed');
    expect((await call(taker, 'GET', `/api/v1/gallery/${avatarEntry}`)).statusCode).toBe(404);
    const original = await row(maker, 'avatars', avatar['id']);
    expect(original).toMatchObject({ status: 'removed' });
    expect((original!['problems'] as string[]).join(' ')).toContain(`a rights holder's takedown (${receipt}): It copies her published avatar.`);
    const copies = ((await call(taker, 'GET', '/api/v1/avatars')).json() as { avatars: Array<Record<string, unknown>> }).avatars;
    expect(copies.map((c) => c['status'])).toEqual(['removed']);
    expect((await db.query<{ avatar_id: string | null }>('select avatar_id from accounts where id = $1', [taker.id]))[0]!.avatar_id).toBeNull();
    expect((await call(taker, 'GET', `/api/v1/avatar-files/${manifest}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/takedown/status?receipt=${receipt}` })).body).toContain('Taken down from FlatChat.');
    // The publisher's strike; the taker's copy is none of theirs.
    expect((await db.query<{ account_id: string; kind: string }>('select account_id, kind from strikes')).map((s) => [s.account_id, s.kind])).toEqual([[maker.id, 'removed']]);
  }, 60_000);

  it('removed for the content rules takes an item out of outfits, and can ban its uploader', async () => {
    const before = await db.query<{ items: unknown[] }>('select items from outfits where owner_id = $1', [taker.id]);
    expect(before[0]!.items).toHaveLength(1);
    const r = await post('/admin/remove', admin.cookie, { csrf: admin.csrf, what: tee['manifest'] as string, reason: 'a test of the content-rule removal', ban: 'yes' });
    expect(r.headers.location).toBe('/admin?done=content-removed');
    expect((await db.query<{ items: unknown[] }>('select items from outfits where owner_id = $1', [taker.id]))[0]!.items).toEqual([]);
    expect((await call(taker, 'GET', `/api/v1/item-files/${tee['manifest'] as string}`)).statusCode).toBe(404);
    expect((await db.query<{ status: string }>('select status from accounts where id = $1', [maker.id]))[0]!.status).toBe('banned');
    expect((await post('/admin/remove', admin.cookie, { csrf: admin.csrf, what: '0'.repeat(64), reason: 'nothing' })).headers.location).toBe('/admin?done=remove-nothing');
  }, 60_000);
});

describe('a copy', () => {
  it('of what was taken down, re-exported, is caught at upload and is a strike', async () => {
    const thief = await account('thief');
    const caught = await upload(thief, 'avatars', await sampleDae('avatar'), 'Not stolen');
    expect(caught['status']).toBe('refused');
    expect((caught['problems'] as string[]).join(' ')).toBe('this is a copy of an avatar taken down from FlatChat, which cannot be uploaded again');
    expect((await db.query<{ kind: string }>('select kind from strikes where account_id = $1', [thief.id])).map((s) => s.kind)).toEqual(['copy']);
    const page = await admin.page();
    expect(page).toContain('thief@example.org');
    expect(page).toContain('1 caught re-uploads');
  }, 120_000);

  it('of someone else’s gallery entry is refused while its licence allows no copies, and taken once it does', async () => {
    const robotMaker = await account('robots', 2);
    const robot = await upload(robotMaker, 'avatars', await sampleAvatar('free'), 'Robot');
    expect(robot['status']).toBe('ready');
    const entry = ((await call(robotMaker, 'POST', '/api/v1/gallery', { kind: 'avatar', id: robot['id'], licence: STRICT_LICENCE, affirm: true })).json() as { id: string }).id;
    const fan = await account('fan');
    const copy = new TextEncoder().encode(await daeOf(await sampleAvatar('free')));
    const refused = await upload(fan, 'avatars', copy, 'Robot again');
    expect(refused['status']).toBe('refused');
    expect((refused['problems'] as string[]).join(' ')).toMatch(/a copy of “Robot” in the gallery, whose licence does not allow copies/);
    // No strike: a closed licence is not a takedown.
    expect(await db.query('select 1 from strikes where account_id = $1', [fan.id])).toEqual([]);
    expect((await call(robotMaker, 'DELETE', `/api/v1/gallery/${entry}`)).statusCode).toBe(204);
    expect((await call(robotMaker, 'POST', '/api/v1/gallery', { kind: 'avatar', id: robot['id'], licence: { ...STRICT_LICENCE, allowRedistribution: true }, affirm: true })).statusCode).toBe(201);
    const again = new TextEncoder().encode(`${new TextDecoder().decode(copy)}<!-- saved again -->\n`);
    expect((await upload(fan, 'avatars', again, 'Robot, allowed'))['status']).toBe('ready');
  }, 240_000);

  it('is no copy where a standard body explains it: a kit avatar taken down catches no other kit avatar', async () => {
    const kits = readKitFingerprints(join(ROOT, 'kits', 'bodies'));
    expect(kits).toHaveLength(3);
    expect(beyondKits(kits[0]!, kits)).toEqual({ shapes: [], textures: [] });
    const one = await account('kit-one', 2);
    const kitAvatar = await upload(one, 'avatars', await resaved(FEMININE), 'My body');
    expect(kitAvatar['status']).toBe('ready');
    const r = await post('/admin/remove', admin.cookie, { csrf: admin.csrf, what: kitAvatar['manifest'] as string, reason: 'a test: an edited kit taken down' });
    expect(r.headers.location).toBe('/admin?done=content-removed');
    const two = await account('kit-two');
    const other = await resaved(await resaved(FEMININE));
    expect((await upload(two, 'avatars', other, 'Mine too'))['status']).toBe('ready');
  }, 240_000);
});
