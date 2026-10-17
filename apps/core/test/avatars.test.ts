// SPDX-License-Identifier: AGPL-3.0-or-later
// Avatars in the core (S4.01, S4.04): a new account's upload is refused (trust level 1 needed); a
// trusted account asks for a slot, sends the file there, and the sandboxed converter makes it
// ready (or refuses it, with the reasons); a slot takes only the file it was asked for, and expires;
// the account wears a ready avatar; anyone signed in fetches a worn avatar's levels through signed
// links that expire and cannot be forged, and that a cache keeps (immutable, 304 on a repeat);
// deleting an avatar takes it off; the source is never handed out.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleAvatar } from '@flatchat/converter/samples';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { converterArgs } from '../src/avatars.ts';
import { localStore } from '../src/store.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
let dir: string;
let clock = new Date('2026-10-17T12:00:00Z');
const secret = randomBytes(32);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'http://127.0.0.1:1';

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'fccorestore-'));
  app = await buildCore({ db, secret, publicUrl: PUBLIC, operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, store: localStore(dir, secret, PUBLIC), avatars: { ktx2: false } });
});
afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

let people = 0;
async function account(email: string, trust = 0): Promise<{ id: string; auth: Record<string, string> }> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.95.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  if (trust) await db.query('update accounts set trust = $2 where id = $1', [id, trust]);
  return { id, auth: { authorization: `Bearer ${(await startSession(db, id, clock)).access}` } };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** A fresh session at the test's clock (access tokens last minutes; the tests move the clock). */
const again = async (who: { id: string; auth: Record<string, string> }): Promise<void> => {
  who.auth = { authorization: `Bearer ${(await startSession(db, who.id, clock)).access}` };
};
/** The path and query of a link the core made (inject talks to the app, not the network). */
const local = (url: string): string => url.slice(PUBLIC.length);

async function upload(who: { auth: Record<string, string> }, bytes: Uint8Array, name = 'Mine'): Promise<string> {
  const slot = await app.inject({ method: 'POST', url: '/api/v1/avatars', headers: who.auth, payload: { name, bytes: bytes.length, sha256: sha(bytes) } });
  expect(slot.statusCode, slot.body).toBe(201);
  const { id, upload: u } = slot.json() as { id: string; upload: { url: string; method: string } };
  const sent = await app.inject({ method: 'PUT', url: local(u.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) });
  expect(sent.statusCode, sent.body).toBe(202);
  return id;
}

