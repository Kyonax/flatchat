// SPDX-License-Identifier: MPL-2.0
// A building plan built into a world (Track P's P.01, dp-007): every wall a run of mitered pieces
// cut around its openings (a sill below a window, a lintel over a door), every slab triangulated,
// stairs as steps, neon strips as glowing bars; their faces cut into cells of CELL metres, mapped
// onto the trim sheet by height (materials.ts) and lit by the plan's lights baked into the vertex
// colours, with the walls', steps' and slabs' shadows. The same pieces are the solids: a box per
// wall piece and step, a box per rectangular slab and a triangle mesh for any other. Props become
// the base library's parts, spawn points the world's. The scene is one mesh a material, so a
// building draws in a handful of calls; levels of detail are the world converter's (S2.03).
import { type ImageSpec, type MeshSpec, type NodeSpec, writeGlb } from '../glb-writer.ts';
import { ATLAS, BANDS, type BandName, deckPlate, landingPad, starField, trimSheet } from './materials.ts';
import type { Floor, P2, Plan, Slab, Stairs, Wall } from './plan.ts';

/** Faces are cut into cells this size at most, so the light baked at their corners is smooth. */
export const CELL = 1;
/** The light everywhere, before the plan's lights. */
export const AMBIENT = 0.28;

type P3 = [number, number, number];

/** What a surface is drawn with. */
interface Look {
  texture?: number;
  tint: [number, number, number];
  emissive?: [number, number, number];
  emissiveTexture?: number;
  /** Lit by the baked light (not a glowing one). */
  lit: boolean;
}

const IMAGES = { atlas: 0, deck: 1, pad: 2, space: 3 } as const;

interface Surface {
  look: Look;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** A solid box: its centre, its half sizes and its turn about the vertical. */
interface Box {
  centre: P3;
  half: P3;
  yaw: number;
}

/** A slab as an occluder: its ring and its top and bottom. */
interface SlabShadow {
  ring: P2[];
  top: number;
  bottom: number;
}

export interface BuiltPlan {
  glb: Uint8Array;
  worldToml: string;
  triangles: number;
  materials: number;
  solids: number;
  parts: number;
}

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: P2, b: P2, k = 1): P2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const len2 = (a: P2): number => Math.hypot(a[0], a[1]);
const unit2 = (a: P2): P2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};
/** The left of a direction on the page (x right, y down): a quarter turn. */
const leftOf = (d: P2): P2 => [d[1], -d[0]];

class Builder {
  readonly surfaces = new Map<string, Surface>();
  readonly boxes: Box[] = [];
  readonly slabShadows: SlabShadow[] = [];
  readonly trimeshes: Array<{ positions: number[]; indices: number[] }> = [];

  surface(name: string, look: Look): Surface {
    let s = this.surfaces.get(name);
    if (!s) this.surfaces.set(name, (s = { look, positions: [], normals: [], uvs: [], indices: [] }));
    return s;
  }

  /** A quad cut into nu × nv cells: corners a (u0 v0), b (u1 v0), c (u1 v1), d (u0 v1), counter-clockwise seen from its normal's side. */
  quad(s: Surface, a: P3, b: P3, c: P3, d: P3, n: P3, uv: (fu: number, fv: number) => P2, nu: number, nv: number): void {
    const base = s.positions.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const [fu, fv] = [i / nu, j / nv];
        const p = [0, 1, 2].map((k) => (1 - fv) * ((1 - fu) * a[k]! + fu * b[k]!) + fv * ((1 - fu) * d[k]! + fu * c[k]!));
        s.positions.push(...p);
        s.normals.push(...n);
        s.uvs.push(...uv(fu, fv));
      }
    }
    // Wound to face its normal, whichever way its corners were given.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const flip = g[0]! * n[0] + g[1]! * n[1] + g[2]! * n[2] < 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = base + j * (nu + 1) + i;
        if (flip) s.indices.push(k, k + nu + 2, k + 1, k, k + nu + 1, k + nu + 2);
        else s.indices.push(k, k + 1, k + nu + 2, k, k + nu + 2, k + nu + 1);
      }
    }
  }

  /** Triangles of a flat polygon at height y (facing up, or down), with planar texture
   *  coordinates; on a lit surface each is cut until its sides are CELL × 2 at most. */
  polygon(s: Surface, ring: P2[], y: number, up: boolean, uv: (p: P2) => P2): void {
    let tris = earClip(ring);
    const long = (t: [P2, P2, P2]): boolean => s.look.lit && Math.max(len2(sub(t[0], t[1])), len2(sub(t[1], t[2])), len2(sub(t[2], t[0]))) > CELL * 2;
    for (let round = 0; round < 6 && tris.some(long); round++) {
      tris = tris.flatMap((t): Array<[P2, P2, P2]> => {
        if (!long(t)) return [t];
        const [a, b, c] = t;
        const [ab, bc, ca] = [add2(a, sub(b, a), 0.5), add2(b, sub(c, b), 0.5), add2(c, sub(a, c), 0.5)];
        return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]];
      });
    }
    // Shared corners are one vertex, so the baked light is smooth across them.
    const index = new Map<string, number>();
    const at = (p: P2): number => {
      const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
      let k = index.get(key);
      if (k === undefined) {
        k = s.positions.length / 3;
        index.set(key, k);
        s.positions.push(p[0], y, p[1]);
        s.normals.push(0, up ? 1 : -1, 0);
        s.uvs.push(...uv(p));
      }
      return k;
    };
    for (const [a, b, c] of tris) {
      const [ia, ib, ic] = [at(a), at(b), at(c)];
      // Wound to face up or down: the y of (b - a) × (c - a), with the page's y as the world's z.
      const ny = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      if (ny > 0 === up) s.indices.push(ia, ib, ic);
      else s.indices.push(ia, ic, ib);
    }
  }
}

