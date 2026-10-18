// SPDX-License-Identifier: MPL-2.0
// S5.02's no-clipping check: an item's fit worn on its body in the reference poses. Both are posed
// with the body's own skeleton (the fit by its joints' names); a body vertex the item does not hide
// that sits within reach of the garment must stay under it, never out through it. A fit made on
// another body, or too tight, shows as body vertices out through the garment.
import type { Document, Node, Primitive } from '@gltf-transform/core';
import { type BodyKit, type ItemClipping, type Region, regionOfBone } from '@flatchat/content';
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

/** How far out a body vertex may sit before it shows through, and how far the check looks. */
export const CLIP_TOLERANCE = 0.003;
export const CLIP_REACH = 0.025;
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

/** The check. At rest, every body point the item does not hide that lies within reach of the
 *  garment (away from its openings) must be under it: a garment made inside the body fails here.
 *  Then, in every other reference pose, each such point under the garment at rest must stay under
 *  it: skin it covers without hiding must not come out through it. A point that was never under
 *  the garment (a thigh below a tee's hem) is another part of the body, not clipping. */
export function clippingOf(kit: KitBody, fitNode: Node, hides: readonly Region[], detail?: (pose: string, region: Region | undefined, outMm: number) => void): ItemClipping {
  const { mesh, inverseBinds } = fitOnKit(kit, fitNode);
  const hidden = new Set(hides);
  const visible = kit.regions.map((r) => r !== undefined && !hidden.has(r));
  // At rest, in world space: the fit's positions are in its bind space, so skin them with no turn.
  const restWorlds = kit.joints.map((j) => j.getWorldMatrix() as unknown as M4);
  const edge = edgeZone(mesh.triangles, pose(mesh, restWorlds, inverseBinds));
  let checked = 0;
  let through = 0;
  let worst = 0;
  let covered: Set<number> | undefined;
  for (const { name, turns } of REFERENCE_POSES) {
    const posed = poseMatrices(kit.joints, kit.humanoid, turns);
    // poseMatrices gives posed × rest⁻¹; the skin wants posed world, so put the rest world back.
    const worlds = posed.map((m, k) => mul(m, kit.joints[k]!.getWorldMatrix() as unknown as M4));
    const body = pose(kit.body, worlds, kit.inverseBinds);
    const cloth = pose(mesh, worlds, inverseBinds);
    const clothNormals = normals(cloth, mesh.triangles);
    const cell = (x: number): number => Math.floor(x / CLIP_REACH);
    const grid = new Map<string, number[]>();
    for (let i = 0; i < cloth.length / 3; i++) {
      if (edge.has(i)) continue;
      const key = `${cell(cloth[i * 3]!)},${cell(cloth[i * 3 + 1]!)},${cell(cloth[i * 3 + 2]!)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    }
    const atRest = covered === undefined;
    const under = new Set<number>();
    for (let v = 0; v < body.length / 3; v++) {
      if (!visible[v] || (!atRest && !covered!.has(v))) continue;
      const [x, y, z] = [body[v * 3]!, body[v * 3 + 1]!, body[v * 3 + 2]!];
      let best = -1;
      let bestD = CLIP_REACH * CLIP_REACH;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const i of grid.get(`${cell(x) + dx},${cell(y) + dy},${cell(z) + dz}`) ?? []) {
          const d = (cloth[i * 3]! - x) ** 2 + (cloth[i * 3 + 1]! - y) ** 2 + (cloth[i * 3 + 2]! - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best < 0) continue;
      checked += 1;
      const out = (x - cloth[best * 3]!) * clothNormals[best * 3]! + (y - cloth[best * 3 + 1]!) * clothNormals[best * 3 + 1]! + (z - cloth[best * 3 + 2]!) * clothNormals[best * 3 + 2]!;
      if (atRest && out <= 0) under.add(v);
      if (out > CLIP_TOLERANCE) {
        through += 1;
        detail?.(name, kit.regions[v], Math.round(out * 10000) / 10);
      }
      worst = Math.max(worst, out);
    }
    if (atRest) covered = under;
  }
  return { poses: REFERENCE_POSES.length, checked, through, worstMm: Math.round(worst * 10000) / 10 };
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
