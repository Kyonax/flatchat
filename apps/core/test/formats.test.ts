// SPDX-License-Identifier: AGPL-3.0-or-later
// More model formats in the core (S5.08): a DAE avatar is read by the converter itself, with no
// Blender; a core without Blender refuses an FBX, an OBJ or a .blend with that reason; with Blender
// (here a stand-in that writes what the real one makes of the converter's samples) an FBX avatar
// and an OBJ item go through it into ready ones whose manifests name the upload itself, and a file
// Blender cannot read keeps Blender's reason. An item's declaration given with its slot is checked
// then and used for a file that keeps none. Where Blender is, the real one takes the same road.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderSamples, sampleDae, SAMPLE_PROP_DECLARATION } from '@flatchat/converter/format-samples';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { type FileStore, localStore } from '../src/store.ts';
import { freshDb } from './db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = join(ROOT, 'tools', 'converter', 'test', 'fixtures', 'formats');
const BLENDER = process.env['FLATCHAT_BLENDER'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender', 'blender-5.2.2-linux-x64', 'blender');

let db: Db;
let dir: string;
let store: FileStore;
/** A core with no Blender, and one whose Blender is the stand-in. */
let bare: FastifyInstance;
let blended: FastifyInstance;
const clock = new Date('2026-10-18T12:00:00Z');
const secret = randomBytes(32);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'http://127.0.0.1:1';

const core = (blender?: string): Promise<FastifyInstance> =>
  buildCore({ db, secret, publicUrl: PUBLIC, operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, store, avatars: { ktx2: false }, ...(blender ? { blender } : {}) });

beforeAll(async () => {
  db = await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'fcformats-'));
  store = localStore(join(dir, 'store'), secret, PUBLIC);
  // Headless Blender's stand-in: for the format it is asked to read, the GLB the real one makes of
  // the converter's sample (the fixtures); a .blend it cannot read, as Blender says so.
  const stub = join(dir, 'blender');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      'while [ "$1" != "--" ]; do shift; done',
      'shift',
      'case "$3" in',
      `  fbx) cp "${join(FIXTURES, 'avatar-fbx.glb')}" "$2" ;;`,
      `  obj) cp "${join(FIXTURES, 'prop-obj.glb')}" "$2" ;;`,
      '  *) echo "to-glb: Blender could not read the .blend file: File format is not supported" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  bare = await core();
  blended = await core(stub);
});
afterAll(async () => {
  await bare.close();
  await blended.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Who = { id: string; auth: Record<string, string> };
let people = 0;
async function account(email: string): Promise<Who> {
  people += 1;
  const code = (await createInvitation(db, {}, clock)).code;
  const r = await bare.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.97.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  await db.query('update accounts set trust = 1 where id = $1', [id]);
  return { id, auth: { authorization: `Bearer ${(await startSession(db, id, clock)).access}` } };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const local = (url: string): string => url.slice(PUBLIC.length);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

async function upload(app: FastifyInstance, who: Who, kind: 'items' | 'avatars', bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<string> {
  const slot = await app.inject({ method: 'POST', url: `/api/v1/${kind}`, headers: who.auth, payload: { name: 'Upload', bytes: bytes.length, sha256: sha(bytes), ...extra } });
  expect(slot.statusCode, slot.body).toBe(201);
  const { id, upload: u } = slot.json() as { id: string; upload: { url: string } };
  const sent = await app.inject({ method: 'PUT', url: local(u.url), headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) });
  expect(sent.statusCode, sent.body).toBe(202);
  return id;
}

async function settled(app: FastifyInstance, who: Who, kind: 'items' | 'avatars', id: string): Promise<Record<string, unknown>> {
  const end = Date.now() + 240_000;
  for (;;) {
    const list = (await app.inject({ method: 'GET', url: `/api/v1/${kind}`, headers: who.auth })).json() as Record<string, Array<Record<string, unknown>>>;
    const a = list[kind]!.find((v) => v['id'] === id);
    if (a && a['status'] !== 'converting' && a['status'] !== 'uploading') return a;
    if (Date.now() > end) throw new Error(`still converting: ${JSON.stringify(a)}`);
    // Every call counts against the address's API limit: no faster than this.
    await new Promise((r) => setTimeout(r, 500));
  }
}
const manifest = (row: Record<string, unknown>): Record<string, unknown> => JSON.parse(new TextDecoder().decode(store.read(row['manifest'] as string)!)) as Record<string, unknown>;

/** An FBX's first bytes, and some more: what the stand-in Blender is handed. */
const FBX = new Uint8Array([...text('Kaydara FBX Binary  \0\u001a\0'), ...randomBytes(64)]);
const OBJ = text('# a cube\no cube\nv -0.1 -0.1 -0.1\nv 0.1 -0.1 -0.1\nv 0.1 0.1 -0.1\nf 1 2 3\n');
const BLEND = new Uint8Array([...text('BLENDER-v504REND'), ...randomBytes(64)]);

describe('a DAE', () => {
  it('is read by the converter itself, with no Blender, its manifest naming the upload', async () => {
    const who = await account('dae@example.org');
    const dae = await sampleDae('avatar');
    const row = await settled(bare, who, 'avatars', await upload(bare, who, 'avatars', dae));
    expect(row, JSON.stringify(row['problems'])).toMatchObject({ status: 'ready', rank: 'excellent' });
    expect(manifest(row)['source']).toMatchObject({ from: 'dae', sha256: sha(dae), bytes: dae.length });
  }, 300_000);
});

describe('FBX, OBJ and .blend', () => {
  it('are refused by a core without Blender, with that reason', async () => {
    const who = await account('no-blender@example.org');
    for (const [kind, bytes, name] of [['avatars', FBX, 'FBX'], ['items', OBJ, 'OBJ'], ['avatars', BLEND, '.blend']] as const) {
      const row = await settled(bare, who, kind, await upload(bare, who, kind, bytes, kind === 'items' ? { declaration: SAMPLE_PROP_DECLARATION } : {}));
      expect(row['status']).toBe('refused');
      expect((row['problems'] as string[]).join(' ')).toBe(`the ${name} file needs headless Blender on the core, which this one does not have: export a VRM or a GLB instead`);
    }
  }, 300_000);

  it('go through Blender into ready ones whose manifests name the upload itself', async () => {
    const who = await account('blender@example.org');
    const avatar = await settled(blended, who, 'avatars', await upload(blended, who, 'avatars', FBX));
    expect(avatar, JSON.stringify(avatar['problems'])).toMatchObject({ status: 'ready', rank: 'excellent' });
    expect(manifest(avatar)['source']).toMatchObject({ from: 'fbx', sha256: sha(FBX), bytes: FBX.length, kind: 'glb' });
    // An OBJ keeps no declaration: the one given with its slot is used.
    const item = await settled(blended, who, 'items', await upload(blended, who, 'items', OBJ, { declaration: SAMPLE_PROP_DECLARATION }));
    expect(item, JSON.stringify(item['problems'])).toMatchObject({ status: 'ready', slot: 'attachment' });
    expect(manifest(item)).toMatchObject({ name: 'Sample cube', attach: 'head_top', source: { from: 'obj', sha256: sha(OBJ), bytes: OBJ.length } });
    // With none, the converter says what to give.
    const undeclared = await settled(blended, who, 'items', await upload(blended, who, 'items', OBJ));
    expect((undeclared['problems'] as string[]).join(' ')).toMatch(/the OBJ file keeps no declaration/);
  }, 300_000);

  it('keep Blender’s reason for a file it cannot read', async () => {
    const who = await account('unreadable@example.org');
    const row = await settled(blended, who, 'avatars', await upload(blended, who, 'avatars', BLEND));
    expect(row['status']).toBe('refused');
    expect(row['problems']).toEqual(['Blender could not read the .blend file: File format is not supported']);
  }, 300_000);
});

describe('an item’s declaration given with its slot', () => {
  it('is checked then, and refused with every reason when it does not read', async () => {
    const who = await account('declares@example.org');
    const bytes = randomBytes(64);
    const bad = await bare.inject({ method: 'POST', url: '/api/v1/items', headers: who.auth, payload: { name: 'Cape', bytes: bytes.length, sha256: sha(bytes), declaration: { name: 'Cape', slot: 'cape', hides: ['tail'] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/slot \\"cape\\" is not one of.*\\"tail\\" is not a region/);
    const good = await bare.inject({ method: 'POST', url: '/api/v1/items', headers: who.auth, payload: { name: 'Cube', bytes: bytes.length, sha256: sha(bytes), declaration: SAMPLE_PROP_DECLARATION } });
    expect(good.statusCode, good.body).toBe(201);
    const [row] = await db.query<{ declaration: unknown }>('select declaration from items where id = $1', [(good.json() as { id: string }).id]);
    expect(row!.declaration).toEqual({ ...SAMPLE_PROP_DECLARATION, hides: [] });
  });
});

describe.runIf(existsSync(BLENDER))('the real headless Blender', () => {
  it('reads an FBX avatar and a .blend item that declares itself', async () => {
    const app = await core(BLENDER);
    const work = mkdtempSync(join(tmpdir(), 'fcblender-'));
    try {
      const road = await blenderSamples(BLENDER, work);
      const who = await account('real-blender@example.org');
      const fbx = new Uint8Array(readFileSync(road['avatar.fbx'].file));
      const avatar = await settled(app, who, 'avatars', await upload(app, who, 'avatars', fbx));
      expect(avatar, JSON.stringify(avatar['problems'])).toMatchObject({ status: 'ready', rank: 'excellent' });
      expect(manifest(avatar)).toMatchObject({ expressions: ['aa', 'blinkLeft'], source: { from: 'fbx', sha256: sha(fbx) } });
      const blend = new Uint8Array(readFileSync(road['prop.blend'].file));
      const item = await settled(app, who, 'items', await upload(app, who, 'items', blend));
      expect(item, JSON.stringify(item['problems'])).toMatchObject({ status: 'ready', slot: 'attachment' });
      expect(manifest(item)).toMatchObject({ name: 'Sample cube', source: { from: 'blend', sha256: sha(blend) } });
    } finally {
      await app.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);
});
