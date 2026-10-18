// SPDX-License-Identifier: AGPL-3.0-or-later
// Emotes and dances in the core (S5.07): a new account's upload is refused (trust level 1 needed);
// a trusted account uploads the BVH sample as a dance and the sandboxed converter makes one VRMA,
// which anyone signed in fetches through a signed link; a file that is no animation keeps its
// reasons; an FBX is refused by a core without Blender, and read by headless Blender where it is
// (this desktop; CI has none).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleBvh, sampleSong } from '@flatchat/converter/animation-samples';
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
const FBX = new Uint8Array(readFileSync(join(ROOT, 'tools', 'converter', 'test', 'fixtures', 'animation', 'wave.fbx')));
const BLENDER = process.env['FLATCHAT_BLENDER'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender', 'blender-5.2.2-linux-x64', 'blender');
const RHUBARB = process.env['FLATCHAT_RHUBARB'] ?? join(homedir(), '.local', 'opt', 'rhubarb-1.14.0', 'rhubarb');
const SONG = sampleSong();
const BVH = new TextEncoder().encode(sampleBvh());
const PUBLIC = 'http://127.0.0.1:1';
const clock = new Date('2026-10-18T12:00:00Z');
const secret = randomBytes(32);

let db: Db;
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
async function core(blender?: string, rhubarb?: string): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), 'fccoreanim-'));
  dirs.push(dir);
  const app = await buildCore({ db, secret, publicUrl: PUBLIC, operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, store: localStore(dir, secret, PUBLIC), avatars: { ktx2: false }, ...(blender ? { blender } : {}), animations: { ...(rhubarb ? { rhubarb } : {}) } });
  apps.push(app);
  return app;
}
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await db.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Who {
  id: string;
  auth: Record<string, string>;
}
let people = 0;
async function account(app: FastifyInstance, name: string, trust = 0): Promise<Who> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const email = `${name}@example.org`;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.98.${people}.1`,
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

async function upload(app: FastifyInstance, who: Who, bytes: Uint8Array, name: string, use = 'emote', sound?: Uint8Array): Promise<Record<string, unknown>> {
  const slot = await app.inject({ method: 'POST', url: '/api/v1/animations', headers: who.auth, payload: { name, bytes: bytes.length, sha256: sha(bytes), use, ...(sound ? { audio: { bytes: sound.length, sha256: sha(sound) } } : {}) } });
  expect(slot.statusCode, slot.body).toBe(201);
  const { id, upload: u, audio } = slot.json() as { id: string; upload: { url: string }; audio?: { url: string } };
  expect((await app.inject({ method: 'PUT', url: local(u.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) })).statusCode).toBe(202);
  // With a sound declared, nothing converts until the sound is in too.
  if (sound) {
    const waiting = ((await app.inject({ method: 'GET', url: '/api/v1/animations', headers: who.auth })).json() as { animations: Array<Record<string, unknown>> }).animations.find((v) => v['id'] === id);
    expect(waiting?.['status']).toBe('uploading');
    expect((await app.inject({ method: 'PUT', url: local(audio!.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(sound) })).statusCode).toBe(202);
  }
  const end = Date.now() + 180_000;
  for (;;) {
    const list = (await app.inject({ method: 'GET', url: '/api/v1/animations', headers: who.auth })).json() as { animations: Array<Record<string, unknown>> };
    const a = list.animations.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('animation uploads', () => {
  it('refuse a new account, and turn a trusted one’s BVH into a dance anyone can fetch', async () => {
    const app = await core();
    const fresh = await account(app, 'new-dancer');
    expect((await app.inject({ method: 'POST', url: '/api/v1/animations', headers: fresh.auth, payload: { name: 'x', bytes: BVH.length, sha256: sha(BVH), use: 'dance' } })).json()).toMatchObject({ error: 'upload-trust' });
    const dancer = await account(app, 'dancer', 1);
    expect((await app.inject({ method: 'POST', url: '/api/v1/animations', headers: dancer.auth, payload: { name: 'x', bytes: BVH.length, sha256: sha(BVH), use: 'sing' } })).json()).toMatchObject({ error: 'bad-request' });
    const ready = await upload(app, dancer, BVH, 'Wave', 'dance');
    expect(ready).toMatchObject({ name: 'Wave', use: 'dance', status: 'ready', source: 'bvh', duration: 2, loop: true, problems: [], warnings: [] });
    const viewer = await account(app, 'watcher');
    const d = await app.inject({ method: 'GET', url: `/api/v1/animation-files/${String(ready['manifest'])}`, headers: viewer.auth });
    expect(d.statusCode).toBe(200);
    const { manifest, links } = d.json() as { manifest: { file: string; use: string }; links: Record<string, string> };
    expect(manifest.use).toBe('dance');
    expect(sha((await app.inject({ method: 'GET', url: local(links['vrma']!) })).rawPayload)).toBe(manifest.file);
    // Deleted, it is delivered to no one.
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/animations/${String(ready['id'])}`, headers: dancer.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/animation-files/${String(ready['manifest'])}`, headers: viewer.auth })).statusCode).toBe(404);
  }, 120_000);

  it('keep a refused file’s reasons, and refuse FBX on a core without Blender', async () => {
    const app = await core();
    const maker = await account(app, 'animator', 1);
    const junk = await upload(app, maker, new TextEncoder().encode('HIERARCHY nothing more than a broken start of a file'), 'Junk');
    expect(junk['status']).toBe('refused');
    expect((junk['problems'] as string[]).join(' ')).toMatch(/BVH/);
    const fbx = await upload(app, maker, FBX, 'Wave FBX');
    expect(fbx['status']).toBe('refused');
    expect((fbx['problems'] as string[]).join(' ')).toMatch(/headless Blender on the core/);
  }, 120_000);

  it.runIf(existsSync(BLENDER))('read FBX through headless Blender where the core has it', async () => {
    const app = await core(BLENDER);
    const maker = await account(app, 'fbx-maker', 1);
    const ready = await upload(app, maker, FBX, 'Wave FBX');
    expect(ready).toMatchObject({ status: 'ready', source: 'fbx', duration: 2, loop: true });
  }, 180_000);

  it('take a dance with its sound, delivered with it; the mouth follows it where the core has Rhubarb', async () => {
    const app = await core(undefined, existsSync(RHUBARB) ? RHUBARB : undefined);
    const dancer = await account(app, 'singer', 1);
    const ready = await upload(app, dancer, BVH, 'Wave with a song', 'dance', SONG);
    expect(ready).toMatchObject({ status: 'ready', sound: true, mouth: existsSync(RHUBARB) });
    const d = await app.inject({ method: 'GET', url: `/api/v1/animation-files/${String(ready['manifest'])}`, headers: dancer.auth });
    const { manifest, links } = d.json() as { manifest: { audio: { file: string; type: string }; mouth: boolean }; links: Record<string, string> };
    expect(manifest.audio.type).toBe('audio/wav');
    expect(manifest.mouth).toBe(existsSync(RHUBARB));
    expect(sha((await app.inject({ method: 'GET', url: local(links['audio']!) })).rawPayload)).toBe(sha(SONG));
  }, 120_000);
});
