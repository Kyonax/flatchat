// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { percentile, summarizeFrames } from '../src/renderer/src/frame-stats';

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarizeFrames', () => {
  it('summarises a steady 30 fps run', () => {
    const s = summarizeFrames(Array.from({ length: 300 }, () => 1000 / 30));
    expect(s.frames).toBe(300);
    expect(s.seconds).toBeCloseTo(10, 2);
    expect(s.avgFps).toBeCloseTo(30, 1);
    expect(s.p99Ms).toBeCloseTo(33.33, 1);
    expect(s.low1PctFps).toBeCloseTo(30, 1);
  });

  it('shows stutter in the 1% low that the average hides', () => {
    const times = Array.from({ length: 200 }, (_, i) => (i % 100 === 0 ? 100 : 10));
    const s = summarizeFrames(times);
    expect(s.avgFps).toBeGreaterThan(90);
    expect(s.maxMs).toBe(100);
    expect(s.low1PctFps).toBe(10);
  });

  it('ignores impossible frame times and copes with none', () => {
    expect(summarizeFrames([Number.NaN, -1, 0]).frames).toBe(0);
    expect(summarizeFrames([]).avgFps).toBe(0);
  });
});
