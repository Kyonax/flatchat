// SPDX-License-Identifier: MPL-2.0
// Hands and the mouth (S4.07): the two hands mirrored for every pose, and the mouth from the voice
// clamped. The body's motion is the default clips' (motion.test.ts).
import { HAND_POSES } from '@flatchat/protocol';
import { describe, expect, it } from 'vitest';
import { handPose, mouthShapes } from '../src/renderer/src/world/avatar-pose';

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
