// SPDX-License-Identifier: MPL-2.0
// Frame-time statistics for the bench mode. Percentiles use the nearest-rank method; the "1% low"
// is the frame rate of the slowest 1% of frames, the number that shows stutter an average hides.

export interface FrameSummary {
  frames: number;
  seconds: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  low1PctFps: number;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** The value at percentile p (0–100) of an ascending list, by nearest rank. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function summarizeFrames(frameTimesMs: readonly number[]): FrameSummary {
  const times = frameTimesMs.filter((t) => Number.isFinite(t) && t > 0);
  if (times.length === 0) {
    return { frames: 0, seconds: 0, avgFps: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, low1PctFps: 0 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const totalMs = times.reduce((sum, t) => sum + t, 0);
  const slowest = sorted.slice(sorted.length - Math.max(1, Math.ceil(sorted.length / 100)));
  const slowestMeanMs = slowest.reduce((sum, t) => sum + t, 0) / slowest.length;
  return {
    frames: times.length,
    seconds: round(totalMs / 1000, 3),
    avgFps: round((times.length * 1000) / totalMs),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    low1PctFps: round(1000 / slowestMeanMs),
  };
}
