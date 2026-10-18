// SPDX-License-Identifier: MPL-2.0
// S5.02's no-clipping check: an item's fit worn on its body in the reference poses. Both are posed
// with the body's own skeleton (the fit by its joints' names); a body vertex the item does not hide
// that sits within reach of the garment must stay under it, never out through it. A fit made on
// another body, or too tight, shows as body vertices out through the garment. Each body point looks
// along its normal: cloth just outside it covers it, cloth just inside it is skin out through the
// garment, by that depth. Only cloth facing the way the skin does counts: a fold's inner layer, a
// collar's band or a jacket's lining faces the body (P.08's MakeHuman clothes have all three), and
// so does the far side of a limb's sleeve. The body can be checked at other proportions too (P.08:
// the sliders' ends), posed as the client poses it.
import type { Document, Node, Primitive } from '@gltf-transform/core';
import { type BodyKit, type ItemClipping, PROPORTION_JOINTS, PROPORTION_SEGMENTS, PROPORTIONS_AS_MADE, type ProportionShares, type Region, regionOfBone, stretchAlong, WIDTH_FALLBACK } from '@flatchat/content';
import { apply, invert, type M4, mul } from '../avatar/matrix.ts';
import { poseMatrices, type Turn } from '../avatar/stride.ts';
import type { VRMData } from '../avatar/vrm.ts';

/** The reference poses (VRM 1.0 faces +Z, its left hand at +X; the kits rest in T-pose). */
export const REFERENCE_POSES: ReadonlyArray<{ name: string; turns: readonly Turn[] }> = (() => {
  const armsDown: Turn[] = [['leftUpperArm', 'z', -1.25], ['rightUpperArm', 'z', 1.25]];
  return [
    { name: 'T-pose', turns: [] },
    { name: 'arms down', turns: armsDown },
    { name: 'stride left', turns: [...armsDown, ['leftUpperLeg', 'x', -0.6], ['rightUpperLeg', 'x', 0.6], ['leftLowerLeg', 'x', 0.5], ['rightLowerLeg', 'x', 0.9]] },
    { name: 'stride right', turns: [...armsDown, ['leftUpperLeg', 'x', 0.6], ['rightUpperLeg', 'x', -0.6], ['leftLowerLeg', 'x', 0.9], ['rightLowerLeg', 'x', 0.5]] },
    { name: 'sitting', turns: [...armsDown, ['leftUpperLeg', 'x', -1.4], ['rightUpperLeg', 'x', -1.4], ['leftLowerLeg', 'x', 1.5], ['rightLowerLeg', 'x', 1.5]] },
    { name: 'arms up', turns: [['leftUpperArm', 'z', 0.9], ['rightUpperArm', 'z', -0.9]] },
    { name: 'reaching forward', turns: [['leftUpperArm', 'y', -1.2], ['rightUpperArm', 'y', 1.2]] },
  ];
})();

/** How far out a body vertex may sit before it shows through; how far out from the skin cloth
 *  covers it (a loose sleeve, a skirt, a boxy jacket's side); how deep under the skin the check
 *  looks for cloth it came out through. */
export const CLIP_TOLERANCE = 0.003;
export const CLIP_REACH = 0.1;
export const CLIP_DEPTH = 0.03;
/** Skin with the body's own surface this close in front of it, in a pose, is inside a fold (the
 *  crotch in a deep seat, the chest's side under an arm held down): nothing there can show. */
export const FOLD_REACH = 0.03;
/** Along the garment's openings (collar, cuffs, hem) the body passing in front is a lap or a bent
 *  arm in front of a hem, not skin through cloth: garment points this near an opening are not
 *  compared. */
export const EDGE_ZONE = 0.03;

interface Skinned {
  /** Vertex positions in the mesh's bind space, three per vertex. */
  positions: Float32Array;
  /** Four joints (indices into `matrices`) and weights per vertex. */
  joints: Uint16Array;
  weights: Float32Array;
  triangles: Uint32Array;
}

/** A standard body ready to pose: its skin's primitive (the body, not its eyes or brows) and skeleton. */
export interface KitBody {
  name: BodyKit;
  doc: Document;
  /** The skin's joints and their inverse bind matrices. */
  joints: Node[];
  inverseBinds: M4[];
  humanoid: Map<string, Node>;
  body: Skinned;
  /** Each body vertex's region (by the bone that moves it most), if any. */
  regions: Array<Region | undefined>;
}

