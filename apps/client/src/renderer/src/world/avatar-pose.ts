// SPDX-License-Identifier: MPL-2.0
// Hand poses and the mouth (S4.07), pure: Euler angles (radians, XYZ) for VRM 1.0's normalized
// humanoid bones, which stand in a T-pose facing +Z with world-aligned axes on every avatar; three-vrm
// turns each angle into the raw bone's own frame. The body's own motion is the default clips'
// (motion.ts, Track P's P.05), which replaced S4.06's procedural walk.
import type { EXPRESSIONS, HAND_POSES } from '@flatchat/protocol';

export type { BoneAngles } from './clips';
import type { BoneAngles } from './clips';
export type HandPose = (typeof HAND_POSES)[number];
export type Expression = (typeof EXPRESSIONS)[number];
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
