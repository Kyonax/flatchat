// SPDX-License-Identifier: Apache-2.0
// Fingerprints of an avatar or an item (S5.09, Q-J4, cl-005, T-03). An exact file hash misses a
// re-exported copy, so the converter also measures each upload's shape and textures, and the core
// compares them with what was taken down and with others' gallery entries. A shape is a MinHash of
// its triangles: each triangle a token of its three edge lengths, sorted, and its centre's distance
// from the model's centre, all against the model's own size (the square root of its area). The same
// model written again, in another vertex or triangle order, moved, turned, mirrored or scaled, keeps
// nearly every token. A texture's is a 64-bit perceptual hash (the low frequencies of a 32 px grey
// copy), which a re-encoding or a resize keeps within a few bits. They stay on the server.

/** MinHash slots in a shape. */
export const SHAPE_SLOTS = 64;
/** A shape needs this many different triangle tokens to say anything: a cube is any cube. */
export const SHAPE_MIN_TOKENS = 96;
/** Two shapes are one model when this share of their slots agree (their tokens' Jaccard index). */
export const SHAPE_MATCH = 0.75;
/** Two textures are one image when their hashes differ in this many bits at most. */
export const TEXTURE_MATCH_BITS = 6;
/** The textures kept, largest first. */
export const TEXTURE_MAX = 8;

export interface Fingerprint {
  /** One MinHash per part (an avatar is one part; an item, each fit or its prop): SHAPE_SLOTS unsigned 32-bit minima. */
  shapes: number[][];
  /** Each texture's perceptual hash, 16 hex digits; flat colours left out. */
  textures: string[];
}

export class FingerprintError extends Error {}

/** Reads a fingerprint (from the converter's result, or the database). */
export function checkFingerprint(value: unknown): Fingerprint {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const shapes = v['shapes'];
  const textures = v['textures'];
  if (!Array.isArray(shapes) || shapes.length > 16 || !shapes.every((s) => Array.isArray(s) && s.length === SHAPE_SLOTS && s.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff))) throw new FingerprintError('not a fingerprint: its shapes');
  if (!Array.isArray(textures) || textures.length > TEXTURE_MAX || !textures.every((t) => typeof t === 'string' && /^[0-9a-f]{16}$/.test(t))) throw new FingerprintError('not a fingerprint: its textures');
  return { shapes: shapes as number[][], textures: textures as string[] };
}

/** The share of slots two shapes agree in: an estimate of their tokens' Jaccard index. */
export function shapeSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== SHAPE_SLOTS || b.length !== SHAPE_SLOTS) return 0;
  let same = 0;
  for (let i = 0; i < SHAPE_SLOTS; i++) if (a[i] === b[i]) same += 1;
  return same / SHAPE_SLOTS;
}

const bits32 = (x: number): number => {
  let n = x >>> 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
};

/** How many bits two texture hashes differ in. */
export function textureDistance(a: string, b: string): number {
  return bits32(parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) + bits32(parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16));
}

/** Where one fingerprint shows a copy of another: a part's shape, a texture, or neither. */
export function matchOf(a: Fingerprint, b: Fingerprint): { by: 'shape' | 'texture'; score: number } | undefined {
  let best = 0;
  for (const x of a.shapes) for (const y of b.shapes) best = Math.max(best, shapeSimilarity(x, y));
  if (best >= SHAPE_MATCH) return { by: 'shape', score: best };
  for (const x of a.textures) for (const y of b.textures) if (textureDistance(x, y) <= TEXTURE_MATCH_BITS) return { by: 'texture', score: 1 - textureDistance(x, y) / 64 };
  return undefined;
}