/** Triangles of a simple polygon (no holes), by ear clipping; counter-clockwise on the page. */
export function earClip(ring: readonly P2[]): Array<[P2, P2, P2]> {
  const pts = [...ring];
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[(i + 1) % pts.length]!];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) pts.reverse();
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: P2, a: P2, b: P2, c: P2): boolean => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const out: Array<[P2, P2, P2]> = [];
  const idx = pts.map((_, i) => i);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const [a, b, c] = [pts[idx[(k + idx.length - 1) % idx.length]!]!, pts[idx[k]!]!, pts[idx[(k + 1) % idx.length]!]!];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => ![a, b, c].includes(pts[j]!) && inside(pts[j]!, a, b, c))) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([pts[idx[0]!]!, pts[idx[1]!]!, pts[idx[2]!]!]);
  return out;
}

/** A ring with four corners at right angles, as a box's centre, size and turn. */
function asRectangle(ring: readonly P2[]): { centre: P2; size: P2; yaw: number } | undefined {
  if (ring.length !== 4) return undefined;
  const e = [0, 1, 2, 3].map((i) => sub(ring[(i + 1) % 4]!, ring[i]!));
  for (let i = 0; i < 4; i++) if (Math.abs(e[i]![0] * e[(i + 1) % 4]![0] + e[i]![1] * e[(i + 1) % 4]![1]) > 1e-6 * (len2(e[i]!) * len2(e[(i + 1) % 4]!) + 1e-9)) return undefined;
  const centre: P2 = [(ring[0]![0] + ring[2]![0]) / 2, (ring[0]![1] + ring[2]![1]) / 2];
  return { centre, size: [len2(e[0]!), len2(e[1]!)], yaw: -Math.atan2(e[0]![1], e[0]![0]) };
}

/** The wall pieces of a run: each a quad footprint along one segment, between two lengths along
 *  it, solid or above and below an opening. */
