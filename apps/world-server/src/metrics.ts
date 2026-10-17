// SPDX-License-Identifier: MPL-2.0
// Run statistics for the world server and the bots: exact quantiles over a reporting window and
// over the whole run, and counters by message type. A 30-minute run at 50 Hz keeps 90,000 numbers,
// well under a megabyte, so nothing is approximated.

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(values: ArrayLike<number>): Summary {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const at = (q: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] ?? 0;
  return { n, mean: sum / n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[n - 1] ?? 0 };
}

/** Samples kept for the current window and for the whole run. */
export class Samples {
  private window: number[] = [];
  private all = new Float64Array(1024);
  private count = 0;

  add(value: number): void {
    this.window.push(value);
    if (this.count === this.all.length) {
      const grown = new Float64Array(this.all.length * 2);
      grown.set(this.all);
      this.all = grown;
    }
    this.all[this.count++] = value;
  }

  /** The window's summary; starts a new window. */
  takeWindow(): Summary {
    const summary = summarize(this.window);
    this.window = [];
    return summary;
  }

  total(): Summary {
    return summarize(this.all.subarray(0, this.count));
  }
}

/** Bytes and messages by name, for a window and in total. */
export class Tally {
  private window = new Map<string, { bytes: number; messages: number }>();
  private readonly all = new Map<string, { bytes: number; messages: number }>();

  add(name: string, bytes: number): void {
    for (const map of [this.window, this.all]) {
      const entry = map.get(name);
      if (entry) {
        entry.bytes += bytes;
        entry.messages += 1;
      } else {
        map.set(name, { bytes, messages: 1 });
      }
    }
  }

  takeWindow(): Record<string, { bytes: number; messages: number }> {
    const out = Object.fromEntries(this.window);
    this.window = new Map();
    return out;
  }

  total(): Record<string, { bytes: number; messages: number }> {
    return Object.fromEntries([...this.all].map(([k, v]) => [k, { ...v }]));
  }
}

export function memory(): { rssMB: number; heapUsedMB: number; externalMB: number; arrayBuffersMB: number } {
  const m = process.memoryUsage();
  const mb = (n: number): number => Math.round((n / 1_048_576) * 10) / 10;
  return { rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), externalMB: mb(m.external), arrayBuffersMB: mb(m.arrayBuffers) };
}

/** Deterministic random numbers (mulberry32), so a run's spawns and choices can be repeated. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