function skinned(prim: Primitive, remap: (joint: number) => number): Skinned {
  const pos = prim.getAttribute('POSITION')!;
  const j0 = prim.getAttribute('JOINTS_0')!;
  const w0 = prim.getAttribute('WEIGHTS_0')!;
  const n = pos.getCount();
  const positions = new Float32Array(n * 3);
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const p: number[] = [];
  const j: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p);
    j0.getElement(i, j);
    w0.getElement(i, w);
    positions.set(p.slice(0, 3), i * 3);
    for (let k = 0; k < 4; k++) {
      joints[i * 4 + k] = remap(j[k]!);
      weights[i * 4 + k] = w[k]!;
    }
  }
  const idx = prim.getIndices();
  const triangles = idx ? Uint32Array.from(idx.getArray() ?? []) : Uint32Array.from({ length: n }, (_, i) => i);
  return { positions, joints, weights, triangles };
}

/** A kit's body (kits/bodies/<name>/<name>.vrm, read with its VRM data). */
export function kitBody(name: BodyKit, doc: Document, data: VRMData): KitBody {
  const node = doc.getRoot().listNodes().find((n) => n.getMesh() && n.getSkin());
  if (!node) throw new Error(`${name}: no skinned mesh`);
  const skin = node.getSkin()!;
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices()!;
  const inverseBinds = joints.map((_, k) => ibm.getElement(k, []) as M4);
  const prim = node.getMesh()!.listPrimitives().find((p) => (p.getMaterial()?.getName() ?? '').endsWith('.body')) ?? node.getMesh()!.listPrimitives()[0]!;
  const body = skinned(prim, (k) => k);
  const regions: Array<Region | undefined> = [];
  for (let v = 0; v < body.positions.length / 3; v++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (body.weights[v * 4 + k]! > body.weights[v * 4 + best]!) best = k;
    regions.push(regionOfBone(joints[body.joints[v * 4 + best]!]!.getName()));
  }
  return { name, doc, joints, inverseBinds, humanoid: data.humanBones(), body, regions };
}

/** A fit's mesh, its joints mapped onto the kit's by name, with the fit's own inverse binds. */
export function fitOnKit(kit: KitBody, node: Node): { mesh: Skinned; inverseBinds: M4[] } {
  const skin = node.getSkin()!;
  const names = new Map(kit.joints.map((j, k) => [j.getName(), k]));
  const fitJoints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices()!;
  const map = fitJoints.map((j) => {
    const k = names.get(j.getName());
    if (k === undefined) throw new Error(`the fit's joint ${j.getName()} is not one of the kit's bones`);
    return k;
  });
  const inverseBinds: M4[] = new Array(kit.joints.length);
  fitJoints.forEach((_, k) => (inverseBinds[map[k]!] = ibm.getElement(k, []) as M4));
  const meshes = node.getMesh()!.listPrimitives().map((p) => skinned(p, (k) => map[k]!));
  // One mesh of all the fit's primitives.
  const count = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  const all: Skinned = { positions: new Float32Array(count * 3), joints: new Uint16Array(count * 4), weights: new Float32Array(count * 4), triangles: new Uint32Array(meshes.reduce((n, m) => n + m.triangles.length, 0)) };
  let v = 0;
  let t = 0;
  for (const m of meshes) {
    all.positions.set(m.positions, v * 3);
    all.joints.set(m.joints, v * 4);
    all.weights.set(m.weights, v * 4);
    for (let i = 0; i < m.triangles.length; i++) all.triangles[t + i] = m.triangles[i]! + v;
    v += m.positions.length / 3;
    t += m.triangles.length;
  }
  return { mesh: all, inverseBinds };
}

/** Positions of a skinned mesh posed: each vertex by its joints' (posed world × inverse bind). */
function pose(mesh: Skinned, worlds: readonly M4[], inverseBinds: readonly M4[]): Float32Array {
  const m = worlds.map((w, k) => (inverseBinds[k] ? mul(w, inverseBinds[k]!) : undefined));
  const out = new Float32Array(mesh.positions.length);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const [x, y, z] = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
    let [px, py, pz, total] = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = mesh.weights[v * 4 + k]!;
      const mat = m[mesh.joints[v * 4 + k]!];
      if (w <= 0 || !mat) continue;
      const p = apply(mat, x, y, z);
      px += p[0] * w;
      py += p[1] * w;
      pz += p[2] * w;
      total += w;
    }
    out.set(total > 0 ? [px / total, py / total, pz / total] : [x, y, z], v * 3);
  }
  return out;
}

