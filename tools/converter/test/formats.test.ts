// SPDX-License-Identifier: MPL-2.0
// The formats a model may be uploaded in (S5.08): each known by its first bytes, never its name; a
// DAE avatar and a DAE prop converted here through assimp; the GLBs Blender makes of an FBX avatar,
// an FBX garment, an OBJ prop and a .blend prop (the fixtures) converted as the core converts them,
// each manifest naming the upload's own format, SHA-256 and size; a garment from another program
// found by its meshes' names and sitting on the body exactly as the GLB tee does; a file with no
// declaration of its own given one at upload, and one with its own keeping it; FBX, OBJ and .blend
// refused by the converter alone; the converter programs reading them inside their sandbox; and,
// where Blender is, the whole road again from the samples, giving the fixtures' very bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, type BodyKit, type ItemManifest, uploadFormat } from '@flatchat/content';
import type { Node } from '@gltf-transform/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { AvatarError, type AvatarResult, avatarIO, convertAvatar, readAvatarLevel } from '../src/avatar/convert.ts';
import { sampleAvatar } from '../src/avatar/samples.ts';
import { clippingOf, type KitBody, kitBody } from '../src/item/clipping.ts';
import { convertItem, ItemError, type ItemOptions } from '../src/item/convert.ts';
import { BLENDER_SAMPLES, blenderSamples, sampleDae, SAMPLE_PROP_DECLARATION, SAMPLE_TEE_DECLARATION } from '../src/source/samples.ts';
import type { UploadSource } from '../src/source/upload.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIXTURES = join(HERE, 'fixtures', 'formats');
const GOLDEN = join(HERE, 'golden', 'formats.json');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const TEE = new Uint8Array(readFileSync(join(ROOT, 'kits', 'items', 'test-tee', 'test-tee.glb')));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** What the core passes with a GLB its Blender made: the upload's own numbers. */
const upload = (from: UploadSource['from']): UploadSource => ({ sha256: sha(text(from)), bytes: 4242, from });

const kits: Partial<Record<BodyKit, KitBody>> = {};
let daeAvatar: Uint8Array;
let daeProp: Uint8Array;
const avatars = new Map<string, AvatarResult>();
beforeAll(async () => {
  for (const body of BODY_KITS) {
    const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', body, `${body}.vrm`))));
    kits[body] = kitBody(body, doc, data);
  }
  daeAvatar = await sampleDae('avatar');
  daeProp = await sampleDae('prop');
  avatars.set('dae avatar', await convertAvatar(daeAvatar, { ktx2: false }));
  avatars.set('fbx avatar', await convertAvatar(fixture('avatar-fbx.glb'), { ktx2: false, source: upload('fbx') }));
}, 120_000);

const item = (bytes: Uint8Array, o: ItemOptions = {}): ReturnType<typeof convertItem> => convertItem(bytes, { ktx2: false, kits, ...o });
const refused = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof AvatarError || err instanceof ItemError) return err.problems.join(' | ');
    throw err;
  }
  throw new Error('it converted');
};
const itemSummary = (m: ItemManifest): Record<string, unknown> => ({
  from: m.source.from,
  name: m.name,
  slot: m.slot,
  ...(m.attach ? { attach: m.attach } : {}),
  ...(m.prop ? { prop: { triangles: m.prop.triangles, materialSlots: m.prop.materialSlots, joints: m.prop.joints } } : {}),
  fits: Object.fromEntries(Object.entries(m.fits).map(([b, f]) => [b, { triangles: f!.triangles, materialSlots: f!.materialSlots, joints: f!.joints }])),
  clipping: m.clipping,
  warnings: m.warnings,
});

