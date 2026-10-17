// SPDX-License-Identifier: MPL-2.0
// The world converter (S2.03): golden files for the plaza (a change in what it builds must be
// deliberate: FLATCHAT_GOLDEN_WRITE=1 rewrites them), a world with a texture turned into KTX2, a
// world whose meshes become solids, and a refused world.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeColliders, parseBuiltWorld } from '@flatchat/content';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { addBox, type MeshSpec, writeGlb } from '../src/glb-writer.ts';
import { ConvertError, convertWorld, decompose, halve, readFolder } from '../src/world.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAZA = join(HERE, '..', '..', '..', 'kits', 'worlds', 'plaza');
const GOLDEN = join(HERE, 'golden', 'plaza.world.json');
const enc = new TextEncoder();

describe('the plaza', () => {
  it('builds exactly as the golden file says', async () => {
    const { out, warnings } = await convertWorld(readFolder(PLAZA), { ktx2: false });
    const json = new TextDecoder().decode(out.get('world.json')!);
    if (process.env['FLATCHAT_GOLDEN_WRITE'] === '1') writeFileSync(GOLDEN, json);
    expect(json).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(warnings).toEqual([]);
    const parsed = parseBuiltWorld(JSON.parse(json));
    if ('error' in parsed) throw new Error(parsed.error);
    const w = parsed.world;
    expect(w.scenes[0]!.spawns[0]).toMatchObject({ title: 'The fountain', group: 'start' });
    const colliders = decodeColliders(out.get(`content/${w.collision}`)!);
    expect(colliders).toHaveLength(37);
    expect(colliders.every((c) => c.type === 'box')).toBe(true);
    expect(w.navmesh && out.get(`content/${w.navmesh}`)!.length).toBeGreaterThan(1000);
    // The scene is compressed with meshopt and reads back.
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    await MeshoptDecoder.ready;
    const doc = await io.readBinary(out.get(`content/${w.scenes[0]!.glb}`)!);
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');
    expect(doc.getRoot().listMeshes()).toHaveLength(6);
  });
});

function world(meshes: MeshSpec[], nodes: Parameters<typeof writeGlb>[1], extra: Record<string, Uint8Array> = {}, toml = ''): Map<string, Uint8Array> {
  return new Map([
    ['world.toml', enc.encode(`format = 1\nname = "Test"\n${toml}[[scenes]]\nid = "main"\nfile = "main.glb"\n`)],
    ['main.glb', writeGlb(meshes, nodes, {}, ['OMI_spawn_point'])],
    ...Object.entries(extra),
  ]);
}

function cube(): MeshSpec {
  const m: MeshSpec = { name: 'cube', positions: [], normals: [], indices: [], colour: [1, 1, 1, 1] };
  addBox(m, [-1, 0, -1], [1, 2, 1]);
  return m;
}

describe('a world with no solids marked', () => {
  it('makes every mesh a static triangle mesh at its place, and says so', async () => {
    const files = world([cube()], [
      { name: 'cube', mesh: 0, translation: [10, 0, 5] },
      { name: 'spawn', translation: [0, 0, 0], extensions: { OMI_spawn_point: {} } },
    ]);
    const { world: w, out, warnings } = await convertWorld(files, { ktx2: false });
    expect(warnings.some((x) => x.includes('marks no solids'))).toBe(true);
    const [mesh] = decodeColliders(out.get(`content/${w.collision}`)!);
    expect(mesh?.type).toBe('trimesh');
    if (mesh?.type !== 'trimesh') return;
    expect(mesh.indices.length).toBe(36);
    expect(Math.min(...mesh.positions.filter((_, i) => i % 3 === 0))).toBe(9);
  });
});

describe('textures', () => {
  it('fit the size limit and become KTX2 with Basis Universal', async () => {
    const png = new PNG({ width: 4096, height: 64 });
    png.data.fill(200);
    const glb = writeGlb([cube()], [{ name: 'cube', mesh: 0 }, { name: 'spawn', extensions: { OMI_spawn_point: {} } }], {}, ['OMI_spawn_point']);
    // The cube's material gets an image beside the scene.
    const files = new Map([
      ['world.toml', enc.encode('format = 1\nname = "Textured"\n[[scenes]]\nid = "main"\nfile = "main.gltf"\n')],
    ]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(glb);
    const tex = doc.createTexture('wall').setImage(new Uint8Array(PNG.sync.write(png))).setMimeType('image/png').setURI('wall.png');
    doc.getRoot().listMaterials()[0]!.setBaseColorTexture(tex);
    const { json, resources } = await io.writeJSON(doc, { format: 'json' as never, basename: 'main' });
    files.set('main.gltf', enc.encode(JSON.stringify({ ...json, nodes: (json.nodes ?? []).map((n, i) => (i === 1 ? { ...n, extensions: { OMI_spawn_point: {} } } : n)), extensionsUsed: [...(json.extensionsUsed ?? []), 'OMI_spawn_point'] })));
    for (const [k, v] of Object.entries(resources)) files.set(k, v);
    const { world: w, out } = await convertWorld(files, { ktx2: true });
    const built = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).readBinary(out.get(`content/${w.scenes[0]!.glb}`)!);
    const t = built.getRoot().listTextures()[0]!;
    expect(t.getMimeType()).toBe('image/ktx2');
    expect([...t.getImage()!.subarray(0, 12)]).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    // 4096 wide fitted to 2048.
    expect(new DataView(t.getImage()!.buffer, t.getImage()!.byteOffset).getUint32(20, true)).toBe(2048);
  }, 60_000);

  it('halve by averaging', () => {
    const img = { width: 2, height: 2, data: Uint8Array.from([0, 0, 0, 0, 100, 100, 100, 100, 200, 200, 200, 200, 100, 100, 100, 100]) };
    expect(halve(img)).toEqual({ width: 1, height: 1, data: Uint8Array.from([100, 100, 100, 100]) });
  });
});

describe('refusals and transforms', () => {
  it('refuses an invalid world with its problems', async () => {
    const files = world([cube()], [{ name: 'cube', mesh: 0 }]);
    await expect(convertWorld(files, { ktx2: false })).rejects.toBeInstanceOf(ConvertError);
    await expect(convertWorld(files, { ktx2: false })).rejects.toThrow(/no-spawn/);
  });

  it('decomposes a world matrix into position, rotation and scale', () => {
    const s = Math.SQRT1_2;
    // A quarter turn about y, scaled by 2, at (1, 2, 3).
    const m = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 1, 2, 3, 1];
    const d = decompose(m);
    expect(d.position).toEqual([1, 2, 3]);
    expect(d.scale).toEqual([2, 2, 2]);
    expect(d.rotation.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, Math.round(s * 1000) / 1000, 0, Math.round(s * 1000) / 1000]);
  });
});
