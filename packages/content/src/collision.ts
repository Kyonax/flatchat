// SPDX-License-Identifier: Apache-2.0
// A built world's collision file (S2.03, S2.06): every solid in world space, for the physics on
// both ends (Rapier: players collide in the client, the server checks with the same shapes).
// Little-endian binary: "FCCL", version 1, a count, then each collider: a type byte, three padding
// bytes, and its numbers. Read from strangers' servers, so the decoder checks every length.

export type Quat = [number, number, number, number];
export type P3 = [number, number, number];

export type Collider =
  | { type: 'box'; position: P3; rotation: Quat; half: P3 }
  | { type: 'sphere'; position: P3; rotation: Quat; radius: number }
  | { type: 'capsule'; position: P3; rotation: Quat; radius: number; halfHeight: number }
  | { type: 'cylinder'; position: P3; rotation: Quat; radius: number; halfHeight: number }
  | { type: 'trimesh'; positions: Float32Array; indices: Uint32Array };

const MAGIC = 0x4c434346; // "FCCL"
const VERSION = 1;
const TYPES = ['box', 'sphere', 'capsule', 'cylinder', 'trimesh'] as const;
export const COLLISION_LIMITS = { colliders: 100_000, vertices: 4_000_000, triangles: 4_000_000 };

export function encodeColliders(list: readonly Collider[]): Uint8Array {
  let size = 12;
  for (const c of list) size += 4 + (c.type === 'trimesh' ? 8 + c.positions.length * 4 + c.indices.length * 4 : 28 + (c.type === 'box' ? 12 : c.type === 'sphere' ? 4 : 8));
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0;
  const u32 = (n: number): void => {
    v.setUint32(o, n, true);
    o += 4;
  };
  const f32 = (n: number): void => {
    v.setFloat32(o, n, true);
    o += 4;
  };
  u32(MAGIC);
  u32(VERSION);
  u32(list.length);
  for (const c of list) {
    out[o] = TYPES.indexOf(c.type);
    o += 4;
    if (c.type === 'trimesh') {
      u32(c.positions.length / 3);
      u32(c.indices.length);
      for (const p of c.positions) f32(p);
      for (const i of c.indices) u32(i);
      continue;
    }
    for (const n of c.position) f32(n);
    for (const n of c.rotation) f32(n);
    if (c.type === 'box') for (const n of c.half) f32(n);
    else if (c.type === 'sphere') f32(c.radius);
    else {
      f32(c.radius);
      f32(c.halfHeight);
    }
  }
  return out;
}

export class CollisionError extends Error {}

export function decodeColliders(bytes: Uint8Array): Collider[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.length) throw new CollisionError('the collision file ends early');
  };
  const u32 = (): number => {
    need(4);
    const n = v.getUint32(o, true);
    o += 4;
    return n;
  };
  const f32 = (min = -1e6, max = 1e6): number => {
    need(4);
    const n = v.getFloat32(o, true);
    o += 4;
    if (!Number.isFinite(n) || n < min || n > max) throw new CollisionError('a number out of range');
    return n;
  };
  if (u32() !== MAGIC || u32() !== VERSION) throw new CollisionError('not a FlatChat collision file, version 1');
  const count = u32();
  if (count > COLLISION_LIMITS.colliders) throw new CollisionError('too many colliders');
  const out: Collider[] = [];
  let vertices = 0;
  let triangles = 0;
  for (let k = 0; k < count; k++) {
    need(4);
    const type = TYPES[bytes[o]!];
    o += 4;
    if (!type) throw new CollisionError('an unknown collider type');
    if (type === 'trimesh') {
      const vc = u32();
      const ic = u32();
      vertices += vc;
      triangles += ic / 3;
      if (ic % 3 !== 0 || vertices > COLLISION_LIMITS.vertices || triangles > COLLISION_LIMITS.triangles) throw new CollisionError('a mesh too large or not made of triangles');
      need(vc * 12 + ic * 4);
      const positions = new Float32Array(vc * 3);
      for (let i = 0; i < positions.length; i++) positions[i] = f32();
      const indices = new Uint32Array(ic);
      for (let i = 0; i < ic; i++) {
        const n = u32();
        if (n >= vc) throw new CollisionError('a triangle names a vertex that does not exist');
        indices[i] = n;
      }
      out.push({ type, positions, indices });
      continue;
    }
    const position: P3 = [f32(), f32(), f32()];
    const rotation: Quat = [f32(-1.01, 1.01), f32(-1.01, 1.01), f32(-1.01, 1.01), f32(-1.01, 1.01)];
    if (type === 'box') out.push({ type, position, rotation, half: [f32(0, 1e4), f32(0, 1e4), f32(0, 1e4)] });
    else if (type === 'sphere') out.push({ type, position, rotation, radius: f32(0, 1e4) });
    else out.push({ type, position, rotation, radius: f32(0, 1e4), halfHeight: f32(0, 1e4) });
  }
  if (o !== bytes.length) throw new CollisionError('extra bytes after the last collider');
  return out;
}
