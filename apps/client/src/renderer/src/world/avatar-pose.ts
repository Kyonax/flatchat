// SPDX-License-Identifier: MPL-2.0
// Shared locomotion and hand poses (S4.06, S4.07), pure: Euler angles (radians, XYZ) for VRM 1.0's
// normalized humanoid bones, which stand in a T-pose facing +Z with world-aligned axes on every
// avatar. Posing those bones is what retargets: three-vrm turns each angle into the raw bone's own
// frame, so one walk moves a 1.2 m robot and a 1.9 m dancer alike, without broken limbs.
// Directions on the normalized bones: +X is the avatar's left. A positive turn about X swings a
// downward bone backwards (a knee bends that way), so a leg steps forward with a negative one; the
// left arm hangs down with a negative turn about Z and the right with a positive one.
// The stand-in for Track P's fourteen clips (P.05, VRMA, still to come): same bones, same entry
// points, so the clips can replace these curves one by one.
import type { EXPRESSIONS, HAND_POSES } from '@flatchat/protocol';

export type BoneAngles = Record<string, [number, number, number]>;
export type HandPose = (typeof HAND_POSES)[number];
export type Expression = (typeof EXPRESSIONS)[number];
export type Gait = 'idle' | 'walk' | 'run' | 'air' | 'sit';

export interface Locomotion {
  bones: BoneAngles;
  /** The hips' rise and fall over the cycle, as a share of the hips' height. */
  bob: number;
  gait: Gait;
}

const ARMS_DOWN = 1.25;
/** Speeds, metres a second: below WALK it stands; from RUN it runs. */
export const WALK_FROM = 0.25;
export const RUN_FROM = 2.6;

/** The gait for a speed and a stance. */
export function gaitOf(speed: number, stance: string): Gait {
  if (stance === 'sitting') return 'sit';
  if (stance === 'jumping' || stance === 'falling' || stance === 'flying') return 'air';
  if (speed >= RUN_FROM) return 'run';
  if (speed >= WALK_FROM) return 'walk';
  return 'idle';
}

/** The body's pose at `phase` (radians of its stride, advanced by the caller with the speed) and
 *  `t` (seconds, for breathing). */
export function locomotion(gait: Gait, phase: number, t: number): Locomotion {
  const breath = Math.sin((2 * Math.PI * t) / 4) * 0.03;
  if (gait === 'idle') {
    return {
      gait,
      bob: 0,
      bones: {
        spine: [breath, 0, 0],
        chest: [breath * 0.5, 0, 0],
        neck: [0, 0, 0],
        leftUpperArm: [0, 0, -ARMS_DOWN],
        rightUpperArm: [0, 0, ARMS_DOWN],
        leftLowerArm: [0, -0.12, 0],
        rightLowerArm: [0, 0.12, 0],
      },
    };
  }
  if (gait === 'sit') {
    return {
      gait,
      bob: 0,
      bones: {
        spine: [0.05 + breath, 0, 0],
        leftUpperLeg: [-1.5, 0, 0.05],
        rightUpperLeg: [-1.5, 0, -0.05],
        leftLowerLeg: [1.45, 0, 0],
        rightLowerLeg: [1.45, 0, 0],
        leftFoot: [0.05, 0, 0],
        rightFoot: [0.05, 0, 0],
        leftUpperArm: [-0.25, 0, -1.15],
        rightUpperArm: [-0.25, 0, 1.15],
        leftLowerArm: [0, -0.6, 0],
        rightLowerArm: [0, 0.6, 0],
      },
    };
  }
  if (gait === 'air') {
    return {
      gait,
      bob: 0,
      bones: {
        spine: [-0.05, 0, 0],
        leftUpperLeg: [-0.55, 0, 0],
        rightUpperLeg: [-0.25, 0, 0],
        leftLowerLeg: [0.9, 0, 0],
        rightLowerLeg: [0.5, 0, 0],
        leftUpperArm: [0, 0, -0.75],
        rightUpperArm: [0, 0, 0.75],
        leftLowerArm: [0, -0.3, 0],
        rightLowerArm: [0, 0.3, 0],
      },
    };
  }
  const run = gait === 'run';
  const s = Math.sin(phase);
  const swing = run ? 0.75 : 0.42;
  const arm = run ? 0.7 : 0.35;
  // A knee bends while its foot travels forward (and, running, under the body too).
  const knee = (x: number): number => (run ? 1.3 : 0.65) * Math.max(0, x) + (run ? 0.25 : 0.05);
  return {
    gait,
    bob: (run ? 0.035 : 0.02) * Math.abs(Math.cos(phase)),
    bones: {
      hips: [0, 0.08 * s, 0],
      spine: [run ? 0.18 : 0.05, -0.07 * s, 0],
      chest: [0, -0.05 * s, 0],
      leftUpperLeg: [-swing * s, 0, 0],
      rightUpperLeg: [swing * s, 0, 0],
      leftLowerLeg: [knee(Math.sin(phase + Math.PI / 2)), 0, 0],
      rightLowerLeg: [knee(Math.sin(phase - Math.PI / 2)), 0, 0],
      leftFoot: [0.1 * Math.max(0, -s), 0, 0],
      rightFoot: [0.1 * Math.max(0, s), 0, 0],
      leftUpperArm: [arm * s, 0, -ARMS_DOWN],
      rightUpperArm: [-arm * s, 0, ARMS_DOWN],
      leftLowerArm: [0, run ? -1.2 : -0.3, 0],
      rightLowerArm: [0, run ? 1.2 : 0.3, 0],
    },
  };
}

