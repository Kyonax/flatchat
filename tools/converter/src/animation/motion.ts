// SPDX-License-Identifier: MPL-2.0
// A motion as every source format reads into it (S5.07): a skeleton of joints (each with its parent,
// its rest offset and rest rotation from the parent), sampled at a fixed rate: each joint's local
// rotation per frame and the root's local translation per frame. BVH, glTF clips and VRMA all
// become this, then retarget.ts turns it into the humanoid VRMA writes.
import { IDENTITY, type Quat, qmul, qrot, type Vec3, vadd } from './quat.ts';

export interface Joint {
  name: string;
  /** Index of the parent joint, or -1 for a root. */
  parent: number;
  /** Translation from the parent at rest. */
  offset: Vec3;
  /** Rotation from the parent at rest. */
  rest: Quat;
}

export interface Motion {
  joints: Joint[];
  fps: number;
  frames: number;
  /** Per joint, frames × 4 (local rotations; the rest rotation where a joint is not animated). */
  rotations: Float64Array[];
  /** The root's local translation per frame, frames × 3 (its rest offset where it is not animated). */
  root: number;
  translations: Float64Array;
}

export class MotionError extends Error {}

/** Each joint's world rotation and position from local rotations and the root's translation. */
export function worldPose(joints: readonly Joint[], local: (j: number) => Quat, rootAt: Vec3, root: number): { rot: Quat[]; pos: Vec3[] } {
  const rot: Quat[] = [];
  const pos: Vec3[] = [];
  for (let j = 0; j < joints.length; j++) {
    const p = joints[j]!.parent;
    // Joints are in parent-first order (every reader keeps them so).
    if (p < 0) {
      rot[j] = local(j);
      pos[j] = j === root ? rootAt : joints[j]!.offset;
    } else {
      rot[j] = qmul(rot[p]!, local(j));
      pos[j] = vadd(pos[p]!, qrot(rot[p]!, joints[j]!.offset));
    }
  }
  return { rot, pos };
}

/** The skeleton standing at rest. */
export function restPose(m: Motion): { rot: Quat[]; pos: Vec3[] } {
  return worldPose(m.joints, (j) => m.joints[j]!.rest, m.joints[m.root]!.offset, m.root);
}

/** The skeleton in one frame. */
export function framePose(m: Motion, f: number): { rot: Quat[]; pos: Vec3[] } {
  const at = (j: number): Quat => {
    const r = m.rotations[j]!;
    return [r[f * 4]!, r[f * 4 + 1]!, r[f * 4 + 2]!, r[f * 4 + 3]!];
  };
  const t = m.translations;
  return worldPose(m.joints, at, [t[f * 3]!, t[f * 3 + 1]!, t[f * 3 + 2]!], m.root);
}

/** Puts joints in parent-first order (a reader's joints may come in any), keeping names. */
export function parentFirst(joints: Joint[]): { joints: Joint[]; order: number[] } {
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (j: number): void => {
    if (seen.has(j)) return;
    const p = joints[j]!.parent;
    if (p >= 0) visit(p);
    seen.add(j);
    order.push(j);
  };
  for (let j = 0; j < joints.length; j++) visit(j);
  const index = new Map(order.map((old, i) => [old, i]));
  return { joints: order.map((old) => ({ ...joints[old]!, parent: joints[old]!.parent < 0 ? -1 : index.get(joints[old]!.parent)! })), order };
}

/** A track filled with one rotation. */
export function constantRotations(q: Quat, frames: number): Float64Array {
  const out = new Float64Array(frames * 4);
  for (let f = 0; f < frames; f++) out.set(q, f * 4);
  return out;
}

export { IDENTITY };
