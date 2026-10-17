// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's crowd: where it stands, how it walks and how the proxies' skins are remapped.
import { describe, expect, it } from 'vitest';
import { crowdLayout, FULL_HALF_ANGLE, positionAt } from '../src/renderer/src/crowd/layout';
import { nearestKept, remapSkin } from '../src/renderer/src/crowd/remap';
import { walkPose, WALK_CYCLE_S } from '../src/renderer/src/crowd/walk';

describe('the crowd layout', () => {
  const layout = crowdLayout({ full: 12, lod: 20, proxies: 168 }, 7);

  it('has every tier in its ring, nearest first', () => {
    expect(layout).toHaveLength(200);
    const dist = (p: { x: number; z: number }): number => Math.hypot(p.x, p.z);
    const rings = { full: [2.5, 12], lod: [15, 45], proxy: [50, 120] } as const;
    for (const p of layout) {
      expect(dist(p)).toBeGreaterThanOrEqual(rings[p.tier][0]);
      expect(dist(p)).toBeLessThanOrEqual(rings[p.tier][1]);
    }
  });

  it('puts every full avatar in view, even while it walks its circle', () => {
    for (const p of layout.filter((q) => q.tier === 'full')) {
      for (let t = 0; t < 20; t += 0.5) {
        const at = positionAt(p, t);
        expect(Math.abs(Math.atan2(at.x, at.z))).toBeLessThan(FULL_HALF_ANGLE + 0.35);
        expect(at.z).toBeGreaterThan(0);
      }
    }
  });

  it('is the same for the same seed', () => {
    expect(crowdLayout({ full: 3, lod: 3, proxies: 3 }, 7)).toEqual(crowdLayout({ full: 3, lod: 3, proxies: 3 }, 7));
  });

  it('faces the way an avatar walks, and the camera when it stands', () => {
    const p = { tier: 'full' as const, x: 0, z: 5, radius: 1, phase: 0, turn: 1 };
    const a = positionAt(p, 0);
    const b = positionAt(p, 0.01);
    expect(Math.atan2(b.x - a.x, b.z - a.z)).toBeCloseTo(a.yaw, 1);
    expect(positionAt({ ...p, radius: 0 }, 3)).toEqual({ x: 0, z: 5, yaw: Math.PI });
  });
});

describe('the walk', () => {
  it('repeats every cycle and keeps the joints in range', () => {
    for (const t of [0, 0.3, 0.77]) {
      const a = walkPose(t, true);
      const b = walkPose(t + WALK_CYCLE_S, true);
      for (const [bone, angles] of Object.entries(a.bones)) {
        angles.forEach((v, i) => expect(v).toBeCloseTo(b.bones[bone]![i]!, 6));
        for (const v of angles) expect(Math.abs(v)).toBeLessThan(1.6);
      }
    }
  });

  it('swings the legs against each other', () => {
    const p = walkPose(WALK_CYCLE_S / 4, true);
    expect(p.bones['leftUpperLeg']![0]).toBeCloseTo(-p.bones['rightUpperLeg']![0], 6);
    expect(Math.abs(p.bones['leftUpperLeg']![0])).toBeGreaterThan(0.3);
  });

  it('stands still with its arms down when idle', () => {
    const p = walkPose(1, false);
    expect(p.bob).toBe(0);
    expect(p.bones['leftUpperLeg']).toBeUndefined();
    expect(p.bones['leftUpperArm']![2]).toBeLessThan(-1);
  });
});

describe('the proxy skin', () => {
  // hips(0) → spine(1) → head(2) → hair(3) → hairTip(4); hips → leg(5) → skirt(6)
  const parents = [-1, 0, 1, 2, 3, 0, 5];
  const kept = [0, 1, 2, 5];

  it('hands every joint to its nearest kept ancestor', () => {
    expect([...nearestKept(parents, kept)]).toEqual([0, 1, 2, 2, 2, 3, 3]);
  });

  it('merges weights that land on one joint and keeps them normalized', () => {
    const map = nearestKept(parents, kept);
    // One vertex: hair 0.5, hairTip 0.3, head 0.2 → all head.  Another: skirt 0.6, spine 0.4.
    const { index, weight } = remapSkin([3, 4, 2, 0, 6, 1, 0, 0], [0.5, 0.3, 0.2, 0, 0.6, 0.4, 0, 0], map);
    expect([...index.slice(0, 4)]).toEqual([2, 0, 0, 0]);
    expect(weight[0]).toBeCloseTo(1, 6);
    expect([...index.slice(4, 6)]).toEqual([3, 1]);
    expect(weight[4]).toBeCloseTo(0.6, 6);
    expect(weight[5]).toBeCloseTo(0.4, 6);
  });

  it('binds a vertex with no weight to the first kept joint', () => {
    const { index, weight } = remapSkin([0, 0, 0, 0], [0, 0, 0, 0], nearestKept(parents, kept));
    expect(index[0]).toBe(0);
    expect(weight[0]).toBe(1);
  });
});
