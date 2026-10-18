// SPDX-License-Identifier: Apache-2.0
// The world format's validator (S2.01) on good and broken worlds, built here byte by byte.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_PARTS, imageSize, parseManifest, poseOf, readGltf, validateWorld } from '../src/index.ts';

const enc = new TextEncoder();

/** A GLB from a glTF JSON object and an optional binary chunk. */
function glb(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = enc.encode(JSON.stringify(json));
  const jsonLen = Math.ceil(text.length / 4) * 4;
  const binLen = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLen, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (bin) {
    v.setUint32(20 + jsonLen, binLen, true);
    v.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(bin, 28 + jsonLen);
  }
  return out;
}

/** A PNG header claiming a size (enough for imageSize). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

const TOML = `format = 1
name = "Test Plaza"
[capacity]
recommended = 20
maximum = 30
[[scenes]]
id = "main"
file = "scenes/main.glb"
`;

const PORTAL_TO = '0b9a8f3c-1d2e-4f50-8a6b-7c8d9e0f1a2b';
const yaw90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // a quarter turn left around y

function sceneJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: '2.0', generator: 'test' },
    extensionsUsed: ['OMI_spawn_point', 'OMI_seat', 'OMI_physics_shape', 'OMI_physics_body', 'FLATCHAT_world'],
    scene: 0,
    scenes: [{ nodes: [0, 5] }],
    nodes: [
      { name: 'markers', translation: [10, 0, 20], children: [1, 2, 3, 4] },
      { name: 'spawn', translation: [1, 0, 2], rotation: yaw90, extensions: { OMI_spawn_point: { title: 'Front', group: 'start' } } },
      { name: 'bench', translation: [0, 0.45, 0], extensions: { OMI_seat: { back: [0, 0, 0.3], foot: [0, -0.45, -0.4], knee: [0, 0, -0.2], angle: 1.6 } } },
      { name: 'portal', translation: [0, 1.5, -10], extensions: { FLATCHAT_world: { portal: { world: PORTAL_TO, size: [2, 3, 0.5] } } } },
      { name: 'stage', translation: [0, 0, -20], extensions: { FLATCHAT_world: { zone: { kind: 'voice', size: [10, 4, 6], range: 60, gain: 1.5 } } } },
      { name: 'floor', mesh: 0, extensions: { OMI_physics_body: { motion: { type: 'static' }, collider: { shape: 0 } } } },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { count: 4, componentType: 5126, type: 'VEC3' },
      { count: 6, componentType: 5123, type: 'SCALAR' },
    ],
    extensions: { OMI_physics_shape: { shapes: [{ type: 'box', box: { size: [40, 0.2, 40] } }] } },
    ...over,
  };
}

function world(scene: Uint8Array = glb(sceneJson()), toml = TOML, extra: Record<string, Uint8Array> = {}): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([['world.toml', enc.encode(toml)], ['scenes/main.glb', scene], ...Object.entries(extra)]);
}

const codes = (r: { problems: Array<{ code: string; severity: string }> }): string[] => r.problems.filter((p) => p.severity === 'error').map((p) => p.code);

describe('a good world', () => {
  it('validates, with its manifest and every marker at its world transform', () => {
    const r = validateWorld(world());
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest).toMatchObject({ name: 'Test Plaza', capacity: { recommended: 20, maximum: 30 }, persistence: 'reset', flying: false, voice: { range: 25 } });
    const s = r.scenes[0]!;
    expect(s.spawns).toHaveLength(1);
    expect(s.spawns[0]!.position).toEqual([11, 0, 22]);
    expect(s.spawns[0]!.yaw).toBeCloseTo(Math.PI / 2);
    expect(s.spawns[0]).toMatchObject({ title: 'Front', group: 'start' });
    expect(s.seats).toHaveLength(1);
    expect(s.portals[0]).toMatchObject({ world: PORTAL_TO, size: [2, 3, 0.5] });
    expect(s.zones[0]).toMatchObject({ kind: 'voice', range: 60, gain: 1.5, size: [10, 4, 6] });
    expect(s.bodies[0]).toMatchObject({ motion: 'static', collider: 0 });
    expect(s.shapes[0]).toEqual({ type: 'box', size: [40, 0.2, 40] });
    expect(s.triangles).toBe(2);
  });

  it('turns a node into a pose: yaw 0 faces -z', () => {
    expect(poseOf([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1])).toEqual({ position: [3, 4, 5], yaw: 0 });
  });

  it('accepts a .gltf with its buffer and images beside it, and reads image sizes', () => {
    const json = sceneJson({ buffers: [{ uri: 'main.bin', byteLength: 8 }], images: [{ uri: 'tex/a%20b.png' }] });
    const toml = TOML.replace('scenes/main.glb', 'scenes/main.gltf');
    const files = new Map<string, Uint8Array>([
      ['world.toml', enc.encode(toml)],
      ['scenes/main.gltf', enc.encode(JSON.stringify(json))],
      ['scenes/main.bin', new Uint8Array(8)],
      ['scenes/tex/a b.png', png(2048, 1024)],
    ]);
    expect(validateWorld(files).ok).toBe(true);
    files.set('scenes/tex/a b.png', png(8192, 8192));
    expect(codes(validateWorld(files))).toEqual(['texture-too-large']);
    files.delete('scenes/main.bin');
    expect(codes(validateWorld(files))).toContain('file-missing');
  });
});

describe('world.toml', () => {
  it('refuses broken manifests field by field', () => {
    expect(codes(parseManifest('format = 1\nname = '))).toEqual(['toml-syntax']);
    expect(codes(parseManifest(TOML.replace('format = 1', 'format = 2')))).toEqual(['format-unsupported']);
    expect(codes(parseManifest(TOML.replace('Test Plaza', 'ab')))).toEqual(['field']);
    expect(codes(parseManifest(TOML.replace('recommended = 20', 'recommended = 40')))).toEqual(['field']);
    expect(codes(parseManifest(TOML.replace('scenes/main.glb', '../main.glb')))).toEqual(['path-unsafe']);
    expect(codes(parseManifest(TOML.replace('scenes/main.glb', 'https://x.org/main.glb')))).toEqual(['path-unsafe']);
    expect(codes(parseManifest(TOML.replace('scenes/main.glb', 'scenes/main.fbx')))).toEqual(['field']);
    expect(codes(parseManifest('format = 1\nname = "No Scenes"\n'))).toEqual(['scene-missing']);
    expect(codes(parseManifest(`${TOML}[persistence]\nmode = "forever"\n`))).toEqual(['field']);
    expect(codes(parseManifest(`${TOML}[avatars]\nmin_height = 3\nmax_height = 2\n`))).toEqual(['field']);
    expect(codes(parseManifest(TOML.replace('Test Plaza', 'Test‮Plaza')))).toEqual(['field']);
  });

  it('warns about keys it does not know, and uses the defaults', () => {
    // A key after [[scenes]] belongs to that scene (TOML), so the stray one goes first.
    const r = parseManifest(`shiny = true\n${TOML}[movement]\nflying = true\nwings = 2\n`);
    expect(r.manifest?.flying).toBe(true);
    expect(r.problems.map((p) => [p.code, p.severity, p.at])).toEqual([
      ['field-unknown', 'warning', 'shiny'],
      ['field-unknown', 'warning', 'movement.wings'],
    ]);
  });
});

describe('broken scenes', () => {
  it('are refused with a reason each', () => {
    expect(codes(validateWorld(new Map([['scenes/main.glb', glb(sceneJson())]])))).toEqual(['manifest-missing']);
    expect(codes(validateWorld(world(enc.encode('not a glb'))))).toEqual(['gltf-syntax']);
    expect(codes(validateWorld(world(glb(sceneJson({ asset: { version: '1.0' } })))))).toEqual(['gltf-version']);
    expect(codes(validateWorld(world(glb(sceneJson({ extensionsRequired: ['VENDOR_magic'] })))))).toEqual(['extension-unsupported']);
    expect(codes(validateWorld(world(glb(sceneJson({ buffers: [{ uri: 'http://evil.example/x.bin' }] })))))).toEqual(['uri-external']);
    expect(codes(validateWorld(world(glb(sceneJson({ buffers: [{ uri: '../../etc/passwd' }] })))))).toEqual(['uri-external']);
    const noSpawn = sceneJson();
    (noSpawn['nodes'] as Array<Record<string, unknown>>)[1]!['extensions'] = {};
    expect(codes(validateWorld(world(glb(noSpawn))))).toEqual(['no-spawn']);
    const badChild = sceneJson();
    (badChild['nodes'] as Array<Record<string, unknown>>)[0]!['children'] = [1, 2, 3, 4, 99];
    expect(codes(validateWorld(world(glb(badChild))))).toEqual(['index-out-of-range']);
    expect(codes(validateWorld(world(glb(sceneJson({ accessors: [{ count: 4 }, { count: 9_000_000 }] })))))).toEqual(['too-many-triangles']);
  });

  it('refuses markers that make no sense', () => {
    const j = sceneJson();
    const nodes = j['nodes'] as Array<Record<string, unknown>>;
    nodes[3]!['extensions'] = { FLATCHAT_world: { portal: { world: 'somewhere', size: [2, 3, 0.5] } } };
    nodes[4]!['extensions'] = { FLATCHAT_world: { zone: { kind: 'disco', size: [1, 1, 1] } } };
    nodes[5]!['extensions'] = { OMI_physics_body: { collider: { shape: 7 } } };
    nodes[2]!['extensions'] = { OMI_seat: { back: [0, 0] } };
    expect(codes(validateWorld(world(glb(j))))).toEqual(['marker-invalid', 'marker-invalid', 'marker-invalid', 'index-out-of-range']);
  });

  it('reads a reverb zone, its room and its mix, and refuses a room it does not know (S6.06)', () => {
    const at = (zone: Record<string, unknown>): ReturnType<typeof validateWorld> => {
      const j = sceneJson();
      (j['nodes'] as Array<Record<string, unknown>>)[4]!['extensions'] = { FLATCHAT_world: { zone } };
      return validateWorld(world(glb(j)));
    };
    expect(at({ kind: 'reverb', size: [12, 6, 12], room: 'hall', mix: 0.5 }).scenes[0]!.zones[0]).toMatchObject({ kind: 'reverb', room: 'hall', mix: 0.5 });
    expect(at({ kind: 'reverb', size: [4, 3, 4] }).scenes[0]!.zones[0]).toMatchObject({ room: 'room', mix: 0.35 });
    expect(codes(at({ kind: 'reverb', size: [4, 3, 4], room: 'bathroom' }))).toEqual(['marker-invalid']);
    expect(codes(at({ kind: 'reverb', size: [4, 3, 4], mix: 1.5 }))).toEqual(['marker-invalid']);
  });

  it('finds the images inside a GLB', () => {
    const bin = png(4096, 4096);
    const j = sceneJson({ bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] });
    const r = validateWorld(world(glb(j, bin)));
    expect(r.ok).toBe(true);
    expect(r.problems.map((p) => p.code)).toContain('texture-large');
    expect(readGltf(glb(j, bin), 'x.glb').binLength).toBe(36);
  });
});

describe('image sizes', () => {
  it('come from PNG, JPEG and WebP headers', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    const webp = new Uint8Array(30);
    webp.set(enc.encode('RIFF'), 0);
    webp.set(enc.encode('WEBPVP8X'), 8);
    webp.set([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00], 24);
    expect(imageSize(webp)).toEqual({ width: 640, height: 480 });
    expect(imageSize(enc.encode('GIF89a'))).toBeUndefined();
  });
});

describe('base library parts (S2.05)', () => {
  it('reads a part a node places, and refuses an id the library does not have', () => {
    const json = sceneJson();
    const nodes = json['nodes'] as Array<Record<string, unknown>>;
    nodes.push({ name: 'bench', translation: [5, 0, 5], extensions: { FLATCHAT_world: { part: { id: 'flatchat:bench' } } } });
    (json['scenes'] as Array<{ nodes: number[] }>)[0]!.nodes.push(nodes.length - 1);
    const good = validateWorld(world(glb(json)));
    expect(codes(good)).toEqual([]);
    expect(good.scenes[0]!.parts.map((p) => p.id)).toEqual(['flatchat:bench']);
    nodes.at(-1)!['extensions'] = { FLATCHAT_world: { part: { id: 'acme:spaceship' } } };
    const bad = validateWorld(world(glb(json)));
    expect(codes(bad)).toContain('marker-invalid');
    expect(BASE_PARTS['flatchat:bench']!.seats).toHaveLength(2);
    for (const def of Object.values(BASE_PARTS)) for (const b of def.boxes) for (const k of [0, 1, 2]) expect(b.max[k]!).toBeGreaterThan(b.min[k]!);
  });
});

describe('effects in a world (S6.01)', () => {
  const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'kits', 'effects', 'samples', '00_Basic');
  const laser = new Uint8Array(readFileSync(join(SAMPLES, 'Laser01.efkefc')));
  const textures = Object.fromEntries(['LaserMain01.png', 'Particle01.png', 'Particle02.png'].map((n) => [`scenes/fx/Texture/${n}`, new Uint8Array(readFileSync(join(SAMPLES, 'Texture', n)))]));
  const withEffect = (effect: Record<string, unknown>): Uint8Array => {
    const json = sceneJson();
    const nodes = json['nodes'] as Array<Record<string, unknown>>;
    nodes.push({ name: 'laser', translation: [3, 1, 3], extensions: { FLATCHAT_world: { effect } } });
    (json['scenes'] as Array<{ nodes: number[] }>)[0]!.nodes.push(nodes.length - 1);
    return glb(json);
  };

  it('reads an effect a node places, with its scale, the file beside the scene and every file it names', () => {
    const r = validateWorld(world(withEffect({ uri: 'fx/Laser01.efkefc', scale: 0.2 }), TOML, { 'scenes/fx/Laser01.efkefc': laser, ...textures }));
    expect(codes(r)).toEqual([]);
    expect(r.scenes[0]!.effects).toEqual([expect.objectContaining({ path: 'scenes/fx/Laser01.efkefc', scale: 0.2 })]);
    expect(r.scenes[0]!.effects[0]!.matrix.slice(12, 15)).toEqual([3, 1, 3]);
  });

  it('refuses a missing effect, a missing texture, a newer editor’s file, and a bad marker', () => {
    expect(codes(validateWorld(world(withEffect({ uri: 'fx/Laser01.efkefc' }))))).toContain('file-missing');
    const fewer = Object.fromEntries(Object.entries(textures).filter(([path]) => path !== 'scenes/fx/Texture/Particle02.png'));
    expect(codes(validateWorld(world(withEffect({ uri: 'fx/Laser01.efkefc' }), TOML, { 'scenes/fx/Laser01.efkefc': laser, ...fewer })))).toEqual(['effect-file-missing']);
    const newer = laser.slice();
    new DataView(newer.buffer).setInt32(new TextDecoder('latin1').decode(newer).indexOf('SKFE') + 4, 1900, true);
    expect(codes(validateWorld(world(withEffect({ uri: 'fx/Laser01.efkefc' }), TOML, { 'scenes/fx/Laser01.efkefc': newer, ...textures })))).toEqual(['effect-too-new']);
    expect(codes(validateWorld(world(withEffect({ uri: '../outside.efkefc' }))))).toContain('marker-invalid');
    expect(codes(validateWorld(world(withEffect({ uri: 'fx/Laser01.efkefc', scale: 500 }), TOML, { 'scenes/fx/Laser01.efkefc': laser, ...textures })))).toContain('marker-invalid');
  });
});