function buildWall(b: Builder, wall: Wall, floor: Floor): void {
  if (wall.material === 'space') return buildBackdrop(b, wall, floor);
  const pts = wall.path;
  const n = pts.length;
  const segs = wall.closed ? n : n - 1;
  const half = wall.thickness / 2;
  const dir = (i: number): P2 => unit2(sub(pts[(i + 1) % n]!, pts[i]!));
  // The miter at each corner: offsets whose projection on both sides' normals is half the wall.
  const miter = (i: number): P2 => {
    const open = !wall.closed && (i === 0 || i === n - 1);
    if (open) return leftOf(dir(i === n - 1 ? i - 1 : i));
    const [l0, l1] = [leftOf(dir((i - 1 + n) % n)), leftOf(dir(i))];
    const m: P2 = [l0[0] + l1[0], l0[1] + l1[1]];
    const k = 1 + l0[0] * l1[0] + l0[1] * l1[1];
    return k < 0.2 ? l1 : [m[0] / k, m[1] / k];
  };
  const base = floor.elevation;
  const body: BandName = wall.material === 'hull' ? 'hull' : 'panel';
  const atlas = b.surface('atlas', { texture: IMAGES.atlas, tint: [1, 1, 1], lit: true });
  let along = 0;
  for (let i = 0; i < segs; i++) {
    const [p0, p1] = [pts[i]!, pts[(i + 1) % n]!];
    const d = dir(i);
    const L = len2(sub(p1, p0));
    const left = leftOf(d);
    // The openings on this segment, as lengths along it.
    const cuts = floor.openings
      .map((o) => {
        const [s0, s1] = [o.a, o.b].map((q) => (q[0] - p0[0]) * d[0] + (q[1] - p0[1]) * d[1]) as [number, number];
        const off = Math.max(...[o.a, o.b].map((q) => Math.abs((q[0] - p0[0]) * left[0] + (q[1] - p0[1]) * left[1])));
        return { lo: Math.max(0, Math.min(s0, s1)), hi: Math.min(L, Math.max(s0, s1)), sill: o.sill, head: o.head, near: off <= Math.max(wall.thickness, 0.3) && Math.max(s0, s1) > 0 && Math.min(s0, s1) < L };
      })
      .filter((c) => c.near && c.hi - c.lo > 0.05)
      .sort((x, y) => x.lo - y.lo);
    const [m0, m1] = [miter(i), miter((i + 1) % n)];
    const corner = (s: number, side: 1 | -1): P2 => (s <= 1e-9 ? add2(p0, m0, side * half) : s >= L - 1e-9 ? add2(p1, m1, side * half) : add2(add2(p0, d, s), left, side * half));
    const piece = (s0: number, s1: number, y0: number, y1: number, capStart: boolean, capEnd: boolean, kick: boolean): void => {
      if (y1 - y0 < 1e-3 || s1 - s0 < 1e-3) return;
      const [ls, le, rs, re] = [corner(s0, 1), corner(s1, 1), corner(s0, -1), corner(s1, -1)];
      // Its solid: the box round its centre line.
      const mid = add2(p0, d, (s0 + s1) / 2);
      b.boxes.push({ centre: [mid[0], (y0 + y1) / 2, mid[1]], half: [(s1 - s0) / 2, (y1 - y0) / 2, half], yaw: -Math.atan2(d[1], d[0]) });
      // Both faces, in strips of the trim sheet's bands.
      const u = (q: P2): number => (along + (q[0] - p0[0]) * d[0] + (q[1] - p0[1]) * d[1]);
      let y = y0;
      const strips: Array<[number, number, BandName]> = [];
      if (kick) {
        const top = Math.min(y1, y0 + BANDS.kick.up);
        strips.push([y0, top, 'kick']);
        y = top;
      }
      while (y < y1 - 1e-6) {
        const top = Math.min(y1, y + BANDS[body].up);
        strips.push([y, top, body]);
        y = top;
      }
      const nu = Math.max(1, Math.ceil((s1 - s0) / CELL));
      for (const [ya, yb, band] of strips) {
        const B = BANDS[band];
        const nv = Math.max(1, Math.ceil((yb - ya) / CELL));
        // The strip's bottom on the band's bottom row; a strip shorter than the band takes its lower part.
        const v = (fv: number): number => (B.v1 - ((fv * (yb - ya)) / B.up) * (B.v1 - B.v0)) / ATLAS.height;
        // The left face looks out along `left`, the right face the other way.
        b.quad(atlas, [ls[0], ya, ls[1]], [le[0], ya, le[1]], [le[0], yb, le[1]], [ls[0], yb, ls[1]], [left[0], 0, left[1]], (fu, fv) => [(u(ls) + fu * (u(le) - u(ls))) / B.across, v(fv)], nu, nv);
        b.quad(atlas, [re[0], ya, re[1]], [rs[0], ya, rs[1]], [rs[0], yb, rs[1]], [re[0], yb, re[1]], [-left[0], 0, -left[1]], (fu, fv) => [(u(re) + fu * (u(rs) - u(re))) / B.across, v(fv)], nu, nv);
      }
      // The top, and the ends that show (a run's own end, a door's jambs).
      const T = BANDS.trim;
      const tv = (fv: number): number => (T.v0 + fv * (T.v1 - T.v0)) / ATLAS.height;
      b.quad(atlas, [rs[0], y1, rs[1]], [re[0], y1, re[1]], [le[0], y1, le[1]], [ls[0], y1, ls[1]], [0, 1, 0], (fu, fv) => [(u(rs) + fu * (u(re) - u(rs))) / T.across, tv(fv)], nu, 1);
      const nv = Math.max(1, Math.ceil((y1 - y0) / CELL));
      if (capStart) b.quad(atlas, [ls[0], y0, ls[1]], [rs[0], y0, rs[1]], [rs[0], y1, rs[1]], [ls[0], y1, ls[1]], [-d[0], 0, -d[1]], (fu, fv) => [fu * wall.thickness / T.across, tv(fv)], 1, nv);
      if (capEnd) b.quad(atlas, [re[0], y0, re[1]], [le[0], y0, le[1]], [le[0], y1, le[1]], [re[0], y1, re[1]], [d[0], 0, d[1]], (fu, fv) => [fu * wall.thickness / T.across, tv(fv)], 1, nv);
    };
    const top = base + wall.height;
    let s = 0;
    const startCap = !wall.closed && i === 0;
    const endCap = !wall.closed && i === segs - 1;
    for (const c of cuts) {
      if (c.lo > s) piece(s, c.lo, base, top, s === 0 ? startCap : true, true, true);
      // Below the opening (a sill) and over it (a lintel).
      piece(c.lo, c.hi, base, base + Math.max(0, c.sill), true, true, true);
      piece(c.lo, c.hi, base + Math.min(wall.height, c.head), top, true, true, false);
      s = c.hi;
    }
    if (s < L) piece(s, L, base, top, s === 0 ? startCap : true, endCap, true);
    along += L;
  }
}

