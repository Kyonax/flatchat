// SPDX-License-Identifier: AGPL-3.0-or-later
// Items, standard bodies and outfits in the core (S5.05): a trusted account uploads the test tee
// and the sandboxed item converter, reading the three standard bodies, makes it ready with a fit
// for each; anyone signed in fetches its fits through signed links; a refused item keeps its
// reasons. Any account, a new one too, takes a standard body without an upload, converted once and
// then reused, and the delivery says which body it is (so does an upload of a kit's exact bytes).
// An outfit holds the account's own ready items, worn together, a prop's adjustment within limits;
// deleting an item takes it out of the outfits that held it.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleProp } from '@flatchat/converter/item-samples';
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
const KITS = JSON.parse(readFileSync(join(ROOT, 'kits', 'bodies', 'kits.json'), 'utf8')) as { kits: Record<string, { vrmSha256: string }> };

let db: Db;
let app: FastifyInstance;
let dir: string;
const clock = new Date('2026-10-18T12:00:00Z');
const secret = randomBytes(32);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'http://127.0.0.1:1';

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'fccoreitems-'));
  app = await buildCore({ db, secret, publicUrl: PUBLIC, operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, store: localStore(dir, secret, PUBLIC), avatars: { ktx2: false } });
});
afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

let people = 0;
interface Who {
  id: string;
  auth: Record<string, string>;
}
async function account(email: string, trust = 0): Promise<Who> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.96.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  if (trust) await db.query('update accounts set trust = $2 where id = $1', [id, trust]);
  return { id, auth: { authorization: `Bearer ${(await startSession(db, id, clock)).access}` } };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const local = (url: string): string => url.slice(PUBLIC.length);

async function upload(who: Who, kind: 'items' | 'avatars', bytes: Uint8Array, name: string): Promise<string> {
  const slot = await app.inject({ method: 'POST', url: `/api/v1/${kind}`, headers: who.auth, payload: { name, bytes: bytes.length, sha256: sha(bytes) } });
  expect(slot.statusCode, slot.body).toBe(201);
  const { id, upload: u } = slot.json() as { id: string; upload: { url: string } };
  const sent = await app.inject({ method: 'PUT', url: local(u.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) });
  expect(sent.statusCode, sent.body).toBe(202);
  return id;
}

