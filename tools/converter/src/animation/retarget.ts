// SPDX-License-Identifier: MPL-2.0
// A motion onto VRM 1.0's normalized humanoid (S5.07): what VRMA carries and three-vrm-animation
// plays on any avatar. In the normalized humanoid every bone rests unrotated in a T-pose (Y up,
// facing +Z, the left hand at +X), so a bone's rotation at a moment is how far its source bone has
// turned in the world from the source's own T-pose, taken relative to its humanoid parent's turn.
//
// The source is first stood up (a Z-up rig turned to Y up) and turned to face +Z, and its rest is
// made a T-pose: a limb that rests lowered (an A-pose, as MakeHuman's, many VRoid and Blender rigs)
// is raised to the T-pose in the reference, so its moves are measured from where VRM's rest is.
// Positions are scaled so the feet rest on the floor and the hips stand where the source's did, in
// metres; three-vrm-animation scales the hips' travel to each avatar's own hips.
import { ANIMATION_FPS } from '@flatchat/content';
import { HUMAN_BONES } from '../avatar/humanoid.ts';
import { framePose, type Motion, restPose } from './motion.ts';
import { IDENTITY, type Quat, qangle, qcanon, qfromTo, qinv, qmul, qnorm, qrot, type Vec3, vadd, vangle, vlen, vnorm, vscale, vsub } from './quat.ts';

export interface Humanoid {
  /** The human bones present, parents first (HUMAN_BONES order). */
  bones: string[];
  /** Each bone's nearest present humanoid ancestor (null for the hips). */
  parent: Array<string | null>;
  /** Each bone's T-pose offset from that ancestor, in metres (the hips': its place over the floor). */
  offsets: Vec3[];
  /** Per bone, frames × 4: its normalized local rotation. */
  rotations: Float64Array[];
  /** The hips' place per frame, frames × 3, metres. */
  hips: Float64Array;
  frames: number;
  fps: number;
  /** Bones whose rest was raised or lowered into the T-pose. */
  straightened: string[];
  /** What the conversion changed that a creator would want to know. */
  warnings: string[];
}

/** Where a limb points in VRM's T-pose. */
const T_POSE: Record<string, Vec3> = {
  leftUpperArm: [1, 0, 0],
  leftLowerArm: [1, 0, 0],
  rightUpperArm: [-1, 0, 0],
  rightLowerArm: [-1, 0, 0],
  leftUpperLeg: [0, -1, 0],
  leftLowerLeg: [0, -1, 0],
  rightUpperLeg: [0, -1, 0],
  rightLowerLeg: [0, -1, 0],
};
/** The bone a limb points at. */
const NEXT: Record<string, string> = {
  leftUpperArm: 'leftLowerArm',
  leftLowerArm: 'leftHand',
  rightUpperArm: 'rightLowerArm',
  rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg',
  leftLowerLeg: 'leftFoot',
  rightUpperLeg: 'rightLowerLeg',
  rightLowerLeg: 'rightFoot',
};
/** A limb off the T-pose by less than this is left as it is (degrees). */
const STRAIGHTEN_FROM = 4;
/** How far the hips may wander sideways from where they start, in metres: an emote stays put. */
const WANDER = 0.5;

const round = (v: number): number => Math.round(v * 1e5) / 1e5;