/** A wall of space (material "space"): stars glowing beyond a bay door, no solid, nothing lit. */
function buildBackdrop(b: Builder, wall: Wall, floor: Floor): void {
  const space = b.surface('space', { texture: IMAGES.space, tint: [0, 0, 0], emissive: [1, 1, 1], emissiveTexture: IMAGES.space, lit: false });
  const [y0, y1] = [floor.elevation, floor.elevation + wall.height];
  let along = 0;
  const n = wall.path.length;
  for (let i = 0; i < (wall.closed ? n : n - 1); i++) {
    const [p, q] = [wall.path[i]!, wall.path[(i + 1) % n]!];
    const d = unit2(sub(q, p));
    const L = len2(sub(q, p));
    const left = leftOf(d);
    const uv = (fu: number, fv: number): P2 => [(along + fu * L) / 20, 1 - ((fv * (y1 - y0)) / 20)];
    b.quad(space, [p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], [left[0], 0, left[1]], uv, 1, 1);
    b.quad(space, [q[0], y0, q[1]], [p[0], y0, p[1]], [p[0], y1, p[1]], [q[0], y1, q[1]], [-left[0], 0, -left[1]], uv, 1, 1);
    along += L;
  }
}

function buildSlab(b: Builder, slab: Slab, floor: Floor): void {
  const top = floor.elevation + slab.top;
  if (slab.material === 'space') {
    // Stars below or above the station: both faces glow, nothing stands on them, nothing is shaded.
    const space = b.surface('space', { texture: IMAGES.space, tint: [0, 0, 0], emissive: [1, 1, 1], emissiveTexture: IMAGES.space, lit: false });
    b.polygon(space, slab.ring, top, true, (p) => [p[0] / 20, p[1] / 20]);
    b.polygon(space, slab.ring, top, false, (p) => [p[0] / 20, p[1] / 20]);
    return;
  }
  const bottom = top - slab.thickness;
  const isPad = slab.material === 'pad';
  const xs = slab.ring.map((p) => p[0]);
  const zs = slab.ring.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const uv = (p: P2): P2 => (isPad ? [(p[0] - minX) / (maxX - minX), (p[1] - minZ) / (maxZ - minZ)] : [p[0] / 2, p[1] / 2]);
  const surface = isPad ? b.surface('pad', { texture: IMAGES.pad, tint: [1, 1, 1], lit: true }) : slab.material === 'ceiling' ? b.surface('ceiling', { texture: IMAGES.deck, tint: [0.45, 0.46, 0.5], lit: true }) : b.surface('deck', { texture: IMAGES.deck, tint: [1, 1, 1], lit: true });
  // A ceiling shows its underside; anything else its top, and its underside too when it is above
  // the ground (a mezzanine's).
  if (slab.material === 'ceiling') b.polygon(surface, slab.ring, bottom, false, uv);
  else {
    b.polygon(surface, slab.ring, top, true, uv);
    if (top > 0.05) b.polygon(b.surface('ceiling', { texture: IMAGES.deck, tint: [0.45, 0.46, 0.5], lit: true }), slab.ring, bottom, false, (p) => [p[0] / 2, p[1] / 2]);
  }
  // Its edges, outward.
  const atlas = b.surface('atlas', { texture: IMAGES.atlas, tint: [1, 1, 1], lit: true });
  const T = BANDS.trim;
  let area = 0;
  for (let i = 0; i < slab.ring.length; i++) {
    const [p, q] = [slab.ring[i]!, slab.ring[(i + 1) % slab.ring.length]!];
    area += p[0] * q[1] - q[0] * p[1];
  }
  let along = 0;
  for (let i = 0; i < slab.ring.length; i++) {
    const [p, q] = [slab.ring[i]!, slab.ring[(i + 1) % slab.ring.length]!];
    const d = unit2(sub(q, p));
    // A positive area is counter-clockwise with z as y: the inside is to each edge's left, (-dz, dx).
    const out: P2 = area > 0 ? [d[1], -d[0]] : [-d[1], d[0]];
    const L = len2(sub(q, p));
    b.quad(atlas, [p[0], bottom, p[1]], [q[0], bottom, q[1]], [q[0], top, q[1]], [p[0], top, p[1]], [out[0], 0, out[1]], (fu, fv) => [(along + fu * L) / T.across, (T.v1 - fv * (T.v1 - T.v0)) / ATLAS.height], Math.max(1, Math.ceil(L / CELL)), 1);
    along += L;
  }
  // Its solid and its shadow.
  b.slabShadows.push({ ring: slab.ring, top, bottom });
  const rect = asRectangle(slab.ring);
  if (rect) b.boxes.push({ centre: [rect.centre[0], (top + bottom) / 2, rect.centre[1]], half: [rect.size[0] / 2, (top - bottom) / 2, rect.size[1] / 2], yaw: rect.yaw });
  else {
    const t = earClip(slab.ring);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const tri of t) {
      for (const y of [top, bottom]) {
        const k = positions.length / 3;
        for (const p of tri) positions.push(p[0], y, p[1]);
        indices.push(k, k + 2, k + 1);
      }
    }
    b.trimeshes.push({ positions, indices });
  }
}

