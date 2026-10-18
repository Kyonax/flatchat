// SPDX-License-Identifier: MPL-2.0
// The viewer's policy over avatars (S4.05, S4.09): the first visit's tier from its frames, the
// tuner that draws fewer avatars in full while frames run slow and more once they recover, and
// what each person shows as: the viewer's own always in full, a hidden one and a stranger under
// the shield as impostors, a friend in full whatever their trust.
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/settings';
import { FrameTuner, TIER_POLICY, tierOf, viewerPolicy } from '../src/renderer/src/world/avatar-policy';

describe('the first visit’s tier', () => {
  it('reads the frames’ p95', () => {
    expect(tierOf(Array(100).fill(7))).toBe('high');
    expect(tierOf(Array(100).fill(16))).toBe('medium');
    expect(tierOf([...Array(90).fill(10), ...Array(10).fill(40)])).toBe('low');
    expect(tierOf([])).toBe('medium');
    expect(TIER_POLICY.low.full).toBeLessThan(TIER_POLICY.high.full);
  });
});

describe('the frame-rate tuner', () => {
  it('draws fewer in full while frames run past 33 ms, and more again once they recover', () => {
    const t = new FrameTuner();
    let now = 0;
    const run = (ms: number, seconds: number): void => {
      for (let i = 0; i < seconds * 30; i++) t.push(ms, (now += 1000 / 30));
    };
    run(50, 10);
    expect(t.factor).toBeLessThan(0.5);
    expect(t.factor).toBeGreaterThanOrEqual(0.25);
    run(10, 30);
    expect(t.factor).toBe(1);
  });
});

describe('what each person shows as', () => {
  const accounts: Record<number, string> = { 1: 'me', 2: 'friend', 3: 'stranger', 4: 'hidden', 5: 'trusted' };
  const trust: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 3, 5: 3 };
  const viewer = { accountOf: (e: number) => accounts[e], trustOf: (e: number) => trust[e] ?? 0, friends: new Set(['friend']), me: 1 };
  it('keeps the viewer’s own in full, hides the hidden, and shields from strangers below the level', () => {
    const s = { ...defaultSettings().avatar, shield: 2, hidden: ['hidden'] };
    const p = viewerPolicy(s, 1, viewer);
    expect([1, 2, 3, 4, 5].map((e) => p.shown!(e))).toEqual(['full', 'full', 'impostor', 'impostor', 'full']);
    expect(viewerPolicy({ ...s, shield: 0, hidden: [] }, 1, viewer).shown!(3)).toBe('full');
  });
  it('scales the counts with the tuner', () => {
    const s = { ...defaultSettings().avatar, full: 8, tier: 'medium' as const };
    expect(viewerPolicy(s, 1, viewer).full).toBe(8);
    expect(viewerPolicy(s, 0.25, viewer).full).toBe(2);
    expect(viewerPolicy(s, 0.25, viewer).lower).toBe(Math.round(TIER_POLICY.medium.lower * 0.25));
  });
});
