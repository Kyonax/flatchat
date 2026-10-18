// SPDX-License-Identifier: MPL-2.0
// The starter wardrobe (Track P's P.08): MakeHuman's CC0 garments, fitted to the three bodies by
// MPFB in Blender (tools/blender/wardrobe/fit.py) and made into items here. Each fit's skin weights
// come from the skin under it: a garment vertex near the body moves exactly as the point of the
// body's surface straight under it does (along the cloth's normal; the nearest point where nothing
// is under it), so the cloth and the skin bend together at the knees, shoulders and hips, and a
// loose cuff moves with the wrist it covers, not with the thumb that sticks out nearest it (MPFB
// weights clothes from its helper geometry, which bends otherwise). Far from the body (a skirt's
// hem, a coat's tail) MPFB's own weights stay, and between the two they are blended.
// Then, where skin still comes out through it in the test poses, the cloth is pushed out from the
// body, a little past the skin, the push fading over its neighbours so no crease shows; round after
// round until nothing comes through. This is the plan's "clipping fixed by hand", done the same way
// on every garment and body, so no minutes by hand. Each garment hides the regions it covers on
// every body (wholly, or by MakeHuman's own delete group), is simplified under its slot's caps
// where it is over them, and keeps one base colour texture (MakeHuman's logo painted out of the
// tee: CC0 waives copyright, not trademark). scripts/make-wardrobe.ts runs it all.
import { type ItemClipping, PROPORTION_ENDS, PROPORTIONS_AS_MADE, type ProportionShares, type Region, type Slot, SLOTS } from '@flatchat/content';
import type { Document, Node } from '@gltf-transform/core';
import { simplifyPrimitive, weldPrimitive } from '@gltf-transform/functions';
import jpeg from 'jpeg-js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { PNG } from 'pngjs';
import { decodeImage, halve, type Rgba } from '../textures.ts';
import { clippingOf, fitOnKit, type KitBody, TriangleGrid } from './clipping.ts';

/** Within NEAR of the skin a garment vertex takes the skin's weights; beyond FAR it keeps its own. */
export const WEIGHTS_NEAR = 0.03;
export const WEIGHTS_FAR = 0.06;

/** The closest point of triangle abc to p, as barycentric weights (Ericson, Real-Time Collision
 *  Detection, 5.1.5). */