/** How fast the stride turns for a speed: two steps per WALK_CYCLE_S at 1.2 m/s, quicker with
 *  speed but less than in proportion (longer steps). */
export const WALK_CYCLE_S = 1.1;
export function strideRate(speed: number): number {
  if (speed < WALK_FROM) return 0;
  return ((2 * Math.PI) / WALK_CYCLE_S) * Math.min(2.4, Math.max(0.45, Math.sqrt(speed / 1.2)));
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;

/** One hand's finger curls: 0 straight, 1 closed. */
const CURLS: Record<HandPose, { thumb: number; Index: number; Middle: number; Ring: number; Little: number; thumbUp?: boolean }> = {
  relaxed: { thumb: 0.2, Index: 0.25, Middle: 0.3, Ring: 0.35, Little: 0.4 },
  fist: { thumb: 0.8, Index: 1, Middle: 1, Ring: 1, Little: 1 },
  point: { thumb: 0.8, Index: 0, Middle: 1, Ring: 1, Little: 1 },
  peace: { thumb: 0.8, Index: 0, Middle: 0, Ring: 1, Little: 1 },
  thumbsUp: { thumb: 0, Index: 1, Middle: 1, Ring: 1, Little: 1, thumbUp: true },
  open: { thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 },
  rock: { thumb: 0.8, Index: 0, Middle: 1, Ring: 1, Little: 0 },
};

/** The finger bones' angles for each hand's pose. Fingers curl toward the palm: about -Z on the
 *  left hand (pointing +X), +Z on the right. */
export function handPose(left: HandPose, right: HandPose): BoneAngles {
  const out: BoneAngles = {};
  for (const [side, pose, sign] of [['left', left, -1], ['right', right, 1]] as const) {
    const c = CURLS[pose];
    for (const f of FINGERS) {
      const a = c[f] * 1.25;
      out[`${side}${f}Proximal`] = [0, 0, sign * a * 0.9];
      out[`${side}${f}Intermediate`] = [0, 0, sign * a * 1.1];
      out[`${side}${f}Distal`] = [0, 0, sign * a * 0.8];
    }
    const t = c.thumb;
    out[`${side}ThumbMetacarpal`] = c.thumbUp ? [0, 0, sign * -0.4] : [0, sign * -0.35 * t, sign * 0.25 * t];
    out[`${side}ThumbProximal`] = [0, sign * -0.5 * t, 0];
    out[`${side}ThumbDistal`] = [0, sign * -0.6 * t, 0];
  }
  return out;
}

/** The mouth's VRM shapes from the voice frame's mouth (0 to 15 each), eased. */
export function mouthShapes(m: { aa: number; ih: number; ou: number; ee: number; oh: number } | undefined): Record<'aa' | 'ih' | 'ou' | 'ee' | 'oh', number> {
  const v = (x: number | undefined): number => Math.min(1, Math.max(0, (x ?? 0) / 15));
  return { aa: v(m?.aa), ih: v(m?.ih), ou: v(m?.ou), ee: v(m?.ee), oh: v(m?.oh) };
}
