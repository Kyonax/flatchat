// SPDX-License-Identifier: MPL-2.0
// A stride, for checking what skinning does to a mesh (S4.12). Both thighs swing about the side
// axis at the hips, one forward and one back, with the knees bent, then the same mirrored. The
// impostor's simplifier is given every vertex's place in both, so it never joins what a walk pulls
// apart: the two legs, or a skirt and the thighs under it. Before it, a grid-merging fallback did
// exactly that, and some real avatars' impostors walked with a sheet between their legs or a
// sliver from their feet. `stretchedTriangles` counts that defect.
import type { Document, Node } from '@gltf-transform/core';
import { apply, invert, type M4, mul, rotationOf, transposed, turnX, turnY, turnZ } from './matrix.ts';

/** The two strides: turns about the side (X) axis in radians, at the hips and the knees. VRM 1.0
 *  faces +Z, so a negative turn swings a leg forward and a positive one bends a knee back. */
export const STRIDES: ReadonlyArray<Readonly<Record<string, number>>> = [
  { leftUpperLeg: -0.6, rightUpperLeg: 0.6, leftLowerLeg: 0.5, rightLowerLeg: 0.9 },
  { leftUpperLeg: 0.6, rightUpperLeg: -0.6, leftLowerLeg: 0.9, rightLowerLeg: 0.5 },
];

/** A turn of a humanoid bone about a world axis at its joint, in radians (VRM 1.0 faces +Z, its
 *  left hand at +X). */
export type Turn = readonly [bone: string, axis: 'x' | 'y' | 'z', angle: number];

/** Each of `bones`' skinning matrices in a pose (its posed world matrix × its rest world
 *  matrix⁻¹), the turns applied down the hierarchy. `humanoid` names the humanoid's nodes. */
export function poseMatrices(bones: readonly Node[], humanoid: ReadonlyMap<string, Node>, turns: readonly Turn[]): M4[] {
  const rest = (n: Node): M4 => n.getWorldMatrix() as unknown as M4;
  const turnOf = new Map<Node, M4>();
  for (const [name, axis, angle] of turns) {
    const n = humanoid.get(name);
    if (!n) continue;
    const t = axis === 'x' ? turnX(angle) : axis === 'y' ? turnY(angle) : turnZ(angle);
    turnOf.set(n, turnOf.has(n) ? mul(t, turnOf.get(n)!) : t);
  }
  const posed = new Map<Node, M4>();
  const worldOf = (n: Node): M4 => {
    const known = posed.get(n);
    if (known) return known;
    const parent = n.getParentNode();
    const local = n.getMatrix() as unknown as M4;
    let w = parent ? mul(worldOf(parent), local) : local;
    const t = turnOf.get(n);
    if (t) {
      // The turn about a world axis at this joint, written in the joint's own frame.
      const r = rotationOf(rest(n));
      w = mul(w, mul(transposed(r), mul(t, r)));
    }
    posed.set(n, w);
    return w;
  };
  return bones.map((b) => mul(worldOf(b), invert(rest(b))));
}

/** For each stride, each of `bones`' skinning matrices. */
export function strideMatrices(bones: readonly Node[], humanoid: ReadonlyMap<string, Node>): M4[][] {
  return STRIDES.map((turns) => poseMatrices(bones, humanoid, Object.entries(turns).map(([bone, a]) => [bone, 'x', a] as const)));
}

/** Rest positions (world space) skinned by four joints and weights a vertex, with `matrices`. */
export function posePositions(positions: ArrayLike<number>, joints: ArrayLike<number>, weights: ArrayLike<number>, matrices: readonly M4[]): Float32Array {
  const out = new Float32Array(positions.length);
  for (let v = 0; v < positions.length / 3; v++) {
    const [x, y, z] = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    let total = 0;
    let [px, py, pz] = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]!;
      const m = matrices[joints[v * 4 + k]!];
      if (w <= 0 || !m) continue;
      const p = apply(m, x, y, z);
      px += p[0] * w;
      py += p[1] * w;
      pz += p[2] * w;
      total += w;
    }
    if (total === 0) out.set([x, y, z], v * 3);
    else out.set([px / total, py / total, pz / total], v * 3);
  }
  return out;
}

const longest = (p: ArrayLike<number>, i: ArrayLike<number>, t: number): number => {
  const d = (a: number, b: number): number => Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!);
  return Math.max(d(i[t]!, i[t + 1]!), d(i[t + 1]!, i[t + 2]!), d(i[t + 2]!, i[t]!));
};

/** The triangles a stride stretches: in some pose, the longest edge both twice as long and 10 cm
 *  longer than at rest. A walk barely stretches a well-made mesh; a triangle across two limbs it
 *  pulls into a sheet. */
export function stretchedTriangles(rest: ArrayLike<number>, indices: ArrayLike<number>, poses: readonly ArrayLike<number>[]): number {
  let n = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const before = longest(rest, indices, t);
    if (poses.some((p) => {
      const after = longest(p, indices, t);
      return after > before * 2 && after - before > 0.1;
    })) n += 1;
  }
  return n;
}

/** A converted level's impostor (its one skinned mesh): its triangles and how many a stride
 *  stretches. For tests and audits (scripts/impostor-audit.ts). */
export function impostorStretch(doc: Document, humanoid: ReadonlyMap<string, Node>): { triangles: number; stretched: number } {
  const holder = doc.getRoot().listNodes().find((n) => n.getMesh() && n.getSkin());
  const prim = holder?.getMesh()?.listPrimitives()[0];
  const pos = prim?.getAttribute('POSITION');
  const j0 = prim?.getAttribute('JOINTS_0');
  const w0 = prim?.getAttribute('WEIGHTS_0');
  if (!holder || !prim || !pos || !j0 || !w0) return { triangles: 0, stretched: 0 };
  const at = holder.getWorldMatrix() as unknown as M4;
  const rest: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const el: number[] = [];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, el);
    rest.push(...apply(at, el[0]!, el[1]!, el[2]!));
    joints.push(...(j0.getElement(i, []) as number[]).slice(0, 4));
    weights.push(...(w0.getElement(i, []) as number[]).slice(0, 4));
  }
  const idx = prim.getIndices();
  const indices = idx ? Array.from(idx.getArray() ?? []) : Array.from({ length: pos.getCount() }, (_, i) => i);
  const poses = strideMatrices(holder.getSkin()!.listJoints(), humanoid).map((m) => posePositions(rest, joints, weights, m));
  return { triangles: indices.length / 3, stretched: stretchedTriangles(rest, indices, poses) };
}
