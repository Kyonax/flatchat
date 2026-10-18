// SPDX-License-Identifier: Apache-2.0
// The built world's files, read from strangers' servers: world.json and the collision file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Collider, CollisionError, decodeColliders, encodeColliders, insideBox, parseBuiltWorld } from '../src/index.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'converter', 'test', 'golden', 'plaza.world.json');
const plaza = (): Record<string, unknown> => JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;

describe('world.json', () => {
  it('reads the converter’s plaza', () => {
    const r = parseBuiltWorld(plaza());
    expect('world' in r && r.world.manifest.name).toBe('The Plaza');
  });

  it('refuses anything out of shape, naming where', () => {
    const cases: Array<[(w: Record<string, unknown>) => void, RegExp]> = [
      [(w) => (w['format'] = 2), /^format/],
      [(w) => (w['collision'] = 'ab'), /^collision/],
      [(w) => (w['collision'] = 'f'.repeat(64)), /a file the list does not have/],
      [(w) => ((w['scenes'] as Array<Record<string, unknown>>)[0]!['spawns'] = []), /spawn point/],
      [(w) => (((w['scenes'] as Array<Record<string, unknown>>)[0]!['spawns'] as Array<Record<string, unknown>>)[0]!['position'] = [0, Number.NaN, 0]), /position/],
      [(w) => (((w['scenes'] as Array<Record<string, unknown>>)[0]!['spawns'] as Array<Record<string, unknown>>)[0]!['title'] = 'x‮y'), /title/],
      [(w) => ((w['manifest'] as Record<string, unknown>)['name'] = 'x'.repeat(49)), /manifest.name/],
      [(w) => ((w['files'] as Array<Record<string, unknown>>)[0]!['kind'] = 'script'), /kind/],
      [(w) => ((w['scenes'] as Array<Record<string, unknown>>)[0]!['zones'] = [{ center: [0, 0, 0], half: [1, 1, 1], yaw: 0, kind: 'disco' }]), /kind/],
      [(w) => ((w['scenes'] as Array<Record<string, unknown>>)[0]!['zones'] = [{ center: [0, 0, 0], half: [1, 1, 1], yaw: 0, kind: 'reverb', room: 'disco', mix: 0.3 }]), /room/],
      [(w) => ((w['scenes'] as Array<Record<string, unknown>>)[0]!['zones'] = [{ center: [0, 0, 0], half: [1, 1, 1], yaw: 0, kind: 'reverb', room: 'hall', mix: 3 }]), /mix/],
    ];
    for (const [change, why] of cases) {
      const w = plaza();
      change(w);
      const r = parseBuiltWorld(w);
      expect('error' in r ? r.error : 'accepted').toMatch(why);
    }
    expect(parseBuiltWorld('not even an object')).toEqual({ error: 'world.json: an object' });
    // A reverb zone (S6.06) is kept with its room and mix.
    const w = plaza();
    (w['scenes'] as Array<Record<string, unknown>>)[0]!['zones'] = [{ center: [0, 1, 0], half: [6, 3, 6], yaw: 0, kind: 'reverb', room: 'cave', mix: 0.6 }];
    const r = parseBuiltWorld(w);
    expect('world' in r && r.world.scenes[0]!.zones[0]).toMatchObject({ kind: 'reverb', room: 'cave', mix: 0.6 });
  });

  it('reads base library parts, and refuses one the library does not have (S2.05)', () => {
    const w = plaza();
    const scene = (w['scenes'] as Array<Record<string, unknown>>)[0]!;
    scene['parts'] = [{ id: 'flatchat:tree', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }];
    const r = parseBuiltWorld(w);
    expect('world' in r && r.world.scenes[0]!.parts).toEqual([{ id: 'flatchat:tree', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]);
    scene['parts'] = [{ id: 'acme:spaceship', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }];
    const bad = parseBuiltWorld(w);
    expect('error' in bad ? bad.error : 'accepted').toMatch(/base library/);
    delete scene['parts'];
    const older = parseBuiltWorld(w);
    expect('world' in older && older.world.scenes[0]!.parts).toEqual([]);
  });

  it('places a point in a box turned about y', () => {
    const b = { center: [10, 1, 10] as [number, number, number], half: [2, 1, 0.5] as [number, number, number], yaw: Math.PI / 2 };
    expect(insideBox(b, { x: 10.4, y: 1, z: 11.5 })).toBe(true);
    expect(insideBox(b, { x: 11.5, y: 1, z: 10 })).toBe(false);
    expect(insideBox(b, { x: 10, y: 3, z: 10 })).toBe(false);
  });
});

describe('the collision file', () => {
  const list: Collider[] = [
    { type: 'box', position: [1, 2, 3], rotation: [0, 0, 0, 1], half: [1, 0.5, 2] },
    { type: 'sphere', position: [0, 1, 0], rotation: [0, 0, 0, 1], radius: 0.5 },
    { type: 'capsule', position: [0, 1, 0], rotation: [0, 0, 0, 1], radius: 0.25, halfHeight: 0.75 },
    { type: 'trimesh', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) },
  ];

  it('round-trips every shape', () => {
    expect(decodeColliders(encodeColliders(list))).toEqual(list);
  });

  it('refuses a damaged or hostile file', () => {
    const bytes = encodeColliders(list);
    expect(() => decodeColliders(bytes.subarray(0, bytes.length - 3))).toThrow(CollisionError);
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    expect(() => decodeColliders(extra)).toThrow(/extra bytes/);
    const badIndex = encodeColliders([{ type: 'trimesh', positions: new Float32Array(9), indices: new Uint32Array([0, 1, 7]) }]);
    expect(() => decodeColliders(badIndex)).toThrow(/vertex that does not exist/);
    const huge = new Uint8Array(12);
    new DataView(huge.buffer).setUint32(0, 0x4c434346, true);
    new DataView(huge.buffer).setUint32(4, 1, true);
    new DataView(huge.buffer).setUint32(8, 1e9, true);
    expect(() => decodeColliders(huge)).toThrow(/too many/);
    const nan = encodeColliders([{ type: 'sphere', position: [0, 0, 0], rotation: [0, 0, 0, 1], radius: 1 }]);
    new DataView(nan.buffer).setFloat32(16, Number.NaN, true);
    expect(() => decodeColliders(nan)).toThrow(/out of range/);
  });
});
