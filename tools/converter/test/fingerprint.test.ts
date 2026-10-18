// SPDX-License-Identifier: MPL-2.0
// Fingerprints (S5.09): the sample humanoid written again (through Blender as an FBX, through assimp
// as a DAE, as the converter's own LOD0 that clients download, and moved, turned, mirrored and
// scaled) keeps its shape exactly, and another model (a robot, the three standard bodies) shares
// next to none of it; a texture re-encoded or halved stays within the match's bits and another does
// not, and a flat one has no hash; an item has a shape per fit, and one fit taken alone matches it;
// a model of a few triangles says nothing; the same file gives the same fingerprint; and the
// standard bodies' file (kits/bodies/fingerprints.json, the core's) is what they measure.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Fingerprint, matchOf, SHAPE_MATCH, shapeSimilarity, TEXTURE_MATCH_BITS, textureDistance } from '@flatchat/content';
import jpeg from 'jpeg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { avatarIO, convertAvatar, readAvatarLevel } from '../src/avatar/convert.ts';
import { sampleAvatar } from '../src/avatar/samples.ts';
import { imageHash } from '../src/fingerprint.ts';
import { convertItem } from '../src/item/convert.ts';
import { sampleProp } from '../src/item/samples.ts';
import { sampleDae, SAMPLE_PROP_DECLARATION, SAMPLE_TEE_DECLARATION } from '../src/source/samples.ts';
import { decodeImage, halve } from '../src/textures.ts';
import { kitFingerprints } from '../scripts/kit-fingerprints.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const file = (...p: string[]): Uint8Array => new Uint8Array(readFileSync(join(ROOT, ...p)));
const fingerprint = async (bytes: Uint8Array): Promise<Fingerprint> => (await convertAvatar(bytes, { ktx2: false })).fingerprint;

let glb: Uint8Array;
let base: Fingerprint;
let lod0: Uint8Array;
beforeAll(async () => {
  glb = await sampleAvatar('glb');
  const r = await convertAvatar(glb, { ktx2: false });
  base = r.fingerprint;
  lod0 = r.files.get(r.manifest.levels.lod0.file)!;
}, 60_000);

/** The sample, moved, turned a quarter, mirrored and scaled by 1.3. */
async function moved(): Promise<Uint8Array> {
  const io = avatarIO();
  const doc = await io.readBinary(glb);
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      const a = p.getAttribute('POSITION')!;
      const e: number[] = [];
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, e);
        a.setElement(i, [-e[2]! * 1.3 + 5, e[1]! * 1.3 - 1, -e[0]! * 1.3 + 2]);
      }
    }
  }
  return io.writeBinary(doc);
}

describe('a shape', () => {
  it('stays the same through a re-export, a move, a turn, a mirror and a scale', async () => {
    expect(base.shapes).toHaveLength(1);
    for (const copy of [file('tools', 'converter', 'test', 'fixtures', 'formats', 'avatar-fbx.glb'), await sampleDae('avatar'), lod0, await moved()]) {
      const f = await fingerprint(copy);
      expect(shapeSimilarity(f.shapes[0]!, base.shapes[0]!)).toBeGreaterThanOrEqual(0.95);
      expect(matchOf(f, base)?.by).toBe('shape');
    }
  }, 120_000);

  it('shares next to nothing with another model, even bodies of one topology', async () => {
    const kits = await Promise.all(['feminine', 'masculine', 'neutral'].map(async (b) => fingerprint(file('kits', 'bodies', b, `${b}.vrm`))));
    for (const other of [await fingerprint(await sampleAvatar('free')), ...kits].filter((f) => f.shapes.length > 0)) expect(shapeSimilarity(other.shapes[0]!, base.shapes[0]!)).toBeLessThan(0.25);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(shapeSimilarity(kits[i]!.shapes[0]!, kits[j]!.shapes[0]!)).toBeLessThan(SHAPE_MATCH / 3);
  }, 120_000);

  it('is one per fit for an item, and one fit taken alone matches it', async () => {
    const tee = (await convertItem(file('kits', 'items', 'test-tee', 'test-tee.glb'), { ktx2: false })).fingerprint;
    expect(tee.shapes).toHaveLength(3);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(shapeSimilarity(tee.shapes[i]!, tee.shapes[j]!)).toBeLessThan(0.1);
    const one = (await convertItem(file('tools', 'converter', 'test', 'fixtures', 'formats', 'tee-fbx.glb'), { ktx2: false, declaration: SAMPLE_TEE_DECLARATION })).fingerprint;
    expect(one.shapes).toHaveLength(1);
    expect(matchOf(one, tee)).toEqual({ by: 'shape', score: 1 });
  }, 120_000);

  it('says nothing of a model of a few triangles, and the same of the same file', async () => {
    expect((await convertItem(await sampleProp(SAMPLE_PROP_DECLARATION), { ktx2: false })).fingerprint.shapes).toEqual([]);
    expect(await fingerprint(glb)).toEqual(base);
  }, 60_000);
});

describe('a texture', () => {
  it('keeps its hash within the match through a re-encoding and a halving, and another does not', async () => {
    // A painted texture: the feminine body's skin. (A 64 px checkerboard keeps its energy in the
    // high frequencies a perceptual hash leaves out: it is no test of one.)
    const { doc } = await readAvatarLevel(file('kits', 'bodies', 'feminine', 'feminine.vrm'));
    const tex = doc.getRoot().listTextures().find((t) => t.getName().endsWith('_skin'))!;
    const img = decodeImage(tex.getImage()!, tex.getMimeType())!;
    const h = imageHash(img)!;
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    const reencoded = jpeg.decode(jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data) }, 70).data, { useTArray: true });
    expect(textureDistance(h, imageHash({ width: reencoded.width, height: reencoded.height, data: reencoded.data })!)).toBeLessThanOrEqual(TEXTURE_MATCH_BITS);
    expect(textureDistance(h, imageHash(halve(halve(img)))!)).toBeLessThanOrEqual(TEXTURE_MATCH_BITS);
    expect(base.textures).toHaveLength(1);
    expect(textureDistance(h, base.textures[0]!)).toBeGreaterThan(TEXTURE_MATCH_BITS * 2);
  }, 60_000);

  it('of one flat colour has none', () => {
    expect(imageHash({ width: 16, height: 16, data: new Uint8Array(16 * 16 * 4).fill(200) })).toBeUndefined();
  });
});

describe('the standard bodies’ fingerprints', () => {
  it('are what kits/bodies/fingerprints.json holds (node tools/converter/scripts/kit-fingerprints.ts writes it)', async () => {
    expect(await kitFingerprints()).toBe(readFileSync(join(ROOT, 'kits', 'bodies', 'fingerprints.json'), 'utf8'));
  }, 120_000);
});