async function settled(who: { auth: Record<string, string> }, id: string): Promise<Record<string, unknown>> {
  const end = Date.now() + 60_000;
  for (;;) {
    const list = (await app.inject({ method: 'GET', url: '/api/v1/avatars', headers: who.auth })).json() as { avatars: Array<Record<string, unknown>> };
    const a = list.avatars.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('avatar uploads', () => {
  it('refuse a new account, and take a trusted one’s file through its slot into a ready avatar', async () => {
    const fresh = await account('new-uploader@example.org');
    const bytes = await sampleAvatar('vrm0');
    const refused = await app.inject({ method: 'POST', url: '/api/v1/avatars', headers: fresh.auth, payload: { name: 'x', bytes: bytes.length, sha256: sha(bytes) } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'upload-trust' });

    const maker = await account('maker@example.org', 1);
    const id = await upload(maker, bytes, 'Sample');
    const ready = await settled(maker, id);
    expect(ready).toMatchObject({ name: 'Sample', status: 'ready', rank: 'excellent', wearing: false });
    expect(String(ready['manifest'])).toMatch(/^[0-9a-f]{64}$/);
  }, 90_000);

  it('take only the file a slot was asked for, and not after it expires', async () => {
    const maker = await account('slots@example.org', 1);
    const bytes = await sampleAvatar('vrm1');
    const ask = async (): Promise<string> => ((await app.inject({ method: 'POST', url: '/api/v1/avatars', headers: maker.auth, payload: { name: 'S', bytes: bytes.length, sha256: sha(bytes) } })).json() as { upload: { url: string } }).upload.url;
    const other = new Uint8Array(bytes);
    other[100] = (other[100]! + 1) % 256;
    const put = (url: string, b: Uint8Array) => app.inject({ method: 'PUT', url: local(url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(b) });
    expect((await put(await ask(), other)).json()).toMatchObject({ error: 'mismatch' });
    const late = await ask();
    clock = new Date(clock.getTime() + 16 * 60_000);
    await again(maker);
    expect((await put(late, bytes)).statusCode).toBe(410);
    const forged = (await ask()).replace(/s=[^&]+/, 's=AAAA');
    expect((await put(forged, bytes)).statusCode).toBe(404);
    const big = await app.inject({ method: 'POST', url: '/api/v1/avatars', headers: maker.auth, payload: { name: 'Big', bytes: 65 * 1024 * 1024, sha256: sha(bytes) } });
    expect(big.json()).toMatchObject({ error: 'too-large' });
  });

  it('keep a refused file’s reasons', async () => {
    const maker = await account('refused@example.org', 1);
    const junk = new TextEncoder().encode('glTF not really a model, just text pretending to be one, and long enough');
    const id = await upload(maker, junk, 'Junk');
    const done = await settled(maker, id);
    expect(done['status']).toBe('refused');
    expect((done['problems'] as string[]).join(' ')).toMatch(/not a GLB or VRM/);
  }, 90_000);
});

describe('wearing and delivery', () => {
  it('wear a ready avatar, deliver its levels by signed links a cache keeps, and stop after a delete', async () => {
    const maker = await account('wearer@example.org', 2);
    const viewer = await account('viewer@example.org');
    const id = await upload(maker, await sampleAvatar('glb'), 'Glb');
    const ready = await settled(maker, id);
    expect(ready['status']).toBe('ready');
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/avatar', headers: maker.auth, payload: { avatar: id } })).statusCode).toBe(204);
    expect(((await app.inject({ method: 'GET', url: '/api/v1/avatars', headers: maker.auth })).json() as { avatars: Array<{ wearing: boolean }> }).avatars[0]!.wearing).toBe(true);

    const manifest = String(ready['manifest']);
    const d = await app.inject({ method: 'GET', url: `/api/v1/avatar-files/${manifest}`, headers: viewer.auth });
    expect(d.statusCode).toBe(200);
    const { links, manifest: m } = d.json() as { links: Record<string, string>; manifest: { levels: Record<string, { file: string }> } };
    for (const level of ['lod0', 'lod1', 'lod2', 'impostor']) {
      const r = await app.inject({ method: 'GET', url: local(links[level]!) });
      expect(r.statusCode, level).toBe(200);
      expect(sha(r.rawPayload), level).toBe(m.levels[level]!.file);
      expect(r.headers['cache-control']).toContain('immutable');
      expect((await app.inject({ method: 'GET', url: local(links[level]!), headers: { 'if-none-match': `"${m.levels[level]!.file}"` } })).statusCode).toBe(304);
    }
    expect(sha((await app.inject({ method: 'GET', url: local(links['manifest']!) })).rawPayload)).toBe(manifest);
    // A forged link, and one past its hour.
    expect((await app.inject({ method: 'GET', url: local(links['lod0']!).replace(/s=[^&]+/, 's=forged') })).statusCode).toBe(403);
    clock = new Date(clock.getTime() + 61 * 60_000);
    await again(maker);
    await again(viewer);
    expect((await app.inject({ method: 'GET', url: local(links['lod0']!) })).statusCode).toBe(410);
    // Signed out, no delivery; an unknown manifest, none either.
    expect((await app.inject({ method: 'GET', url: `/api/v1/avatar-files/${manifest}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/avatar-files/${'0'.repeat(64)}`, headers: viewer.auth })).statusCode).toBe(404);

    // Someone else's avatar is not theirs to wear; a deleted one is worn by no one and delivered to no one.
    expect((await app.inject({ method: 'PUT', url: '/api/v1/me/avatar', headers: viewer.auth, payload: { avatar: id } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/avatars/${id}`, headers: maker.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/avatar-files/${manifest}`, headers: viewer.auth })).statusCode).toBe(404);
    const [a] = await db.query<{ avatar_id: string | null }>('select avatar_id from accounts where id = $1', [maker.id]);
    expect(a!.avatar_id).toBeNull();
  }, 90_000);
});

describe('the converter’s sandbox', () => {
  it('reads only the converter and the upload, writes only its folder, and loosens nothing', () => {
    const args = converterArgs({ script: '/c/avatar-cli.ts', sandbox: '/c/sandbox.ts', reads: ['/c', '/nm'] }, '/tmp/x/upload', '/tmp/x/out', true);
    expect(args.slice(0, 5)).toEqual(['--permission', '--allow-fs-read=/c', '--allow-fs-read=/nm', '--allow-fs-read=/tmp/x/upload', '--allow-fs-write=/tmp/x/out']);
    expect(args.filter((a) => /^--allow-(addons|child-process|worker|wasi)/.test(a) || a === '--no-permission')).toEqual([]);
    expect(args).toContain('--import');
    expect(args.at(-1)).toBe('/tmp/x/out');
  });
});