function closest(p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): [number, number, number] {
  const sub = (x: readonly number[], y: readonly number[]): number[] => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
  const dot = (x: readonly number[], y: readonly number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [1 - v, v, 0];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [1 - w, 0, w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [0, 1 - w, w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [1 - v - w, v, w];
}

/** Four joints and weights from a sum of weighted influences: the four largest, normalized. */
function topFour(influence: Map<number, number>): Array<[number, number]> {
  const top = [...influence].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
  const total = top.reduce((n, [, w]) => n + w, 0) || 1;
  return top.map(([j, w]) => [j, w / total]);
}

/** Gives a fit's vertices the skin's weights near the body (see the top of this file), in place.
 *  Both meshes are in the same bind space (fits are made on the kit, skeleton offset 0). Answers how
 *  many vertices took the skin's weights, wholly or in part. */
export function weightsFromSkin(kit: KitBody, fit: Node, near = WEIGHTS_NEAR, far = WEIGHTS_FAR): number {
  const body = kit.body;
  const tri = body.triangles;
  const cellSize = far;
  const cell = (v: number): number => Math.floor(v / cellSize);
  const grid = new Map<string, number[]>();
  for (let t = 0; t < tri.length / 3; t++) {
    const lo = [0, 1, 2].map((i) => cell(Math.min(body.positions[tri[t * 3]! * 3 + i]!, body.positions[tri[t * 3 + 1]! * 3 + i]!, body.positions[tri[t * 3 + 2]! * 3 + i]!)));
    const hi = [0, 1, 2].map((i) => cell(Math.max(body.positions[tri[t * 3]! * 3 + i]!, body.positions[tri[t * 3 + 1]! * 3 + i]!, body.positions[tri[t * 3 + 2]! * 3 + i]!)));
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
      const key = `${x},${y},${z}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(t);
    }
  }
  const at = (v: number): number[] => [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!];
  const rays = new TriangleGrid(body.positions, tri, far, () => false);
  const skin = fit.getSkin()!;
  // The kit's joints by the fit's: both are the kits' bones, named alike.
  const fitIndex = new Map(skin.listJoints().map((j, k) => [j.getName(), k]));
  const kitToFit = kit.joints.map((j) => fitIndex.get(j.getName()));
  let changed = 0;
  for (const prim of fit.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!;
    const nor = prim.getAttribute('NORMAL');
    const j0 = prim.getAttribute('JOINTS_0')!;
    const w0 = prim.getAttribute('WEIGHTS_0')!;
    const p: number[] = [];
    const normal: number[] = [];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      let best = Infinity;
      let found: { t: number; bary: [number, number, number] } | undefined;
      // The skin straight under it, facing it.
      if (nor) {
        nor.getElement(i, normal);
        const d = rays.hit(p[0]!, p[1]!, p[2]!, -normal[0]!, -normal[1]!, -normal[2]!, far, normal[0]!, normal[1]!, normal[2]!);
        if (d >= 0) {
          best = d;
          found = { t: rays.met, bary: [1 - rays.metU - rays.metV, rays.metU, rays.metV] };
        }
      }
      // Else the nearest point of it.
      if (!found) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const t of grid.get(`${cell(p[0]!) + dx},${cell(p[1]!) + dy},${cell(p[2]!) + dz}`) ?? []) {
            const [a, b, c] = [tri[t * 3]!, tri[t * 3 + 1]!, tri[t * 3 + 2]!];
            const bary = closest(p, at(a), at(b), at(c));
            const q = [0, 1, 2].map((k) => at(a)[k]! * bary[0] + at(b)[k]! * bary[1] + at(c)[k]! * bary[2]);
            const d = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!);
            if (d < best) {
              best = d;
              found = { t, bary };
            }
          }
        }
      }
      if (!found || best >= far) continue;
      const share = best <= near ? 1 : (far - best) / (far - near);
      const influence = new Map<number, number>();
      found.bary.forEach((bw, k) => {
        const v = tri[found!.t * 3 + k]!;
        for (let n = 0; n < 4; n++) {
          const w = body.weights[v * 4 + n]! * bw * share;
          const j = kitToFit[body.joints[v * 4 + n]!];
          if (w > 0 && j !== undefined) influence.set(j, (influence.get(j) ?? 0) + w);
        }
      });
      if (share < 1) {
        const own = j0.getElement(i, []);
        const ownW = w0.getElement(i, []);
        for (let n = 0; n < 4; n++) if (ownW[n]! > 0) influence.set(own[n]!, (influence.get(own[n]!) ?? 0) + ownW[n]! * (1 - share));
      }
      const top = topFour(influence);
      j0.setElement(i, [0, 1, 2, 3].map((n) => top[n]?.[0] ?? 0));
      w0.setElement(i, [0, 1, 2, 3].map((n) => top[n]?.[1] ?? 0));
      changed += 1;
    }
  }
  return changed;
}

/** How far past the skin a push leaves the cloth; how far round it the push fades out; how far any
 *  of the cloth may be pushed in all (a garment loosened, never ballooned); how many rounds of
 *  checking and pushing at most. */
export const PUSH_MARGIN = 0.002;
export const PUSH_SPREAD = 0.025;
export const PUSH_LIMIT = 0.012;
export const PUSH_ROUNDS = 12;

export interface PushResult {
  /** Rounds of pushing done. */
  rounds: number;
  /** The fit's vertices moved, and the farthest any moved in all, in millimetres. */
  moved: number;
  largestMm: number;
  /** The check after the last round. */
  clipping: ItemClipping;
}

/** Pushes a fit's cloth out wherever skin comes through it in the test poses (see the top of this
 *  file), in place, and answers what it did. The fit's vertices that share a place (split for its
 *  UVs) move together, along the cloth's normal at rest; a push fades over the neighbours that face
 *  the same way (not a fold's inner layer, which faces the body). */
export function pushOut(kit: KitBody, fit: Node, hides: readonly Region[], shapes: readonly ProportionShares[]): PushResult {
  const prims = fit.getMesh()!.listPrimitives();
  const moved = new Set<number>();
  const pushed = new Map<number, number>();
  let largest = 0;
  let rounds = 0;
  for (;;) {
    // The fit as one mesh, in fitOnKit's numbering (the check's), at rest in its bind space.
    const { mesh } = fitOnKit(kit, fit);
    const p = mesh.positions;
    const t = mesh.triangles;
    const n = p.length / 3;
    // Places: vertices at one position (to 0.01 mm) are one.
    const placeOf = new Int32Array(n);
    const places = new Map<string, number>();
    for (let v = 0; v < n; v++) {
      const key = `${Math.round(p[v * 3]! * 1e5)},${Math.round(p[v * 3 + 1]! * 1e5)},${Math.round(p[v * 3 + 2]! * 1e5)}`;
      let id = places.get(key);
      if (id === undefined) places.set(key, (id = places.size));
      placeOf[v] = id;
    }
    const count = places.size;
    // What each place must move: the depth the skin came through its triangle, and the margin.
    const need = new Float32Array(count);
    const clipping = clippingOf(kit, fit, hides, {
      shapes,
      detail: (_pose, _region, outMm, hit) => {
        for (let k = 0; k < 3; k++) {
          const q = placeOf[t[hit.triangle * 3 + k]!]!;
          need[q] = Math.max(need[q]!, outMm / 1000 + PUSH_MARGIN);
        }
      },
    });
    if (clipping.through === 0 || rounds === PUSH_ROUNDS) return { rounds, moved: moved.size, largestMm: Math.round(largest * 10000) / 10, clipping };
    rounds += 1;
    const at = new Float32Array(count * 3);
    for (let v = 0; v < n; v++) at.set([p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!], placeOf[v]! * 3);
    // Each place's normal, from the triangles round it.
    const normal = new Float32Array(count * 3);
    for (let i = 0; i + 2 < t.length; i += 3) {
      const [a, b, c] = [t[i]! * 3, t[i + 1]! * 3, t[i + 2]! * 3];
      const [ux, uy, uz] = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const [vx, vy, vz] = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const f = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const k of [t[i]!, t[i + 1]!, t[i + 2]!]) for (let d = 0; d < 3; d++) normal[placeOf[k]! * 3 + d]! += f[d]!;
    }
    for (let q = 0; q < count; q++) {
      const len = Math.hypot(normal[q * 3]!, normal[q * 3 + 1]!, normal[q * 3 + 2]!) || 1;
      for (let d = 0; d < 3; d++) normal[q * 3 + d]! /= len;
    }
    // The push fades out over the neighbours facing the same way.
    const cell = (x: number): number => Math.floor(x / PUSH_SPREAD);
    const grid = new Map<string, number[]>();
    for (let q = 0; q < count; q++) {
      const key = `${cell(at[q * 3]!)},${cell(at[q * 3 + 1]!)},${cell(at[q * 3 + 2]!)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(q);
    }
    const move = new Float32Array(count);
    for (let q = 0; q < count; q++) {
      if (need[q]! <= 0) continue;
      const [x, y, z] = [at[q * 3]!, at[q * 3 + 1]!, at[q * 3 + 2]!];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const r of grid.get(`${cell(x) + dx},${cell(y) + dy},${cell(z) + dz}`) ?? []) {
          if (normal[q * 3]! * normal[r * 3]! + normal[q * 3 + 1]! * normal[r * 3 + 1]! + normal[q * 3 + 2]! * normal[r * 3 + 2]! < 0.5) continue;
          const d = Math.hypot(at[r * 3]! - x, at[r * 3 + 1]! - y, at[r * 3 + 2]! - z);
          if (d < PUSH_SPREAD) move[r] = Math.max(move[r]!, need[q]! * (1 - d / PUSH_SPREAD));
        }
      }
    }
    // Moved in the fit's own primitives, in fitOnKit's order, never past the limit.
    let base = 0;
    let any = false;
    const el: number[] = [];
    for (const prim of prims) {
      const pos = prim.getAttribute('POSITION')!;
      for (let i = 0; i < pos.getCount(); i++) {
        const q = placeOf[base + i]!;
        const m = Math.min(move[q]!, PUSH_LIMIT - (pushed.get(base + i) ?? 0));
        if (m <= 1e-5) continue;
        any = true;
        pos.getElement(i, el);
        pos.setElement(i, [el[0]! + normal[q * 3]! * m, el[1]! + normal[q * 3 + 1]! * m, el[2]! + normal[q * 3 + 2]! * m]);
        moved.add(base + i);
        pushed.set(base + i, (pushed.get(base + i) ?? 0) + m);
        largest = Math.max(largest, pushed.get(base + i)!);
      }
      base += pos.getCount();
    }
    // Nothing left to move within the limit: what still comes through stays, and is answered.
    if (!any) return { rounds, moved: moved.size, largestMm: Math.round(largest * 10000) / 10, clipping: clippingOf(kit, fit, hides, { shapes }) };
  }
}



/** A garment of the starter wardrobe: its item's id and name, the MakeHuman asset it is made from,
 *  its slot, and the boxes of its texture painted out (left, top, right, bottom, as shares of the
 *  image's width and height). */
export interface StarterGarment {
  id: string;
  name: string;
  from: string;
  slot: Slot;
  paintOut?: ReadonlyArray<readonly [number, number, number, number]>;
}

/** P.08's garments: eight of MakeHuman's CC0 system assets. Left out (WARDROBE_LEFT_OUT): its
 *  tees but one (MakeHuman's logo on each, painted out of the white one), two sneakers photographed
 *  from branded shoes, and three outfits whose clipping skinning could not fix. */
export const STARTER_WARDROBE: readonly StarterGarment[] = [
  { id: 'white-tee-and-jeans', name: 'White tee and jeans', from: 'male_casualsuit06', slot: 'full', paintOut: [[0.444, 0.122, 0.62, 0.203], [0.193, 0.12, 0.295, 0.159], [0.726, 0.147, 0.757, 0.178]] },
  { id: 'striped-shirt-and-jeans', name: 'Striped shirt and jeans', from: 'male_casualsuit03', slot: 'full' },
  { id: 'jacket-and-jeans', name: 'Jacket and jeans', from: 'male_casualsuit05', slot: 'full' },
  { id: 'dark-suit', name: 'Dark suit', from: 'male_elegantsuit01', slot: 'full' },
  { id: 'overalls', name: 'Overalls', from: 'male_worksuit01', slot: 'full' },
  { id: 'brown-shoes', name: 'Brown shoes', from: 'shoes01', slot: 'shoes' },
  { id: 'black-boots', name: 'Black boots', from: 'shoes03', slot: 'shoes' },
  { id: 'grey-fedora', name: 'Grey fedora', from: 'fedora01', slot: 'hat' },
];

/** MakeHuman's garments not taken, and why (kits/items/wardrobe.json repeats them). */
export const WARDROBE_LEFT_OUT: ReadonlyArray<{ from: string; why: string }> = [
  { from: 'male_casualsuit02, male_casualsuit04, female_casualsuit01, female_casualsuit02', why: "MakeHuman's logo is printed on each of their tees: a trademark, which CC0 does not waive (the white tee of male_casualsuit06 is kept, its logo painted out)" },
  { from: 'shoes05, shoes06', why: 'photographed from branded sneakers (three stripes and a maker\'s logo on the sole; a swoosh)' },
  { from: 'female_elegantsuit01', why: 'the thighs come through the skirt when the body is seated (up to 29 mm on the three bodies), which skinning alone cannot follow' },
  { from: 'female_sportsuit01', why: "the leggings' low waist: the hips come through at the sliders' ends and when seated (up to 27 mm)" },
  { from: 'male_casualsuit01', why: "16,672 triangles, over the full slot's 14,000: simplified under it, the knee came through the jeans when seated (up to 9 mm)" },
];

/** Who made them: MakeHuman's garments, fitted and made into items here. */
export const WARDROBE_AUTHORS = ['the MakeHuman team', 'the FlatChat contributors'];

/** The proportions the wardrobe is checked at: as made and at both ends of every slider together,
 *  each in the seven reference poses (P.08's 12 test poses at the sliders' ends, besides each end's
 *  T-pose, and the seven as made). */
export const WARDROBE_SHAPES: readonly ProportionShares[] = [PROPORTIONS_AS_MADE, ...PROPORTION_ENDS.map((v) => ({ width: v, arms: v, legs: v, head: v }))];

/** A region hidden under a garment: covered on every body, wholly by the cloth over it, or by at
 *  least this share in MakeHuman's own delete group (what MakeHuman removes under the garment). */
export const HIDE_DELETED = 0.995;

/** The regions a garment hides, from each body's fit: the cloth's cover (coverageOf) and the share
 *  of each region in its delete group (fit.py). A left or right region goes only with its pair. */
export function wardrobeHides(fits: ReadonlyArray<{ covered: Partial<Record<Region, number>>; deleted: Partial<Record<Region, number>> }>): Region[] {
  const each = fits.map(({ covered, deleted }) => {
    const out = new Set<Region>();
    for (const [r, c] of Object.entries(covered) as Array<[Region, number]>) if (c >= 1) out.add(r);
    for (const [r, d] of Object.entries(deleted) as Array<[Region, number]>) if (d >= HIDE_DELETED) out.add(r);
    return out;
  });
  const all = [...(each[0] ?? [])].filter((r) => each.every((e) => e.has(r)));
  const pair = (r: Region): Region | undefined => (r.endsWith('_l') ? (`${r.slice(0, -2)}_r` as Region) : r.endsWith('_r') ? (`${r.slice(0, -2)}_l` as Region) : undefined);
  return all.filter((r) => !pair(r) || all.includes(pair(r)!)).sort();
}

/** Simplifies a fit under its slot's triangle cap, with 5 % to spare, when it is over it (MakeHuman's
 *  denser garments): meshoptimizer, its open edges and UV seams held. Answers the triangles after. */
export async function underCap(fit: Node, slot: Slot): Promise<number> {
  await MeshoptSimplifier.ready;
  const count = (): number => fit.getMesh()!.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  const cap = SLOTS[slot].triangles;
  if (count() <= cap) return count();
  const want = Math.floor(cap * 0.95);
  for (const error of [0.002, 0.005, 0.01, 0.02]) {
    for (const prim of fit.getMesh()!.listPrimitives()) {
      weldPrimitive(prim);
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: Math.min(1, want / count()), error, lockBorder: true });
    }
    if (count() <= want) break;
  }
  return count();
}