/** Retargets a motion whose joints `map` names as human bones (bone → joint index). */
export function retarget(m: Motion, map: ReadonlyMap<string, number>): Humanoid {
  const warnings: string[] = [];
  const present = HUMAN_BONES.filter(([b]) => map.has(b)).map(([b]) => b);
  const parentOf = new Map<string, string | null>();
  for (const [bone, parent] of HUMAN_BONES) {
    if (!map.has(bone)) continue;
    // The nearest present ancestor: a missing chest makes the spine the shoulders' parent.
    let p = parent;
    while (p && !map.has(p)) p = HUMAN_BONES.find(([b]) => b === p)?.[1] ?? null;
    parentOf.set(bone, p);
  }
  const joint = (b: string): number => map.get(b)!;

  // ------------------------------------------------------------- stand it up, face it +Z
  const rest = restPose(m);
  const hipsAt = rest.pos[joint('hips')]!;
  const headAt = rest.pos[joint('head')]!;
  const up = vnorm(vsub(headAt, hipsAt));
  // The source's up, to the nearest axis.
  const axis: Vec3 = [0, 0, 0];
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(up[b]!) > Math.abs(up[a]!) ? b : a), 0);
  axis[k] = Math.sign(up[k]!) || 1;
  let world: Quat = qfromTo(axis, [0, 1, 0]);
  const side = (b: string): Vec3 => qrot(world, rest.pos[joint(b)]!);
  const left = map.has('leftUpperArm') ? side('leftUpperArm') : side('leftUpperLeg');
  const right = map.has('rightUpperArm') ? side('rightUpperArm') : side('rightUpperLeg');
  // VRM's left hand is at +X: a source with it at -X faces -Z and turns a half turn about Y.
  if (left[0] < right[0]) world = qmul([0, 1, 0, 0], world);
  if (k !== 1 || left[0] < right[0]) warnings.push(`stood up and turned to face forward (${k !== 1 ? 'a Z-up rig' : 'it faced back'})`);
  const turned = (p: { rot: Quat[]; pos: Vec3[] }): { rot: Quat[]; pos: Vec3[] } => ({ rot: p.rot.map((r) => qmul(world, r)), pos: p.pos.map((x) => qrot(world, x)) });

  // ------------------------------------------------------------- the T-pose reference
  const t = turned(rest);
  const tRot = [...t.rot];
  const tPos = [...t.pos];
  const children = new Map<number, number[]>();
  m.joints.forEach((j, i) => {
    if (j.parent >= 0) children.set(j.parent, [...(children.get(j.parent) ?? []), i]);
  });
  const subtree = (j: number): number[] => [j, ...(children.get(j) ?? []).flatMap(subtree)];
  const straightened: string[] = [];
  for (const bone of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']) {
    const next = NEXT[bone]!;
    if (!map.has(bone) || !map.has(next)) continue;
    const from = tPos[joint(bone)]!;
    const dir = vsub(tPos[joint(next)]!, from);
    if (vlen(dir) < 1e-9 || (vangle(dir, T_POSE[bone]!) * 180) / Math.PI < STRAIGHTEN_FROM) continue;
    const c = qfromTo(dir, T_POSE[bone]!);
    for (const j of subtree(joint(bone))) {
      tRot[j] = qmul(c, tRot[j]!);
      tPos[j] = vadd(from, qrot(c, vsub(tPos[j]!, from)));
    }
    straightened.push(bone);
  }

  // ------------------------------------------------------------- metres, the floor at 0
  const floor = Math.min(...present.map((b) => tPos[joint(b)]![1]));
  const hipsHeight = tPos[joint('hips')]![1] - floor;
  if (!(hipsHeight > 0)) throw new Error('the hips do not stand above the feet');
  // Units: whatever the source used, hips at the source's height when it was in metres, else at a
  // grown-up's (0.95 m): three-vrm-animation rescales the hips' travel to each avatar anyway.
  const scale = hipsHeight > 0.3 && hipsHeight < 3 ? 1 : 0.95 / hipsHeight;
  const place = (p: Vec3): Vec3 => vscale([p[0], p[1] - floor, p[2]], scale);
  const offsets = present.map((b) => {
    const p = parentOf.get(b);
    return (p ? vsub(place(tPos[joint(b)]!), place(tPos[joint(p)]!)) : place(tPos[joint(b)]!)).map(round) as Vec3;
  });

  // ------------------------------------------------------------- every frame
  const rotations = present.map(() => new Float64Array(m.frames * 4));
  const hips = new Float64Array(m.frames * 3);
  let wandered = 0;
  let start: Vec3 | undefined;
  for (let f = 0; f < m.frames; f++) {
    const pose = turned(framePose(m, f));
    const delta = new Map<string, Quat>();
    present.forEach((b, i) => {
      const j = joint(b);
      const d = qnorm(qmul(pose.rot[j]!, qinv(tRot[j]!)));
      delta.set(b, d);
      const p = parentOf.get(b);
      rotations[i]!.set(qcanon(qnorm(p ? qmul(qinv(delta.get(p)!), d) : d)), f * 4);
    });
    const at = place(pose.pos[joint('hips')]!);
    start ??= at;
    const dx = at[0] - start[0];
    const dz = at[2] - start[2];
    const far = Math.hypot(dx, dz);
    if (far > WANDER) {
      wandered = Math.max(wandered, far);
      at[0] = start[0] + (dx * WANDER) / far;
      at[2] = start[2] + (dz * WANDER) / far;
    }
    hips.set(at.map(round), f * 3);
  }
  if (wandered > 0) warnings.push(`the hips wandered ${wandered.toFixed(2)} m from where they started: kept within ${WANDER} m`);
  if (straightened.length > 0) warnings.push(`its rest was not a T-pose: ${straightened.join(', ')} measured from VRM's T-pose`);
  return { bones: present, parent: present.map((b) => parentOf.get(b) ?? null), offsets, rotations, hips, frames: m.frames, fps: m.fps || ANIMATION_FPS, straightened, warnings };
}

/** Whether a humanoid motion ends where it began (each bone within `degrees`, the hips within 3 cm). */
export function loops(h: Humanoid, degrees = 2): boolean {
  if (h.frames < 3) return false;
  const last = h.frames - 1;
  for (const r of h.rotations) {
    const a: Quat = [r[0]!, r[1]!, r[2]!, r[3]!];
    const b: Quat = [r[last * 4]!, r[last * 4 + 1]!, r[last * 4 + 2]!, r[last * 4 + 3]!];
    if ((qangle(a, b) * 180) / Math.PI > degrees) return false;
  }
  const d = Math.hypot(h.hips[last * 3]! - h.hips[0]!, h.hips[last * 3 + 1]! - h.hips[1]!, h.hips[last * 3 + 2]! - h.hips[2]!);
  return d <= 0.03;
}

export { IDENTITY };