/** Vertex normals from the triangles (area-weighted), unit length. */
function normals(p: Float32Array, tri: Uint32Array): Float32Array {
  const n = new Float32Array(p.length);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const [a, b, c] = [tri[t]! * 3, tri[t + 1]! * 3, tri[t + 2]! * 3];
    const [ux, uy, uz] = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const [vx, vy, vz] = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const i of [a, b, c]) {
      n[i]! += nx;
      n[i + 1]! += ny;
      n[i + 2]! += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i]! /= len;
    n[i + 1]! /= len;
    n[i + 2]! /= len;
  }
  return n;
}

/** The fit's vertices within EDGE_ZONE of an open edge (one used by a single triangle: its collar,
 *  cuffs and hem), measured at rest. */
function edgeZone(tri: Uint32Array, p: Float32Array): Set<number> {
  const border = borderVertices(tri, p);
  const cell = (x: number): number => Math.floor(x / EDGE_ZONE);
  const grid = new Map<string, number[]>();
  for (const i of border) {
    const key = `${cell(p[i * 3]!)},${cell(p[i * 3 + 1]!)},${cell(p[i * 3 + 2]!)}`;
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(i);
  }
  const zone = new Set<number>();
  for (let v = 0; v < p.length / 3; v++) {
    const [x, y, z] = [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of grid.get(`${cell(x) + dx},${cell(y) + dy},${cell(z) + dz}`) ?? []) {
        if ((p[i * 3]! - x) ** 2 + (p[i * 3 + 1]! - y) ** 2 + (p[i * 3 + 2]! - z) ** 2 < EDGE_ZONE * EDGE_ZONE) {
          zone.add(v);
          break search;
        }
      }
    }
  }
  return zone;
}