/** Paints out boxes of an image, in place: within each, the pixels unlike the white cloth round
 *  them (a logo's orange and its grey lettering, and four pixels round them for their soft edges)
 *  are filled in from the cloth round them, smoothly. Answers how many it painted. */
export function paintOut(img: Rgba, boxes: ReadonlyArray<readonly [number, number, number, number]>): number {
  let painted = 0;
  for (const [l, t, r, b] of boxes) {
    const [x0, y0, x1, y1] = [Math.floor(l * img.width), Math.floor(t * img.height), Math.ceil(r * img.width), Math.ceil(b * img.height)];
    const w = x1 - x0;
    const h = y1 - y0;
    let mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * img.width + x0 + x) * 4;
        const [R, G, B] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
        const hi = Math.max(R, G, B);
        const lo = Math.min(R, G, B);
        if ((R - B > 60 && R > 150) || (hi < 215 && hi - lo < 45)) mask[y * w + x] = 1;
      }
    }
    for (let k = 0; k < 4; k++) {
      const grown = mask.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) grown[(y + dy) * w + x + dx] = 1;
      mask = grown;
    }
    // Each painted pixel starts at the cloth's mean and settles to its neighbours' average.
    const px = new Float64Array(w * h * 3);
    const mean = [0, 0, 0];
    let kept = 0;
    for (let q = 0; q < w * h; q++) {
      const i = ((y0 + Math.floor(q / w)) * img.width + x0 + (q % w)) * 4;
      for (let c = 0; c < 3; c++) px[q * 3 + c] = img.data[i + c]!;
      if (!mask[q]) {
        kept += 1;
        for (let c = 0; c < 3; c++) mean[c]! += img.data[i + c]!;
      }
    }
    for (let q = 0; q < w * h; q++) if (mask[q]) for (let c = 0; c < 3; c++) px[q * 3 + c] = kept ? mean[c]! / kept : 230;
    for (let round = 0; round < 400; round++) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const q = y * w + x;
          if (!mask[q]) continue;
          for (let c = 0; c < 3; c++) px[q * 3 + c] = (px[(q - 1) * 3 + c]! + px[(q + 1) * 3 + c]! + px[(q - w) * 3 + c]! + px[(q + w) * 3 + c]!) / 4;
        }
      }
    }
    for (let q = 0; q < w * h; q++) {
      if (!mask[q]) continue;
      const i = ((y0 + Math.floor(q / w)) * img.width + x0 + (q % w)) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(px[q * 3 + c]!);
      painted += 1;
    }
  }
  return painted;
}