async function settled(who: Who, kind: 'items' | 'avatars', id: string): Promise<Record<string, unknown>> {
  const end = Date.now() + 120_000;
  for (;;) {
    const list = (await app.inject({ method: 'GET', url: `/api/v1/${kind}`, headers: who.auth })).json() as Record<string, Array<Record<string, unknown>>>;
    const a = list[kind]!.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let maker: Who;
let tee: Record<string, unknown>;

describe('item uploads', () => {
  it('refuse a new account, and convert a trusted one’s tee into a fit for each body', async () => {
    const fresh = await account('new-tailor@example.org');
    const refused = await app.inject({ method: 'POST', url: '/api/v1/items', headers: fresh.auth, payload: { name: 'x', bytes: TEE.length, sha256: sha(TEE) } });
    expect(refused.json()).toMatchObject({ error: 'upload-trust' });

    maker = await account('tailor@example.org', 1);
    tee = await settled(maker, 'items', await upload(maker, 'items', TEE, 'Tee'));
    expect(tee).toMatchObject({ name: 'Tee', status: 'ready', slot: 'top', fits: ['feminine', 'masculine', 'neutral'], problems: [], warnings: [] });

    // Anyone signed in gets its manifest and a link to each fit, each file its hash.
    const viewer = await account('looker@example.org');
    const d = await app.inject({ method: 'GET', url: `/api/v1/item-files/${String(tee['manifest'])}`, headers: viewer.auth });
    expect(d.statusCode).toBe(200);
    const { manifest, links } = d.json() as { manifest: { slot: string; fits: Record<string, { file: string }>; clipping: Record<string, { through: number }> }; links: Record<string, string> };
    expect(manifest.slot).toBe('top');
    for (const body of ['feminine', 'masculine', 'neutral']) {
      const r = await app.inject({ method: 'GET', url: local(links[body]!) });
      expect(sha(r.rawPayload), body).toBe(manifest.fits[body]!.file);
      expect(manifest.clipping[body]!.through).toBe(0);
    }
    expect((await app.inject({ method: 'GET', url: `/api/v1/item-files/${String(tee['manifest'])}` })).statusCode).toBe(401);
  }, 150_000);

  it('keep a refused item’s reasons', async () => {
    const id = await upload(maker, 'items', await sampleProp({ name: 'Cap', slot: 'attachment', attach: 'head_top' }, true), 'Skinned cap');
    const done = await settled(maker, 'items', id);
    expect(done['status']).toBe('refused');
    expect((done['problems'] as string[]).join(' ')).toMatch(/rigid meshes, no skin/);
  }, 150_000);
});

describe('standard bodies', () => {
  it('are taken by any account without an upload, converted once and reused, and delivered as that body', async () => {
    const first = await account('new-player@example.org');
    const took = await app.inject({ method: 'POST', url: '/api/v1/avatars/kit', headers: first.auth, payload: { kit: 'feminine' } });
    expect(took.statusCode, took.body).toBe(202);
    const id = (took.json() as { id: string }).id;
    const ready = await settled(first, 'avatars', id);
    expect(ready).toMatchObject({ status: 'ready', kit: 'feminine', rank: 'excellent' });
    // The same account taking it again gets the same avatar; another account gets it ready at once.
    expect((await app.inject({ method: 'POST', url: '/api/v1/avatars/kit', headers: first.auth, payload: { kit: 'feminine' } })).json()).toMatchObject({ id, status: 'ready' });
    const second = await account('second-player@example.org');
    const again = await app.inject({ method: 'POST', url: '/api/v1/avatars/kit', headers: second.auth, payload: { kit: 'feminine' } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'ready' });
    const theirs = ((await app.inject({ method: 'GET', url: '/api/v1/avatars', headers: second.auth })).json() as { avatars: Array<Record<string, unknown>> }).avatars[0]!;
    expect(theirs['manifest']).toBe(ready['manifest']);

    const d = await app.inject({ method: 'GET', url: `/api/v1/avatar-files/${String(ready['manifest'])}`, headers: second.auth });
    expect(d.json()).toMatchObject({ kit: 'feminine' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/avatars/kit', headers: second.auth, payload: { kit: 'robot' } })).statusCode).toBe(404);
  }, 150_000);

  it('are recognised in an upload of a kit’s exact bytes, and only then', async () => {
    const vrm = new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', 'neutral', 'neutral.vrm')));
    expect(sha(vrm)).toBe(KITS.kits['neutral']!.vrmSha256);
    const exact = await settled(maker, 'avatars', await upload(maker, 'avatars', vrm, 'My neutral'));
    expect(exact).toMatchObject({ status: 'ready', kit: 'neutral' });
  }, 150_000);
});

describe('outfits', () => {
  it('hold the account’s own ready items, worn together, each prop’s adjustment within limits', async () => {
    const cap = await settled(maker, 'items', await upload(maker, 'items', await sampleProp({ name: 'Cap', slot: 'attachment', attach: 'head_top' }), 'Cap'));
    expect(cap).toMatchObject({ status: 'ready', slot: 'attachment', fits: [] });
    const adjust = { x: 0, y: 2, z: 0, rx: 0, ry: 10, rz: 0, scale: 110 };
    const save = (payload: unknown, id?: string) => app.inject({ method: id ? 'PUT' : 'POST', url: id ? `/api/v1/outfits/${id}` : '/api/v1/outfits', headers: maker.auth, payload: payload as Record<string, unknown> });
    const made = await save({ name: 'Day out', items: [{ item: tee['manifest'] }, { item: cap['manifest'], adjust }] });
    expect(made.statusCode, made.body).toBe(201);
    const outfit = made.json() as { id: string };
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/outfits', headers: maker.auth })).json() as { outfits: Array<{ id: string; name: string; items: unknown[] }> };
    expect(listed.outfits).toEqual([expect.objectContaining({ id: outfit.id, name: 'Day out', items: [{ item: tee['manifest'] }, { item: cap['manifest'], adjust }] })]);

    const problem = async (payload: unknown): Promise<string> => {
      const r = await save(payload);
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      return (r.json() as { message: string }).message;
    };
    expect(await problem({ name: 'Twice', items: [{ item: tee['manifest'] }, { item: tee['manifest'] }] })).toMatch(/once/);
    expect(await problem({ name: 'Turned tee', items: [{ item: tee['manifest'], adjust }] })).toMatch(/only an attachment/);
    expect(await problem({ name: 'Far cap', items: [{ item: cap['manifest'], adjust: { ...adjust, x: 30 } }] })).toMatch(/within 10 cm/);
    expect(await problem({ name: 'Unknown', items: [{ item: '0'.repeat(64) }] })).toMatch(/not among this account/);
    expect(await problem({ name: 'Too many', items: Array.from({ length: 17 }, (_, i) => ({ item: i.toString(16).padStart(64, '0') })) })).toMatch(/16 items at most/);
    expect(await problem({ name: '', items: [] })).toMatch(/a name/);
    // Someone else's item is not theirs to save in an outfit.
    const other = await account('borrower@example.org', 1);
    const borrowed = await app.inject({ method: 'POST', url: '/api/v1/outfits', headers: other.auth, payload: { name: 'Borrowed', items: [{ item: tee['manifest'] }] } });
    expect(borrowed.statusCode).toBe(404);
    // Nor theirs to change.
    expect((await app.inject({ method: 'PUT', url: `/api/v1/outfits/${outfit.id}`, headers: other.auth, payload: { name: 'Mine now', items: [] } })).statusCode).toBe(404);

    // Changed in place; deleting the cap takes it out; deleting the outfit removes it.
    expect((await save({ name: 'Day out, no cap', items: [{ item: tee['manifest'] }, { item: cap['manifest'] }] }, outfit.id)).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/items/${String(cap['id'])}`, headers: maker.auth })).statusCode).toBe(204);
    const after = (await app.inject({ method: 'GET', url: '/api/v1/outfits', headers: maker.auth })).json() as { outfits: Array<{ name: string; items: unknown[] }> };
    expect(after.outfits[0]).toMatchObject({ name: 'Day out, no cap', items: [{ item: tee['manifest'] }] });
    expect((await app.inject({ method: 'GET', url: `/api/v1/item-files/${String(cap['manifest'])}`, headers: maker.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/outfits/${outfit.id}`, headers: maker.auth })).statusCode).toBe(204);
    expect(((await app.inject({ method: 'GET', url: '/api/v1/outfits', headers: maker.auth })).json() as { outfits: unknown[] }).outfits).toEqual([]);
  }, 150_000);
});