function buildStairs(b: Builder, st: Stairs, floor: Floor): void {
  const centre: P2 = [st.ring.reduce((s, p) => s + p[0], 0) / 4, st.ring.reduce((s, p) => s + p[1], 0) / 4];
  const across: P2 = leftOf(st.up);
  const along = (p: P2): number => (p[0] - centre[0]) * st.up[0] + (p[1] - centre[1]) * st.up[1];
  const side = (p: P2): number => (p[0] - centre[0]) * across[0] + (p[1] - centre[1]) * across[1];
  const [a0, a1] = [Math.min(...st.ring.map(along)), Math.max(...st.ring.map(along))];
  const [w0, w1] = [Math.min(...st.ring.map(side)), Math.max(...st.ring.map(side))];
  const at = (a: number, w: number): P2 => add2(add2(centre, st.up, a), across, w);
  const deck = b.surface('deck', { texture: IMAGES.deck, tint: [1, 1, 1], lit: true });
  const atlas = b.surface('atlas', { texture: IMAGES.atlas, tint: [1, 1, 1], lit: true });
  const T = BANDS.trim;
  const step = (a1 - a0) / st.steps;
  const nw = Math.max(1, Math.ceil((w1 - w0) / CELL));
  for (let k = 0; k < st.steps; k++) {
    const [sa, sb] = [a0 + k * step, a0 + (k + 1) * step];
    const y0 = floor.elevation;
    const y1 = floor.elevation + ((k + 1) * st.rise) / st.steps;
    const [p00, p01, p10, p11] = [at(sa, w0), at(sa, w1), at(sb, w0), at(sb, w1)];
    // The tread, the riser facing down the flight, and both sides.
    b.quad(deck, [p00[0], y1, p00[1]], [p01[0], y1, p01[1]], [p11[0], y1, p11[1]], [p10[0], y1, p10[1]], [0, 1, 0], (fu, fv) => [(w0 + fu * (w1 - w0)) / 2, (sa + fv * step) / 2], nw, 1);
    const riserFrom = k === 0 ? y0 : floor.elevation + (k * st.rise) / st.steps;
    b.quad(atlas, [p01[0], riserFrom, p01[1]], [p00[0], riserFrom, p00[1]], [p00[0], y1, p00[1]], [p01[0], y1, p01[1]], [-st.up[0], 0, -st.up[1]], (fu, fv) => [(fu * (w1 - w0)) / T.across, (T.v1 - fv * (T.v1 - T.v0)) / ATLAS.height], nw, 1);
    b.quad(atlas, [p00[0], y0, p00[1]], [p10[0], y0, p10[1]], [p10[0], y1, p10[1]], [p00[0], y1, p00[1]], [-across[0], 0, -across[1]], (fu, fv) => [(sa + fu * step) / T.across, (T.v1 - fv * (T.v1 - T.v0)) / ATLAS.height], 1, 1);
    b.quad(atlas, [p11[0], y0, p11[1]], [p01[0], y0, p01[1]], [p01[0], y1, p01[1]], [p11[0], y1, p11[1]], [across[0], 0, across[1]], (fu, fv) => [(sa + fu * step) / T.across, (T.v1 - fv * (T.v1 - T.v0)) / ATLAS.height], 1, 1);
    const mid = at((sa + sb) / 2, (w0 + w1) / 2);
    b.boxes.push({ centre: [mid[0], (y0 + y1) / 2, mid[1]], half: [step / 2, (y1 - y0) / 2, (w1 - w0) / 2], yaw: -Math.atan2(st.up[1], st.up[0]) });
  }
}