/** Makes a fit's material the wardrobe's, in place: its base colour only (painted out where the
 *  garment asks), at most `side` pixels a side, as a JPEG (a PNG when it has any transparency);
 *  opaque unless it does, two-sided, cloth-rough. Its other textures (MakeHuman's normal and
 *  ambient occlusion maps) go: the platform's toon look draws none of them. */
export function wardrobeMaterial(doc: Document, fit: Node, g: StarterGarment, side: number): void {
  for (const prim of fit.getMesh()!.listPrimitives()) {
    const old = prim.getMaterial();
    const texture = old?.getBaseColorTexture();
    const material = doc.createMaterial(g.id).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.9).setDoubleSided(true);
    const img = texture ? decodeImage(texture.getImage()!, texture.getMimeType()) : undefined;
    if (texture && img) {
      if (g.paintOut) paintOut(img, g.paintOut);
      let fitted = img;
      while (fitted.width > side || fitted.height > side) fitted = halve(fitted);
      let clear = true;
      for (let i = 3; i < fitted.data.length; i += 4) if (fitted.data[i]! < 255) clear = false;
      const out = doc.createTexture(g.id);
      if (clear) out.setImage(new Uint8Array(jpeg.encode({ width: fitted.width, height: fitted.height, data: Buffer.from(fitted.data) }, 90).data)).setMimeType('image/jpeg');
      else out.setImage(new Uint8Array(PNG.sync.write(Object.assign(new PNG({ width: fitted.width, height: fitted.height }), { data: Buffer.from(fitted.data) })))).setMimeType('image/png');
      material.setBaseColorTexture(out).setAlphaMode(clear ? 'OPAQUE' : 'MASK');
    } else if (old) material.setBaseColorFactor(old.getBaseColorFactor());
    prim.setMaterial(material);
  }
}
