// SPDX-License-Identifier: MPL-2.0
// An upload's fingerprint (S5.09; packages/content's fingerprint.ts says what it is and how two are
// compared): each part's shape as a MinHash of its triangles' tokens, and each texture's
// perceptual hash. Measured on the GLB the converter reads (an upload, or the GLB made of an FBX,
// OBJ, DAE or .blend), before anything is simplified or re-encoded, so a copy re-exported from
// what clients download measures the same.
import { type Fingerprint, SHAPE_MIN_TOKENS, SHAPE_SLOTS, TEXTURE_MAX } from '@flatchat/content';
import type { Document, mat4, Node } from '@gltf-transform/core';
import { decodeImage, type Rgba } from './textures.ts';

/** Bins per unit of the model's size: coarse enough that float noise and 16-bit positions keep
 *  nearly every token, fine enough that another model's tokens differ. */
const BINS = 1024;

/** The 32-bit finaliser of MurmurHash3. */
function mix(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** One seed per MinHash slot, the same on every machine. */
const SEEDS = Array.from({ length: SHAPE_SLOTS }, (_, i) => mix(0x9e3779b9 + Math.imul(i + 1, 0x7f4a7c15)));

const apply = (m: mat4 | undefined, x: number, y: number, z: number): [number, number, number] =>
  m ? [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z];

/** A part's triangles, in the space it is drawn in: a skinned mesh's bind space, else the world. */
function triangles(nodes: readonly Node[]): Float64Array {
  const out: number[] = [];
  const p: number[] = [];
  for (const node of nodes) {
    const world = node.getSkin() ? undefined : node.getWorldMatrix();
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      for (let i = 0; i + 2 < count; i += 3) {
        for (let k = 0; k < 3; k++) {
          pos.getElement(idx ? idx.getScalar(i + k) : i + k, p);
          out.push(...apply(world, p[0]!, p[1]!, p[2]!));
        }
      }
    }
  }
  return Float64Array.from(out);
}

/** A part's shape: undefined when it has too few different triangles to tell it from another. */
export function shapeOf(nodes: readonly Node[]): number[] | undefined {
  const t = triangles(nodes);
  const n = t.length / 9;
  const area = new Float64Array(n);
  let total = 0;
  const centre = [0, 0, 0];
  const at = (i: number, k: number, c: number): number => t[i * 9 + k * 3 + c]!;
  for (let i = 0; i < n; i++) {
    const u = [0, 1, 2].map((c) => at(i, 1, c) - at(i, 0, c));
    const v = [0, 1, 2].map((c) => at(i, 2, c) - at(i, 0, c));
    const a = 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    area[i] = a;
    total += a;
    for (let c = 0; c < 3; c++) centre[c]! += (a * (at(i, 0, c) + at(i, 1, c) + at(i, 2, c))) / 3;
  }
  if (!(total > 0)) return undefined;
  for (let c = 0; c < 3; c++) centre[c]! /= total;
  const size = Math.sqrt(total);
  const q = (x: number): number => Math.min(0xffff, Math.round((x / size) * BINS));
  const tokens = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (area[i]! <= total * 1e-12) continue;
    const e = [0, 1, 2]
      .map((k) => Math.hypot(at(i, (k + 1) % 3, 0) - at(i, k, 0), at(i, (k + 1) % 3, 1) - at(i, k, 1), at(i, (k + 1) % 3, 2) - at(i, k, 2)))
      .sort((a, b) => a - b);
    const r = Math.hypot(...[0, 1, 2].map((c) => (at(i, 0, c) + at(i, 1, c) + at(i, 2, c)) / 3 - centre[c]!));
    tokens.add(mix(Math.imul(q(e[0]!) | (q(e[1]!) << 16), 0x2545f491) ^ mix(q(e[2]!) | (q(r) << 16))));
  }
  if (tokens.size < SHAPE_MIN_TOKENS) return undefined;
  const slots = new Array<number>(SHAPE_SLOTS).fill(0xffffffff);
  for (const token of tokens) {
    for (let s = 0; s < SHAPE_SLOTS; s++) {
      const h = mix(token ^ SEEDS[s]!);
      if (h < slots[s]!) slots[s] = h;
    }
  }
  return slots;
}

/** A 64-bit perceptual hash of an image, or undefined when it is one flat colour. */
export function imageHash(img: Rgba): string | undefined {
  const N = 32;
  const grey = new Float64Array(N * N);
  // Each cell the mean of the pixels it covers.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor((x * img.width) / N);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / N));
      const y0 = Math.floor((y * img.height) / N);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / N));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          sum += 0.299 * img.data[o]! + 0.587 * img.data[o + 1]! + 0.114 * img.data[o + 2]!;
        }
      }
      grey[y * N + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  const mean = grey.reduce((a, b) => a + b, 0) / grey.length;
  if (grey.reduce((a, b) => a + (b - mean) ** 2, 0) / grey.length < 4) return undefined;
  // The 8 × 8 lowest frequencies of its DCT; each bit says whether one is over their median.
  const cos = (k: number, i: number): number => Math.cos(((2 * i + 1) * k * Math.PI) / (2 * N));
  const low: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += grey[y * N + x]! * cos(u, x) * cos(v, y);
      low.push(s);
    }
  }
  const ac = low.slice(1).sort((a, b) => a - b);
  const median = (ac[31]! + ac[32]!) / 2;
  let hi = 0;
  let lo = 0;
  for (let k = 0; k < 64; k++) {
    if (k === 0 || !(low[k]! > median)) continue;
    if (k < 32) hi |= 1 << (31 - k);
    else lo |= 1 << (63 - k);
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** The fingerprint of a document: its parts (each a list of mesh nodes) and its textures. */
export function fingerprintOf(doc: Document, parts: ReadonlyArray<readonly Node[]>): Fingerprint {
  const shapes = parts.map(shapeOf).filter((s): s is number[] => s !== undefined);
  const textures: string[] = [];
  const images = doc
    .getRoot()
    .listTextures()
    .map((t) => ({ t, img: decodeImage(t.getImage() ?? new Uint8Array(0), t.getMimeType()) }))
    .filter((x): x is { t: (typeof x)['t']; img: Rgba } => x.img !== undefined)
    .sort((a, b) => b.img.width * b.img.height - a.img.width * a.img.height);
  for (const { img } of images) {
    const h = imageHash(img);
    if (h && !textures.includes(h)) textures.push(h);
    if (textures.length === TEXTURE_MAX) break;
  }
  return { shapes, textures };
}
