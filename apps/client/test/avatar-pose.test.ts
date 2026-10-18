// SPDX-License-Identifier: MPL-2.0
// Shared locomotion and hands (S4.06, S4.07): each gait for its speed and stance, a stride that
// quickens less than the speed, limbs within a body's reach (no joint past a half turn, knees only
// backwards, arms down at rest), the two hands mirrored, and the mouth from the voice clamped.
import { HAND_POSES } from '@flatchat/protocol';
import { describe, expect, it } from 'vitest';
import { gaitOf, handPose, locomotion, mouthShapes, RUN_FROM, strideRate, WALK_FROM } from '../src/renderer/src/world/avatar-pose';

describe('shared locomotion', () => {
  it('picks the gait from the speed and the stance', () => {
    expect(gaitOf(0, 'standing')).toBe('idle');
    expect(gaitOf(WALK_FROM, 'standing')).toBe('walk');
    expect(gaitOf(RUN_FROM + 0.1, 'standing')).toBe('run');
    expect(gaitOf(3, 'sitting')).toBe('sit');
    expect(gaitOf(1, 'jumping')).toBe('air');
    expect(gaitOf(0, 'flying')).toBe('air');
  });

  it('quickens the stride with the speed, less than in proportion', () => {
    expect(strideRate(0.1)).toBe(0);
    const walk = strideRate(1.2);
    const run = strideRate(4.8);
    expect(run).toBeGreaterThan(walk);
    expect(run / walk).toBeLessThan(4.8 / 1.2);
  });

  it('keeps every limb within reach, through a whole stride of each gait', () => {
    for (const gait of ['idle', 'walk', 'run', 'air', 'sit'] as const) {
      for (let k = 0; k < 16; k++) {
        const p = locomotion(gait, (k / 16) * Math.PI * 2, k * 0.25);
        for (const [bone, angles] of Object.entries(p.bones)) {
          for (const a of angles) expect(Math.abs(a), `${gait} ${bone}`).toBeLessThanOrEqual(Math.PI / 2 + 0.01);
          // A knee bends one way only.
          if (bone.endsWith('LowerLeg')) expect(angles[0], `${gait} ${bone}`).toBeGreaterThanOrEqual(0);
        }
        expect(p.bob).toBeGreaterThanOrEqual(0);
        expect(p.bob).toBeLessThan(0.05);
      }
    }
    // At rest the arms hang down, mirrored.
    const idle = locomotion('idle', 0, 0).bones;
    expect(idle['leftUpperArm']![2]).toBeLessThan(-1);
    expect(idle['rightUpperArm']![2]).toBe(-idle['leftUpperArm']![2]);
  });
});

describe('hands and the mouth', () => {
  it('mirrors the two hands for every pose', () => {
    for (const pose of HAND_POSES) {
      const h = handPose(pose, pose);
      for (const [bone, [x, y, z]] of Object.entries(h)) {
        if (!bone.startsWith('left')) continue;
        const [rx, ry, rz] = h[bone.replace('left', 'right')]!;
        // Adding zero turns -0 into 0, so the comparison is of values, not signs of zero.
        expect([rx + 0, ry + 0, rz + 0], `${pose} ${bone}`).toEqual([x + 0, -y + 0, -z + 0]);
      }
    }
    // A fist closes every finger more than an open hand.
    expect(Math.abs(handPose('fist', 'fist')['leftIndexProximal']![2])).toBeGreaterThan(Math.abs(handPose('open', 'open')['leftIndexProximal']![2]));
  });

  it('moves the mouth from the voice frame, clamped to 0 and 1', () => {
    expect(mouthShapes({ aa: 15, ih: 0, ou: 30, ee: -3, oh: 7.5 })).toEqual({ aa: 1, ih: 0, ou: 1, ee: 0, oh: 0.5 });
    expect(mouthShapes(undefined)).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  });
});
