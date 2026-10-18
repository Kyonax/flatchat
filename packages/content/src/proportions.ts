// SPDX-License-Identifier: Apache-2.0
// How an avatar's proportions move its bones (S4.10): each slider is a share of the avatar as made,
// and the client moves these humanoid joints by it, along their bone for length and sideways for
// width, with the head scaled. A limb's skin stretches with its bones (P.08): each arm and leg
// bone's skin is scaled along the bone by the same share, so a shortened forearm is a shorter
// forearm, not one slid into the upper arm with the hand sunk into it (which a sleeve over it
// cannot follow). Shared, so the converter's checks pose a body as the client does: the default
// clips' feet (P.05) and the starter wardrobe's clipping (P.08) at the sliders' ends.

/** The joints each slider moves (VRM 1.0 humanoid bones): the arms' and legs' lower joints along
 *  their bone, the shoulders and hips sideways. */
export const PROPORTION_JOINTS = {
  arms: ['leftLowerArm', 'leftHand', 'rightLowerArm', 'rightHand'],
  legs: ['leftLowerLeg', 'leftFoot', 'rightLowerLeg', 'rightFoot'],
  width: ['leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg'],
} as const;
/** The bones whose skin each length slider stretches, each along itself: from it to the joint it
 *  moves (PROPORTION_JOINTS). */
export const PROPORTION_SEGMENTS = {
  arms: [['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand']],
  legs: [['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot']],
} as const;

/** The scale along a unit axis by a share, as a column-major 4×4 matrix (I + (share - 1)·a·aᵀ). */
export function stretchAlong(axis: readonly [number, number, number], share: number): number[] {
  const k = share - 1;
  const [x, y, z] = axis;
  return [1 + k * x * x, k * x * y, k * x * z, 0, k * y * x, 1 + k * y * y, k * y * z, 0, k * z * x, k * z * y, 1 + k * z * z, 0, 0, 0, 0, 1];
}

/** An avatar without shoulder bones widens at its upper arms. */
export const WIDTH_FALLBACK: Readonly<Record<string, string>> = { leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm' };

/** The sliders, each as a share (1 as made). */
export interface ProportionShares {
  width: number;
  arms: number;
  legs: number;
  head: number;
}
export const PROPORTIONS_AS_MADE: ProportionShares = { width: 1, arms: 1, legs: 1, head: 1 };
/** The sliders' two ends (the protocol's PROPORTIONS, 80 and 125 %). */
export const PROPORTION_ENDS = [0.8, 1.25] as const;
