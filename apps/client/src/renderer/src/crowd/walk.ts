// SPDX-License-Identifier: MPL-2.0
// A procedural walk and idle for spike S0.09's crowd (pure): Euler angles for a VRM's normalized
// humanoid bones, which face +z in a T-pose with world-aligned axes. Real animation clips come with
// the converter (VRMA, Stage 4); for measuring, any motion that moves every limb every frame will do.

export type BoneAngles = Readonly<Record<string, readonly [number, number, number]>>;

export interface WalkPose {
  bones: BoneAngles;
  /** The hips' height change, metres. */
  bob: number;
}

/** One walk cycle (two steps) per this many seconds at 1.2 m/s. */
export const WALK_CYCLE_S = 1.1;

const ARMS_DOWN = 1.2;

export function walkPose(tSeconds: number, walking: boolean): WalkPose {
  if (!walking) {
    const breath = Math.sin((2 * Math.PI * tSeconds) / 4) * 0.03;
    return {
      bob: 0,
      bones: {
        spine: [breath, 0, 0],
        chest: [breath, 0, 0],
        leftUpperArm: [0, 0, -ARMS_DOWN],
        rightUpperArm: [0, 0, ARMS_DOWN],
        leftLowerArm: [0, -0.1, 0],
        rightLowerArm: [0, 0.1, 0],
        head: [0, Math.sin((2 * Math.PI * tSeconds) / 7) * 0.2, 0],
      },
    };
  }
  const w = (2 * Math.PI * tSeconds) / WALK_CYCLE_S;
  const s = Math.sin(w);
  const legSwing = 0.45;
  const knee = (x: number): number => 0.6 * Math.max(0, x);
  return {
    bob: 0.025 * Math.abs(Math.cos(w)),
    bones: {
      hips: [0, 0.08 * s, 0],
      spine: [0.05, -0.06 * s, 0],
      leftUpperLeg: [-legSwing * s, 0, 0],
      rightUpperLeg: [legSwing * s, 0, 0],
      leftLowerLeg: [knee(Math.sin(w + Math.PI / 2)), 0, 0],
      rightLowerLeg: [knee(Math.sin(w - Math.PI / 2)), 0, 0],
      leftUpperArm: [0.35 * s, 0, -ARMS_DOWN],
      rightUpperArm: [-0.35 * s, 0, ARMS_DOWN],
      leftLowerArm: [0, -0.25, 0],
      rightLowerArm: [0, 0.25, 0],
    },
  };
}
