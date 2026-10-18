// SPDX-License-Identifier: MPL-2.0
// The loader under fuzzing (S6.01's Verify, R-18): hundreds of broken copies of Effekseer's samples
// (bytes flipped, the file cut short, chunk sizes and counts that lie, garbage put in) go through
// the reader and the pinned runtime, the same WebAssembly the client runs. Each must end one of
// three ways: refused by the reader, refused by the dry run (DryRunFailed: the runtime could not
// read it, gave up on it, or ran past the deadline, which ends its thread), or measured. None may
// throw anything else or hang, and a fresh runtime afterwards still plays the laser as before.
import { EffectFormatError, readEffectFile } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { DryRunFailed } from '@flatchat/effects';
import { dryRun, DryRunner } from '../src/effect/dry-run.ts';
import { sampleBundle } from '../src/effect/samples.ts';

/** A small seeded generator (mulberry32), so the corpus is the same on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the runtime body starts in a container (after "BIN_" and its size), or 0 for an .efk. */
function bodyAt(b: Uint8Array): number {
  for (let i = 8; i + 8 <= b.length; i++) if (b[i] === 0x42 && b[i + 1] === 0x49 && b[i + 2] === 0x4e && b[i + 3] === 0x5f) return i + 8;
  return 0;
}

/** One broken copy of `b`, by the kind of damage `kind` (0 to 5). */
function broken(b: Uint8Array, kind: number, r: () => number): Uint8Array {
  const at = bodyAt(b);
  const pick = (lo: number): number => lo + Math.floor(r() * (b.length - lo));
  const out = b.slice();
  const view = new DataView(out.buffer);
  switch (kind) {
    case 0: {
      // A few bytes flipped in the body.
      const n = 1 + Math.floor(r() * 16);
      for (let i = 0; i < n; i++) out[pick(at)]! ^= 1 << Math.floor(r() * 8);
      return out;
    }
    case 1:
      // Cut short.
      return out.subarray(0, pick(0));
    case 2:
      // The runtime chunk's size lies.
      if (at >= 8) view.setInt32(at - 4, Math.floor((r() - 0.5) * 2 ** 31), true);
      return out;
    case 3: {
      // A 32-bit value somewhere in the body made huge or negative: a count, a length, a size.
      const p = pick(at) & ~3;
      if (p + 4 <= out.length) view.setInt32(p, [0x7fffffff, -1, 0x10000, 1025, -0x80000000][Math.floor(r() * 5)]!, true);
      return out;
    }
    case 4: {
      // Garbage written over a stretch of the body.
      const p = pick(at);
      const n = Math.min(out.length - p, 1 + Math.floor(r() * 64));
      for (let i = 0; i < n; i++) out[p + i] = Math.floor(r() * 256);
      return out;
    }
    default: {
      // Zeros put in, shifting everything after them.
      const p = pick(at);
      const zeros = new Uint8Array(1 + Math.floor(r() * 32));
      return new Uint8Array([...out.subarray(0, p), ...zeros, ...out.subarray(p)]);
    }
  }
}

describe('a fuzzed effect corpus', () => {
  it('never crashes the runtime’s host or hangs it', async () => {
    const samples = ['00_Basic/Laser01.efkefc', '00_Version16/Aura01.efkefc', '00_Basic/Simple_Track1.efkefc'];
    const outcomes = { reader: 0, runtime: 0, deadline: 0, measured: 0 };
    const r = random(20261018);
    const runner = new DryRunner({ deadlineMs: 3000 });
    for (const rel of samples) {
      const bundle = sampleBundle(rel);
      const main = bundle.files.get(bundle.main)!;
      for (let i = 0; i < 100; i++) {
        const bad = broken(main, i % 6, r);
        try {
          readEffectFile(bad);
        } catch (err) {
          expect(err).toBeInstanceOf(EffectFormatError);
          outcomes.reader++;
          continue;
        }
        const files = new Map(bundle.files);
        files.set(bundle.main, bad);
        const t0 = performance.now();
        try {
          await runner.run({ main: bundle.main, files }, { scale: 1, frames: 30, seeds: [1] });
          outcomes.measured++;
        } catch (err) {
          expect(err, String(err)).toBeInstanceOf(DryRunFailed);
          if (/took longer than/.test((err as Error).message)) outcomes.deadline++;
          else outcomes.runtime++;
        }
        expect(performance.now() - t0).toBeLessThan(5000);
      }
    }
    await runner.close();
    // Every kind of ending happened, and all 300 were accounted for. One broken trail makes a single
    // update take about 32 s: only the deadline, which ends the worker, stops it.
    expect(outcomes.reader + outcomes.runtime + outcomes.deadline + outcomes.measured).toBe(300);
    expect(outcomes.reader).toBeGreaterThan(0);
    expect(outcomes.runtime).toBeGreaterThan(0);
    expect(outcomes.deadline).toBeGreaterThan(0);
    expect(outcomes.measured).toBeGreaterThan(0);
    // A fresh runtime after all of them plays the laser as it always did.
    const after = await dryRun(sampleBundle('00_Basic/Laser01.efkefc'), { scale: 1 });
    expect(after.frames).toBe(83);
    expect(after.peak.instances).toBe(122);
  }, 120_000);
});