describe('an upload is known by its first bytes', () => {
  it('whatever it is called', async () => {
    expect(uploadFormat(await sampleAvatar('vrm1'))).toBe('gltf');
    expect(uploadFormat(fixture('avatar-fbx.glb'))).toBe('gltf');
    expect(uploadFormat(text('Kaydara FBX Binary  \0\u001a\0'))).toBe('fbx');
    expect(uploadFormat(text('; FBX 7.4.0 project file\n'))).toBe('fbx');
    expect(uploadFormat(text('BLENDER-v504REND'))).toBe('blend');
    expect(uploadFormat(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0))).toBe('blend');
    expect(uploadFormat(Uint8Array.of(0x1f, 0x8b, 8, 0))).toBe('blend');
    expect(uploadFormat(daeProp)).toBe('dae');
    expect(uploadFormat(text('﻿<?xml version="1.0"?>\n<!-- by hand -->\n<COLLADA version="1.4.1">'))).toBe('dae');
    expect(uploadFormat(text('# Blender 5.2.2\no cap\nv 0 0 0\n'))).toBe('obj');
    expect(uploadFormat(text('{"asset":{"version":"2.0"}}'))).toBe('unknown');
    expect(uploadFormat(text('<html><body>no</body></html>'))).toBe('unknown');
    expect(uploadFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('the formats', () => {
  it('convert as the golden file says', async () => {
    const summary: Record<string, unknown> = {};
    for (const [name, r] of avatars) {
      const m = r.manifest;
      summary[name] = { from: m.source.from, kind: m.source.kind, rank: m.rank, levels: Object.fromEntries(Object.entries(m.levels).map(([n, l]) => [n, { triangles: l.triangles, bones: l.bones, materialSlots: l.materialSlots }])), bones: m.bones.length, expressions: m.expressions, height: m.height, warnings: m.warnings };
    }
    summary['dae prop'] = itemSummary((await item(daeProp, { declaration: SAMPLE_PROP_DECLARATION })).manifest);
    summary['obj prop'] = itemSummary((await item(fixture('prop-obj.glb'), { declaration: SAMPLE_PROP_DECLARATION, source: upload('obj') })).manifest);
    summary['blend prop'] = itemSummary((await item(fixture('prop-blend.glb'), { source: upload('blend') })).manifest);
    summary['fbx tee'] = itemSummary((await item(fixture('tee-fbx.glb'), { declaration: SAMPLE_TEE_DECLARATION, source: upload('fbx') })).manifest);
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (process.env['FLATCHAT_GOLDEN_WRITE'] === '1') writeFileSync(GOLDEN, json);
    expect(json).toBe(readFileSync(GOLDEN, 'utf8'));
  }, 120_000);

  it('name the upload itself in the manifest: its format, SHA-256 and size', async () => {
    expect(avatars.get('dae avatar')!.manifest.source).toMatchObject({ sha256: sha(daeAvatar), bytes: daeAvatar.length, kind: 'glb', from: 'dae' });
    expect(avatars.get('fbx avatar')!.manifest.source).toMatchObject({ ...upload('fbx'), kind: 'glb' });
    expect((await item(daeProp, { declaration: SAMPLE_PROP_DECLARATION })).manifest.source).toEqual({ sha256: sha(daeProp), bytes: daeProp.length, from: 'dae' });
    // A GLB is its own source, with no other format named.
    const glb = await sampleAvatar('glb');
    expect((await convertAvatar(glb, { ktx2: false })).manifest.source).not.toHaveProperty('from');
  }, 120_000);

  it('keep what Blender carries: an FBX avatar its shape keys, a DAE one none (assimp reads no morphs)', () => {
    expect(avatars.get('fbx avatar')!.manifest.expressions).toEqual(['aa', 'blinkLeft']);
    expect(avatars.get('dae avatar')!.manifest.expressions).toEqual([]);
    for (const r of avatars.values()) expect(r.manifest.rank).toBe('excellent');
  });
});

describe('a garment from another program', () => {
  const fitNode = async (bytes: Uint8Array, body: BodyKit): Promise<Node> => {
    const doc = await avatarIO().readBinary(bytes);
    return doc
      .getRoot()
      .listNodes()
      .find((n) => n.getMesh() && n.getSkin() && (n.getExtras()['flatchat_fit'] === body || n.getName().includes(body)))!;
  };

  it('is found by its meshes’ names and sits on the body exactly as the GLB tee does', async () => {
    const r = await item(fixture('tee-fbx.glb'), { declaration: SAMPLE_TEE_DECLARATION, source: upload('fbx') });
    expect(Object.keys(r.manifest.fits)).toEqual(['feminine']);
    // Nothing hidden, every body point under it counts: the same points, the same depths.
    const fbx = clippingOf(kits.feminine!, await fitNode(fixture('tee-fbx.glb'), 'feminine'), []);
    const glb = clippingOf(kits.feminine!, await fitNode(TEE, 'feminine'), []);
    expect(fbx.checked).toBeGreaterThan(10_000);
    expect(fbx).toEqual(glb);
  }, 120_000);

  it('converts to the same fits as the marked tee when its marks are gone and its declaration is given', async () => {
    const io = avatarIO();
    const doc = await io.readBinary(TEE);
    for (const n of doc.getRoot().listNodes()) n.setExtras({});
    for (const s of doc.getRoot().listScenes()) s.setExtras({});
    const bare = await io.writeBinary(doc);
    expect(await refused(() => item(bare))).toMatch(/the file declares nothing: give its scene the custom property flatchat_item/);
    const r = await item(bare, { declaration: SAMPLE_TEE_DECLARATION });
    const marked = await item(TEE);
    expect(Object.fromEntries(Object.entries(r.manifest.fits).map(([b, f]) => [b, f!.file]))).toEqual(Object.fromEntries(Object.entries(marked.manifest.fits).map(([b, f]) => [b, f!.file])));
  }, 120_000);
});

describe('a declaration', () => {
  it('is given at upload to a file that keeps none (DAE, OBJ), and refused without one', async () => {
    expect(await refused(() => item(daeProp))).toMatch(/the DAE file keeps no declaration: give the item's name, its slot/);
    expect(await refused(() => item(fixture('prop-obj.glb'), { source: upload('obj') }))).toMatch(/the OBJ file keeps no declaration/);
    expect(await refused(() => item(fixture('prop-obj.glb'), { source: upload('obj'), declaration: { ...SAMPLE_PROP_DECLARATION, attach: 'tail' } }))).toMatch(/the point it is worn at/);
  }, 60_000);

  it('in the file wins over one given at upload (a .blend keeps its own)', async () => {
    const r = await item(fixture('prop-blend.glb'), { source: upload('blend'), declaration: { ...SAMPLE_PROP_DECLARATION, name: 'Something else', attach: 'hand_l' } });
    expect(r.manifest).toMatchObject({ name: 'Sample cube', attach: 'head_top' });
  });
});

describe('the converter alone', () => {
  it('leaves FBX, OBJ and .blend to the core’s Blender, and refuses a broken DAE with a reason', async () => {
    for (const bytes of [text('Kaydara FBX Binary  \0\u001a\0'), text('o cap\nv 0 0 0\n'), Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0, 0)]) {
      expect(await refused(() => convertAvatar(bytes, { ktx2: false }))).toMatch(/read by headless Blender on the core first/);
      expect(await refused(() => item(bytes))).toMatch(/read by headless Blender on the core first/);
    }
    expect(await refused(() => convertAvatar(text('<?xml version="1.0"?><COLLADA version="1.4.1"><library_geometries><geometry id="x"><mesh>'), { ktx2: false }))).toMatch(/assimp could not read the Collada file/);
    // Blender's GLB, said to be one, that is not.
    expect(await refused(() => convertAvatar(daeAvatar, { ktx2: false, source: upload('fbx') }))).toMatch(/what Blender wrote from the FBX file is not a GLB/);
  }, 60_000);
});

describe('the converter programs', () => {
  const run = (script: string, args: string[], reads: string[], out: string): { status: number | null; stderr: string; result?: { ok: boolean; manifest?: Record<string, unknown>; problems?: string[] } } => {
    const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, ...reads.map((x) => `--allow-fs-read=${x}`), `--allow-fs-write=${out}`, '--import', join(HERE, '..', 'src', 'sandbox.ts'), join(HERE, '..', 'src', script), ...args], { encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stderr: r.stderr, ...(existsSync(join(out, 'result.json')) ? { result: JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) as never } : {}) };
  };

  it('read a DAE inside the sandbox, and a Blender GLB with its upload’s numbers and declaration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcformats-'));
    try {
      writeFileSync(join(dir, 'in.dae'), daeAvatar);
      mkdirSync(join(dir, 'a'));
      const a = run('avatar-cli.ts', [join(dir, 'in.dae'), join(dir, 'a'), '--no-ktx2'], [join(dir, 'in.dae')], join(dir, 'a'));
      expect(a.status, a.stderr).toBe(0);
      expect(a.result?.manifest?.['source']).toMatchObject({ from: 'dae', sha256: sha(daeAvatar) });

      writeFileSync(join(dir, 'in.glb'), fixture('prop-obj.glb'));
      writeFileSync(join(dir, 'declare.json'), JSON.stringify(SAMPLE_PROP_DECLARATION));
      mkdirSync(join(dir, 'i'));
      const given = upload('obj');
      const i = run('item-cli.ts', [join(dir, 'in.glb'), join(dir, 'i'), join(ROOT, 'kits', 'bodies'), '--no-ktx2', '--from', 'obj', '--source', `${given.sha256}:${given.bytes}`, '--declare', join(dir, 'declare.json')], [join(dir, 'in.glb'), join(dir, 'declare.json')], join(dir, 'i'));
      expect(i.status, i.stderr).toBe(0);
      expect(i.result?.manifest).toMatchObject({ slot: 'attachment', attach: 'head_top', source: given });

      // A format the core does not pass through Blender, or a source that does not read: a usage error.
      for (const bad of [['--from', 'dae', '--source', `${given.sha256}:1`], ['--from', 'fbx'], ['--source', 'abc:1']]) {
        mkdirSync(join(dir, 'u'), { recursive: true });
        expect(run('avatar-cli.ts', [join(dir, 'in.glb'), join(dir, 'u'), ...bad], [join(dir, 'in.glb')], join(dir, 'u')).status).toBe(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

// The road through Blender, where Blender is (this desktop; CI reads the fixtures it wrote).
const BLENDER = process.env['FLATCHAT_BLENDER'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender', 'blender-5.2.2-linux-x64', 'blender');
describe.runIf(existsSync(BLENDER))('the road through headless Blender', () => {
  it('writes each format, which is known for what it is, and reads it back into the fixtures’ very bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcblender-'));
    try {
      const road = await blenderSamples(BLENDER, dir);
      for (const [name, from] of Object.entries(BLENDER_SAMPLES) as Array<[keyof typeof BLENDER_SAMPLES, string]>) {
        expect(uploadFormat(new Uint8Array(readFileSync(road[name].file))), name).toBe(from);
        expect(sha(new Uint8Array(readFileSync(road[name].glb))), name).toBe(sha(fixture(`${name.replace('.', '-')}.glb`)));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