/** The fit's vertices on open edges (used by one triangle): its collar, cuffs and hem. */
function borderVertices(tri: Uint32Array, p: Float32Array): Set<number> {
  // Vertices split for UVs share a place: edges are counted between places, not indices.
  const place = new Map<string, number>();
  const at = (i: number): number => {
    const key = `${p[i * 3]!.toFixed(5)},${p[i * 3 + 1]!.toFixed(5)},${p[i * 3 + 2]!.toFixed(5)}`;
    let id = place.get(key);
    if (id === undefined) place.set(key, (id = place.size));
    return id;
  };
  const ids = Array.from({ length: p.length / 3 }, (_, i) => at(i));
  const edges = new Map<string, number>();
  for (let t = 0; t + 2 < tri.length; t += 3) {
    for (const [a, b] of [[tri[t]!, tri[t + 1]!], [tri[t + 1]!, tri[t + 2]!], [tri[t + 2]!, tri[t]!]] as const) {
      const [x, y] = [ids[a]!, ids[b]!];
      const key = x < y ? `${x}:${y}` : `${y}:${x}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const onBorder = new Set<number>();
  for (const [key, count] of edges) if (count === 1) for (const id of key.split(':')) onBorder.add(Number(id));
  return new Set(ids.flatMap((id, i) => (onBorder.has(id) ? [i] : [])));
}

/** The local matrices an avatar's proportions give its joints, as the client moves them (S4.10):
 *  the arms' and legs' lower joints along their bone, the shoulders and hips sideways, the head
 *  scaled. */
export function shapedLocals(humanoid: ReadonlyMap<string, Node>, shape: ProportionShares): Map<Node, M4> {
  const out = new Map<Node, M4>();
  const move = (bone: string, change: (m: M4) => void): void => {
    const n = humanoid.get(bone);
    if (!n) return;
    const m = [...(out.get(n) ?? (n.getMatrix() as unknown as M4))];
    change(m);
    out.set(n, m);
  };
  for (const kind of ['arms', 'legs'] as const) {
    for (const bone of PROPORTION_JOINTS[kind]) {
      move(bone, (m) => {
        for (const i of [12, 13, 14]) m[i] = m[i]! * shape[kind];
      });
    }
  }
  for (const bone of PROPORTION_JOINTS.width) move(humanoid.has(bone) ? bone : (WIDTH_FALLBACK[bone] ?? bone), (m) => (m[12] = m[12]! * shape.width));
  move('head', (m) => {
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i] = m[i]! * shape.head;
  });
  return out;
}

/** Each limb bone's stretch along itself for a shape (the client's rule), by its index among the
 *  kit's joints: what its skinning matrix is multiplied by, in its own frame. */
export function segmentStretch(kit: KitBody, shape: ProportionShares): Map<number, M4> {
  const out = new Map<number, M4>();
  for (const kind of ['arms', 'legs'] as const) {
    if (shape[kind] === 1) continue;
    for (const [from, to] of PROPORTION_SEGMENTS[kind]) {
      const bone = kit.humanoid.get(from);
      const next = kit.humanoid.get(to);
      const k = bone ? kit.joints.indexOf(bone) : -1;
      if (!bone || !next || k < 0) continue;
      // The next joint in the bone's own frame, at rest.
      const w = next.getWorldMatrix() as unknown as M4;
      const [x, y, z] = apply(invert(bone.getWorldMatrix() as unknown as M4), w[12]!, w[13]!, w[14]!);
      const len = Math.hypot(x, y, z);
      if (len > 1e-6) out.set(k, stretchAlong([x / len, y / len, z / len], shape[kind]));
    }
  }
  return out;
}

/** A pose's name, with the proportions it was checked at when not as made. */
function poseName(name: string, shape: ProportionShares): string {
  const shares = [shape.width, shape.arms, shape.legs, shape.head];
  if (shares.every((v) => v === 1)) return name;
  const pc = (v: number): string => `${Math.round(v * 100)} %`;
  return shares.every((v) => v === shares[0]) ? `${name} at ${pc(shares[0]!)}` : `${name} at width ${pc(shape.width)}, arms ${pc(shape.arms)}, legs ${pc(shape.legs)}, head ${pc(shape.head)}`;
}

export interface ClippingOptions {
  /** Each body point found out through the garment: the pose, its region, how far out, and which
   *  body vertex it is and which of the fit's triangles it came through (fitOnKit's numbering). */
  detail?: (pose: string, region: Region | undefined, outMm: number, at: { vertex: number; triangle: number }) => void;
  /** The proportions to check at, each in every reference pose (as made, when left out). The first
   *  one's T-pose says what the garment covers. */
  shapes?: readonly ProportionShares[];
}

/** A grid of triangles, each in every cell its bounds touch, for rays a few centimetres long. */
export class TriangleGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly p: Float32Array;
  private readonly tri: Uint32Array;
  private readonly size: number;
  private readonly seen: Int32Array;
  private query = 0;
  /** The triangle the last hit met, and where on it (the weights of its second and third corners). */
  met = -1;
  metU = 0;
  metV = 0;
  constructor(p: Float32Array, tri: Uint32Array, size: number, skip: (t: number) => boolean) {
    this.p = p;
    this.tri = tri;
    this.size = size;
    this.seen = new Int32Array(tri.length / 3);
    for (let t = 0; t < tri.length / 3; t++) {
      if (skip(t)) continue;
      const [a, b, c] = [tri[t * 3]! * 3, tri[t * 3 + 1]! * 3, tri[t * 3 + 2]! * 3];
      const lo = [0, 1, 2].map((i) => this.cell(Math.min(p[a + i]!, p[b + i]!, p[c + i]!)));
      const hi = [0, 1, 2].map((i) => this.cell(Math.max(p[a + i]!, p[b + i]!, p[c + i]!)));
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const key = TriangleGrid.key(x, y, z);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(t);
      }
    }
  }
  private cell(v: number): number {
    return Math.floor(v / this.size);
  }
  private static key(x: number, y: number, z: number): number {
    return (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
  }
  /** The nearest distance along the ray from (ox, oy, oz) in direction d (unit), between `from` and
   *  `length`, at which it meets a triangle whose front faces the way f does; -1 when it meets none. */
  hit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, length: number, fx: number, fy: number, fz: number, from = 0): number {
    const { p, tri, seen } = this;
    const q = ++this.query;
    const [ex, ey, ez] = [ox + dx * length, oy + dy * length, oz + dz * length];
    let best = -1;
    for (let x = this.cell(Math.min(ox, ex)); x <= this.cell(Math.max(ox, ex)); x++) {
      for (let y = this.cell(Math.min(oy, ey)); y <= this.cell(Math.max(oy, ey)); y++) {
        for (let z = this.cell(Math.min(oz, ez)); z <= this.cell(Math.max(oz, ez)); z++) {
          for (const t of this.cells.get(TriangleGrid.key(x, y, z)) ?? []) {
            if (seen[t] === q) continue;
            seen[t] = q;
            const [a, b, c] = [tri[t * 3]! * 3, tri[t * 3 + 1]! * 3, tri[t * 3 + 2]! * 3];
            const [ux, uy, uz] = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
            const [vx, vy, vz] = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
            // Its front (by its winding) must face the way the skin does (any way, for (0, 0, 0)).
            if ((fx !== 0 || fy !== 0 || fz !== 0) && (uy * vz - uz * vy) * fx + (uz * vx - ux * vz) * fy + (ux * vy - uy * vx) * fz <= 0) continue;
            // Möller–Trumbore.
            const [hx, hy, hz] = [dy * vz - dz * vy, dz * vx - dx * vz, dx * vy - dy * vx];
            const det = ux * hx + uy * hy + uz * hz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det;
            const [sx, sy, sz] = [ox - p[a]!, oy - p[a + 1]!, oz - p[a + 2]!];
            const u = (sx * hx + sy * hy + sz * hz) * inv;
            if (u < 0 || u > 1) continue;
            const [kx, ky, kz] = [sy * uz - sz * uy, sz * ux - sx * uz, sx * uy - sy * ux];
            const v = (dx * kx + dy * ky + dz * kz) * inv;
            if (v < 0 || u + v > 1) continue;
            const d = (vx * kx + vy * ky + vz * kz) * inv;
            if (d >= from && d <= length && (best < 0 || d < best)) {
              best = d;
              this.met = t;
              this.metU = u;
              this.metV = v;
            }
          }
        }
      }
    }
    return best;
  }
}

/** The check. At rest, every body point the item does not hide that the garment covers (cloth
 *  facing its way just outside it, away from the garment's openings) or that came out through it
 *  (such cloth just under the skin) is a point of the garment's; out through it by more than the
 *  tolerance, it counts: a garment made inside the body fails here. Then, in every other reference
 *  pose, each such point must stay under it: skin it covers without hiding must not come out
 *  through it. A point the garment never covered (a thigh below a tee's hem, a hand past a cuff) is
 *  another part of the body, not clipping; a point inside a fold of the body is hidden by it, and
 *  one where the body crosses itself is the body's own overlap. */
export function clippingOf(kit: KitBody, fitNode: Node, hides: readonly Region[], o: ClippingOptions = {}): ItemClipping {
  const { mesh, inverseBinds } = fitOnKit(kit, fitNode);
  const hidden = new Set(hides);
  const visible = kit.regions.map((r) => r !== undefined && !hidden.has(r));
  // At rest, in world space: the fit's positions are in its bind space, so skin them with no turn.
  const restWorlds = kit.joints.map((j) => j.getWorldMatrix() as unknown as M4);
  const edge = edgeZone(mesh.triangles, pose(mesh, restWorlds, inverseBinds));
  const nearOpening = (t: number): boolean => edge.has(mesh.triangles[t * 3]!) || edge.has(mesh.triangles[t * 3 + 1]!) || edge.has(mesh.triangles[t * 3 + 2]!);
  const shapes = o.shapes ?? [PROPORTIONS_AS_MADE];
  let checked = 0;
  let through = 0;
  let worst = 0;
  let covered: Set<number> | undefined;
  for (const shape of shapes) {
    const locals = shapedLocals(kit.humanoid, shape);
    const stretch = segmentStretch(kit, shape);
    for (const { name, turns } of REFERENCE_POSES) {
      const posed = poseMatrices(kit.joints, kit.humanoid, turns, locals);
      // poseMatrices gives posed × rest⁻¹; the skin wants posed world, so put the rest world back,
      // and a limb's stretch in its own frame.
      const worlds = posed.map((m, k) => {
        const w = mul(m, kit.joints[k]!.getWorldMatrix() as unknown as M4);
        const s = stretch.get(k);
        return s ? mul(w, s) : w;
      });
      const body = pose(kit.body, worlds, kit.inverseBinds);
      const bodyNormals = normals(body, kit.body.triangles);
      const grid = new TriangleGrid(pose(mesh, worlds, inverseBinds), mesh.triangles, CLIP_DEPTH, nearOpening);
      const self = new TriangleGrid(body, kit.body.triangles, FOLD_REACH, () => false);
      const atRest = covered === undefined;
      const mine = new Set<number>();
      for (let v = 0; v < body.length / 3; v++) {
        if (!visible[v] || (!atRest && !covered!.has(v))) continue;
        const [x, y, z] = [body[v * 3]!, body[v * 3 + 1]!, body[v * 3 + 2]!];
        const [nx, ny, nz] = [bodyNormals[v * 3]!, bodyNormals[v * 3 + 1]!, bodyNormals[v * 3 + 2]!];
        let out = 0;
        if (grid.hit(x, y, z, nx, ny, nz, CLIP_REACH, nx, ny, nz) < 0) {
          const depth = grid.hit(x, y, z, -nx, -ny, -nz, CLIP_DEPTH, nx, ny, nz);
          if (depth < 0) continue;
          out = depth;
        }
        checked += 1;
        if (atRest) mine.add(v);
        // In a fold the body hides it; where the body crosses itself (another part's skin just under
        // it, facing out: a limb shortened at the sliders' end telescoped into its neighbour, the
        // thighs into the belly in a deep seat) the body's own overlap shows, which no garment covers.
        if (out > CLIP_TOLERANCE && (self.hit(x, y, z, nx, ny, nz, FOLD_REACH, 0, 0, 0, 0.001) >= 0 || self.hit(x, y, z, -nx, -ny, -nz, CLIP_DEPTH, nx, ny, nz, 0.001) >= 0)) continue;
        if (out > CLIP_TOLERANCE) {
          through += 1;
          o.detail?.(poseName(name, shape), kit.regions[v], Math.round(out * 10000) / 10, { vertex: v, triangle: grid.met });
        }
        worst = Math.max(worst, out);
      }
      if (atRest) covered = mine;
    }
  }
  return { poses: shapes.length * REFERENCE_POSES.length, checked, through, worstMm: Math.round(worst * 10000) / 10 };
}

/** What share of each region's vertices a fit covers at rest (cloth facing the way the skin does
 *  within reach outside it, or just under it where the cloth dips into the skin): a region it covers
 *  wholly may be hidden under it without a hole. */
export function coverageOf(kit: KitBody, fitNode: Node): Partial<Record<Region, number>> {
  const { mesh, inverseBinds } = fitOnKit(kit, fitNode);
  const restWorlds = kit.joints.map((j) => j.getWorldMatrix() as unknown as M4);
  const body = pose(kit.body, restWorlds, kit.inverseBinds);
  const bodyNormals = normals(body, kit.body.triangles);
  const grid = new TriangleGrid(pose(mesh, restWorlds, inverseBinds), mesh.triangles, CLIP_DEPTH, () => false);
  const total = new Map<Region, number>();
  const under = new Map<Region, number>();
  for (let v = 0; v < body.length / 3; v++) {
    const r = kit.regions[v];
    if (!r) continue;
    total.set(r, (total.get(r) ?? 0) + 1);
    const [nx, ny, nz] = [bodyNormals[v * 3]!, bodyNormals[v * 3 + 1]!, bodyNormals[v * 3 + 2]!];
    const [x, y, z] = [body[v * 3]!, body[v * 3 + 1]!, body[v * 3 + 2]!];
    if (grid.hit(x, y, z, nx, ny, nz, CLIP_REACH, nx, ny, nz) >= 0 || grid.hit(x, y, z, -nx, -ny, -nz, CLIP_DEPTH, nx, ny, nz) >= 0) under.set(r, (under.get(r) ?? 0) + 1);
  }
  return Object.fromEntries([...total].map(([r, n]) => [r, (under.get(r) ?? 0) / n]));
}

/** The trunk and leg joints: where a body's proportions show, and which A-pose and T-pose share. */
export const SHAPE_JOINTS = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r'];

/** How far, in metres, the fit's skeleton sits from the kit's at its trunk and leg joints, both in
 *  their bind pose (from the inverse binds: the kits' VRMs rest in a T-pose with straightened legs,
 *  but their meshes are bound as the .blend stands, as a creator's fit is): a fit made on another
 *  body is off by centimetres (the bodies stand 1.56, 1.78 and 1.64 m tall). */
export function skeletonOffset(kit: KitBody, fitNode: Node): number {
  const skin = fitNode.getSkin()!;
  const ibm = skin.getInverseBindMatrices()!;
  const kitAt = new Map(kit.joints.map((j, k) => {
    const m = invert(kit.inverseBinds[k]!);
    return [j.getName(), [m[12]!, m[13]!, m[14]!] as const];
  }));
  let worst = 0;
  skin.listJoints().forEach((j, k) => {
    if (!SHAPE_JOINTS.includes(j.getName())) return;
    const bind = invert(ibm.getElement(k, []) as M4);
    const at = kitAt.get(j.getName());
    if (!at) return;
    worst = Math.max(worst, Math.hypot(bind[12]! - at[0], bind[13]! - at[1], bind[14]! - at[2]));
  });
  return worst;
}