/** Glowing bars along a strip's path, a material for each colour. */
function buildStrips(b: Builder, floor: Floor): void {
  for (const strip of floor.strips) {
    const hex = strip.colour.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
    const glow = b.surface(`neon-${hex}`, { tint: [0, 0, 0], emissive: strip.colour, lit: false });
    const n = strip.path.length;
    const segs = strip.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const [p, q] = [strip.path[i]!, strip.path[(i + 1) % n]!];
      const d = unit2(sub(q, p));
      const l = leftOf(d);
      const h = strip.size / 2;
      const y = floor.elevation + strip.y;
      const [a, c] = [add2(p, d, -h), add2(q, d, h)];
      const corner = (e: P2, s: number): P2 => add2(e, l, s * h);
      const faces: Array<[P2, P2, number, number, P3]> = [
        [corner(a, 1), corner(c, 1), y - h, y + h, [l[0], 0, l[1]]],
        [corner(c, -1), corner(a, -1), y - h, y + h, [-l[0], 0, -l[1]]],
      ];
      for (const [s0, s1, y0, y1, nrm] of faces) b.quad(glow, [s0[0], y0, s0[1]], [s1[0], y0, s1[1]], [s1[0], y1, s1[1]], [s0[0], y1, s0[1]], nrm, () => [0, 0], 1, 1);
      b.quad(glow, [corner(a, -1)[0], y + h, corner(a, -1)[1]], [corner(c, -1)[0], y + h, corner(c, -1)[1]], [corner(c, 1)[0], y + h, corner(c, 1)[1]], [corner(a, 1)[0], y + h, corner(a, 1)[1]], [0, 1, 0], () => [0, 0], 1, 1);
      b.quad(glow, [corner(a, 1)[0], y - h, corner(a, 1)[1]], [corner(c, 1)[0], y - h, corner(c, 1)[1]], [corner(c, -1)[0], y - h, corner(c, -1)[1]], [corner(a, -1)[0], y - h, corner(a, -1)[1]], [0, -1, 0], () => [0, 0], 1, 1);
    }
  }
}

/** Whether a segment from p (going d, as far as `far`) passes through a box or a slab. */
function blocked(b: Builder, p: P3, d: P3, far: number): boolean {
  for (const box of b.boxes) {
    const [c, s] = [Math.cos(-box.yaw), Math.sin(-box.yaw)];
    // Into the box's frame: its x along its length.
    const o: P3 = [p[0] - box.centre[0], p[1] - box.centre[1], p[2] - box.centre[2]];
    const lo: P3 = [o[0] * c + o[2] * s, o[1], -o[0] * s + o[2] * c];
    const ld: P3 = [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
    let [t0, t1] = [1e-4, far - 1e-3];
    let hit = true;
    for (let k = 0; k < 3 && hit; k++) {
      if (Math.abs(ld[k]!) < 1e-12) {
        if (Math.abs(lo[k]!) > box.half[k]!) hit = false;
        continue;
      }
      let [ta, tb] = [(-box.half[k]! - lo[k]!) / ld[k]!, (box.half[k]! - lo[k]!) / ld[k]!];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) hit = false;
    }
    if (hit) return true;
  }
  for (const s of b.slabShadows) {
    for (const y of [s.top, s.bottom]) {
      if (Math.abs(d[1]) < 1e-12) continue;
      const t = (y - p[1]) / d[1];
      if (t <= 1e-3 || t >= far - 1e-3) continue;
      if (insideRing(s.ring, [p[0] + d[0] * t, p[2] + d[2] * t])) return true;
    }
  }
  return false;
}

