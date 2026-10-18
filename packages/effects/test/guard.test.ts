// SPDX-License-Identifier: Apache-2.0
// The guard layer (S6.01): admission against an owner's budget and everyone's, trimming an owner
// over its budget until it is back under nine tenths of it, and the GPU watch that stops an
// effect after three measured frames in a row over half a millisecond.
import { EFFECT_LIMITS } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { EffectBudget, InstanceTrim, TimeWatch } from '../src/guard.ts';

const peaks = (instances: number, quads = 0, triangles = 0) => ({ instances, quads, triangles });

describe('admission', () => {
  it('fits an avatar within its budget, effect by effect', () => {
    const b = new EffectBudget();
    expect(b.admit(7, 1, 'a', peaks(200, 1500))).toBeUndefined();
    // A second effect that would take the avatar past 300 particles is refused...
    expect(b.admit(7, 2, 'b', peaks(101))).toBe('owner-budget');
    // ...and one that fits is not; another avatar has its own budget.
    expect(b.admit(7, 3, 'c', peaks(100, 500))).toBeUndefined();
    expect(b.admit(8, 1, 'b', peaks(300, 2000, 20_000))).toBeUndefined();
    expect(b.used(7)).toEqual(peaks(300, 2000));
    b.release(7, 1);
    expect(b.used(7)).toEqual(peaks(100, 500));
    expect(b.admit(7, 2, 'b', peaks(101))).toBeUndefined();
  });

  it('holds everyone together to the global caps, and the world to its own', () => {
    const b = new EffectBudget();
    let refused = 0;
    for (let id = 0; id < 20; id++) if (b.admit(id, 0, 'x', peaks(300)) !== undefined) refused++;
    // 4,000 particles in all: thirteen avatars at 300, the rest refused.
    expect(b.all.instances).toBe(3900);
    expect(refused).toBe(7);
    expect(b.admit('world', 0, 'w', peaks(150))).toBe('global-budget');
    expect(b.admit('world', 1, 'w', peaks(100))).toBeUndefined();
    expect(new EffectBudget().admit('world', 0, 'w', peaks(EFFECT_LIMITS.world.instances + 1))).toBe('owner-budget');
  });

  it('never plays a blocked file again', () => {
    const b = new EffectBudget();
    b.block('bad');
    expect(b.admit(1, 1, 'bad', peaks(1))).toBe('blocked');
    expect(b.isBlocked('bad')).toBe(true);
  });
});

describe('trimming', () => {
  it('stops an owner over its cap making particles, and lets it again below nine tenths', () => {
    const t = new InstanceTrim();
    expect(t.step(new Map([[3, 280]]))).toEqual({ trim: [], resume: [] });
    expect(t.step(new Map([[3, 301]]))).toEqual({ trim: [3], resume: [] });
    expect(t.isTrimmed(3)).toBe(true);
    // Still over nine tenths of 300 (270): kept trimmed, not named again.
    expect(t.step(new Map([[3, 290]]))).toEqual({ trim: [], resume: [] });
    expect(t.step(new Map([[3, 270]]))).toEqual({ trim: [], resume: [3] });
    expect(t.step(new Map([['world', EFFECT_LIMITS.world.instances + 1]])).trim).toEqual(['world']);
  });
});

describe('the time watches', () => {
  it('stops an effect after three measured frames in a row over 0.5 ms of GPU time', () => {
    const w = TimeWatch.gpu();
    expect(w.report(new Map([[1, 0.9], [2, 0.2]]))).toEqual([]);
    expect(w.report(new Map([[1, 0.6]]))).toEqual([]);
    // A frame not measured for handle 1 neither counts nor resets it.
    expect(w.report(new Map([[2, 0.9]]))).toEqual([]);
    expect(w.report(new Map([[1, 0.7], [2, 0.1]]))).toEqual([1]);
    // A frame under the line starts the count again.
    expect(w.report(new Map([[2, 0.9]]))).toEqual([]);
    expect(w.report(new Map([[2, 0.4]]))).toEqual([]);
    expect(w.report(new Map([[2, 0.9]]))).toEqual([]);
    expect(w.report(new Map([[2, 0.9]]))).toEqual([]);
    expect(w.report(new Map([[2, 0.9]]))).toEqual([2]);
  });

  it('stops an effect whose update stalls the frame at once, and a slow one after three frames', () => {
    const w = TimeWatch.cpu();
    expect(w.report(new Map([[4, EFFECT_LIMITS.stallMs + 1], [5, EFFECT_LIMITS.cpuMs + 0.1]]))).toEqual([4]);
    expect(w.report(new Map([[5, EFFECT_LIMITS.cpuMs + 0.1]]))).toEqual([]);
    expect(w.report(new Map([[5, EFFECT_LIMITS.cpuMs + 0.1]]))).toEqual([5]);
  });
});
