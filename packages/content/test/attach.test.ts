// SPDX-License-Identifier: Apache-2.0
// Attachment points (S5.04): a point sits at its bone's rest place plus its offset × height, follows
// the bone as it turns, takes a player's adjustment within the limits, and falls back to a bone up
// the chain where VRM's optional bones are missing. A worn prop's adjustment as the protocol carries
// it (S5.05: centimetres, degrees, percent) is clamped to the same limits.
import { describe, expect, it } from 'vitest';
import { ADJUST_LIMITS, attachBone, attachMatrix, fitAdjustment, fitWornAdjust, NO_ADJUSTMENT, wornAdjustment, WORN_LIMITS } from '../src/index.ts';

const at = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const turnY = (a: number, x = 0, y = 0, z = 0): number[] => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, x, y, z, 1];
const place = (m: number[]): number[] => [m[12]!, m[13]!, m[14]!].map((v) => Math.round(v * 1000) / 1000);

describe('attachment points', () => {
  it('sit at the bone plus the offset scaled by height, and follow the bone', () => {
    const head = at(0, 1.5, 0);
    expect(place(attachMatrix('head_top', head, head, 1.7))).toEqual([0, 1.67, 0]);
    expect(place(attachMatrix('face', head, head, 2))).toEqual([0, 1.57, 0.13]);
    // The head turned a quarter to its left about its own place: the face goes with it.
    expect(place(attachMatrix('face', head, turnY(Math.PI / 2, 0, 1.5, 0), 2))).toEqual([0.13, 1.57, 0]);
  });

  it('take a player\'s adjustment, clamped to the limits', () => {
    const hand = at(0.6, 1.4, 0);
    expect(place(attachMatrix('hand_r', hand, hand, 1.7, { offset: [0.05, 0, 0], rotation: [0, 0, 0], scale: 1 }))).toEqual([0.65, 1.4, 0]);
    const a = fitAdjustment({ offset: [1, -1, 0.02], rotation: [3, 0, Number.NaN], scale: 9 });
    expect(a).toEqual({ offset: [ADJUST_LIMITS.offset, -ADJUST_LIMITS.offset, 0.02], rotation: [ADJUST_LIMITS.rotation, 0, 0], scale: ADJUST_LIMITS.scale[1] });
  });

  it('fall back up the chain where an optional bone is missing', () => {
    expect(attachBone('chest', (b) => b === 'chest' || b === 'spine')).toBe('chest');
    expect(attachBone('back', (b) => b === 'spine')).toBe('spine');
    expect(attachBone('neck', (b) => b === 'head')).toBe('head');
    expect(attachBone('hand_l', () => false)).toBeUndefined();
  });
});

describe('worn adjustments (S5.05)', () => {
  it('carry the same limits in centimetres, degrees and percent, clamped and rounded', () => {
    expect(WORN_LIMITS).toEqual({ offsetCm: 10, rotationDeg: 45, scalePercent: [80, 125] });
    expect(fitWornAdjust({ x: 90, y: -90, z: 4.4, rx: 120, ry: -120, rz: 0, scale: 250 })).toEqual({ x: 10, y: -10, z: 4, rx: 45, ry: -45, rz: 0, scale: 125 });
    expect(fitWornAdjust({ x: Number.NaN, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 100 });
  });

  it('become what attachMatrix takes', () => {
    expect(wornAdjustment(undefined)).toEqual(NO_ADJUSTMENT);
    const a = wornAdjustment({ x: 5, y: 0, z: -10, rx: 45, ry: 0, rz: 0, scale: 80 });
    expect(a.offset).toEqual([0.05, 0, -0.1]);
    expect(a.rotation[0]).toBeCloseTo(Math.PI / 4, 9);
    expect(a.scale).toBe(0.8);
    expect(fitAdjustment(a)).toEqual(a);
  });
});