function insideRing(ring: readonly P2[], p: P2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i]!, ring[j]!];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Each lit vertex's light: the ambient, and each of the plan's lights that reaches it unblocked. */
function bake(b: Builder, plan: Plan, s: Surface): number[] {
  const lights = plan.floors.flatMap((f) => f.lights.map((l) => ({ ...l, p: [l.at[0], f.elevation + l.y, l.at[1]] as P3 })));
  const out: number[] = [];
  for (let v = 0; v < s.positions.length / 3; v++) {
    const p: P3 = [s.positions[v * 3]!, s.positions[v * 3 + 1]!, s.positions[v * 3 + 2]!];
    const n: P3 = [s.normals[v * 3]!, s.normals[v * 3 + 1]!, s.normals[v * 3 + 2]!];
    const from: P3 = [p[0] + n[0] * 0.02, p[1] + n[1] * 0.02, p[2] + n[2] * 0.02];
    const c = [AMBIENT, AMBIENT, AMBIENT];
    for (const l of lights) {
      const to: P3 = [l.p[0] - from[0], l.p[1] - from[1], l.p[2] - from[2]];
      const dist = Math.hypot(to[0], to[1], to[2]);
      if (dist >= l.range || dist < 1e-6) continue;
      const dir: P3 = [to[0] / dist, to[1] / dist, to[2] / dist];
      const facing = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
      if (facing <= 0) continue;
      const fall = (1 - dist / l.range) ** 2;
      if (blocked(b, from, dir, dist)) continue;
      for (let k = 0; k < 3; k++) c[k]! += l.colour[k]! * l.intensity * facing * fall;
    }
    out.push(...c.map((x) => Math.min(1, x)));
  }
  return out;
}

const yawQuat = (deg: number): [number, number, number, number] => {
  // Clockwise on the page, seen from above: a negative turn about +y.
  const half = (-deg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
};

/** The plan as a world folder's scene and world.toml. */
export function buildPlan(plan: Plan, sceneId: string): BuiltPlan {
  const b = new Builder();
  for (const f of plan.floors) {
    for (const slab of f.slabs) buildSlab(b, slab, f);
    for (const st of f.stairs) buildStairs(b, st, f);
  }
  // Walls after the slabs, so the slabs' shadows are known when the walls' pieces are added.
  for (const f of plan.floors) for (const w of f.walls) buildWall(b, w, f);
  for (const f of plan.floors) buildStrips(b, f);
  // A small glowing panel at each light, so it shows where the light comes from.
  for (const f of plan.floors) {
    for (const l of f.lights) {
      const hex = l.colour.map((c) => Math.round(Math.min(1, c) * 255).toString(16).padStart(2, '0')).join('');
      const glow = b.surface(`neon-${hex}`, { tint: [0, 0, 0], emissive: l.colour.map((c) => Math.min(1, c)) as [number, number, number], lit: false });
      const y = f.elevation + l.y + 0.05;
      const [x, z] = l.at;
      b.quad(glow, [x - 0.3, y, z + 0.3], [x + 0.3, y, z + 0.3], [x + 0.3, y, z - 0.3], [x - 0.3, y, z - 0.3], [0, -1, 0], () => [0, 0], 1, 1);
    }
  }
  const images: ImageSpec[] = [
    { name: 'trim-sheet', bytes: trimSheet(), mimeType: 'image/png' },
    { name: 'deck-plate', bytes: deckPlate(), mimeType: 'image/png' },
    { name: 'landing-pad', bytes: landingPad(), mimeType: 'image/png' },
    { name: 'star-field', bytes: starField(), mimeType: 'image/png' },
  ];
  // Every surface becomes a mesh: its light baked into its vertex colours when it is lit.
  const meshes: MeshSpec[] = [];
  for (const [name, s] of [...b.surfaces].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (s.indices.length === 0) continue;
    meshes.push({
      name,
      positions: s.positions,
      normals: s.normals,
      indices: s.indices,
      colour: [...s.look.tint, 1],
      ...(s.look.texture !== undefined ? { uvs: s.uvs, texture: s.look.texture } : {}),
      ...(s.look.lit ? { colours: bake(b, plan, s) } : {}),
      ...(s.look.emissive ? { emissive: s.look.emissive } : {}),
      ...(s.look.emissiveTexture !== undefined ? { emissiveTexture: s.look.emissiveTexture } : {}),
    });
  }
  // The space beyond a bay door: the hull material 'space' marks where (see plan.ts).
  const shapes: Array<Record<string, unknown>> = [];
  const nodes: NodeSpec[] = meshes.map((m, k) => ({ name: m.name, mesh: k }));
  for (const box of b.boxes) {
    shapes.push({ type: 'box', box: { size: [box.half[0] * 2, box.half[1] * 2, box.half[2] * 2] } });
    nodes.push({ name: `solid-${shapes.length - 1}`, translation: box.centre, rotation: [0, Math.sin(box.yaw / 2), 0, Math.cos(box.yaw / 2)], extensions: { OMI_physics_body: { motion: { type: 'static' }, collider: { shape: shapes.length - 1 } } } });
  }
  // A slab that is no rectangle is a triangle mesh: its own mesh, drawn by nothing.
  for (const t of b.trimeshes) {
    meshes.push({ name: `solid-mesh-${meshes.length}`, positions: t.positions, normals: t.positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), indices: t.indices, colour: [1, 1, 1, 1] });
    shapes.push({ type: 'trimesh', trimesh: { mesh: meshes.length - 1 } });
    nodes.push({ name: `solid-${shapes.length - 1}`, extensions: { OMI_physics_body: { motion: { type: 'static' }, collider: { shape: shapes.length - 1 } } } });
  }
  let parts = 0;
  for (const f of plan.floors) {
    for (const p of f.props) {
      nodes.push({ name: `${p.part.split(':').pop()}-${nodes.length}`, translation: [p.at[0], f.elevation + p.y, p.at[1]], rotation: yawQuat(p.rotate), extensions: { FLATCHAT_world: { part: { id: p.part } } } });
      parts += 1;
    }
    for (const s of f.spawns) nodes.push({ name: `spawn-${nodes.length}`, translation: [s.at[0], f.elevation, s.at[1]], rotation: yawQuat(s.facing), extensions: { OMI_spawn_point: { title: s.title, group: s.group } } });
  }
  const glb = writeGlb(meshes, nodes, { OMI_physics_shape: { shapes } }, ['OMI_physics_shape', 'OMI_physics_body', 'OMI_spawn_point', ...(parts ? ['FLATCHAT_world'] : [])], images);
  const worldToml = `# SPDX-License-Identifier: CC-BY-4.0
# Built from plan.svg by tools/converter/scripts/build-plan.ts (Track P's P.01, docs/svg-plans.md).
format = 1
name = ${JSON.stringify(plan.name)}
description = ${JSON.stringify(plan.description)}

[capacity]
recommended = 40
maximum = 60

[persistence]
mode = "reset"

[movement]
flying = false

[voice]
range = 25

[[scenes]]
id = ${JSON.stringify(sceneId)}
file = "scenes/${sceneId}.glb"
`;
  const drawn = meshes.filter((m) => !m.name.startsWith('solid-mesh-'));
  return { glb, worldToml, triangles: drawn.reduce((n, m) => n + m.indices.length / 3, 0), materials: drawn.length, solids: shapes.length, parts };
}

/** A plan's solids as the builder makes them, for previews drawn by other tools (P.01's isometric
 *  plates): each wall piece, step and rectangular slab as a box (centre, half sizes, turn about
 *  the vertical), every slab as its ring between its top and bottom, the props' base parts by id
 *  and place. Space and ceilings are left out: a preview looks in from above. */
export function planSolids(plan: Plan): { boxes: Array<{ centre: P3; half: P3; yaw: number; kind: 'wall' | 'step' }>; slabs: Array<{ ring: P2[]; top: number; bottom: number; material: string }>; props: Array<{ at: P3; part: string; rotate: number }> } {
  const b = new Builder();
  const slabs: Array<{ ring: P2[]; top: number; bottom: number; material: string }> = [];
  const boxes: Array<{ centre: P3; half: P3; yaw: number; kind: 'wall' | 'step' }> = [];
  for (const f of plan.floors) {
    for (const slab of f.slabs) {
      if (slab.material === 'space' || slab.material === 'ceiling') continue;
      const top = f.elevation + slab.top;
      slabs.push({ ring: slab.ring, top, bottom: top - slab.thickness, material: slab.material });
    }
    for (const st of f.stairs) {
      const before = b.boxes.length;
      buildStairs(b, st, f);
      for (const box of b.boxes.slice(before)) boxes.push({ ...box, kind: 'step' });
    }
  }
  for (const f of plan.floors) {
    for (const w of f.walls) {
      if (w.material === 'space') continue;
      const before = b.boxes.length;
      buildWall(b, w, f);
      for (const box of b.boxes.slice(before)) boxes.push({ ...box, kind: 'wall' });
    }
  }
  const props = plan.floors.flatMap((f) => f.props.map((p) => ({ at: [p.at[0], f.elevation + p.y, p.at[1]] as P3, part: p.part, rotate: p.rotate })));
  return { boxes, slabs, props };
}
