// SPDX-License-Identifier: MPL-2.0
// The loader under fuzzing (S6.01's Verify, R-18): hundreds of broken copies of Effekseer's samples
// (bytes flipped, the file cut short, chunk sizes and counts that lie, garbage put in; the corpus is
// src/effect/fuzz.ts's) go through the reader and the pinned runtime, the same WebAssembly the
// client runs. Each must end one of three ways: refused by the reader, refused by the dry run
// (DryRunFailed: the runtime could not read it, gave up on it, or ran past the deadline, which ends
// its thread), or measured. None may throw anything else or hang, and a fresh runtime afterwards
// still plays the laser as before.
import { EffectFormatError, readEffectFile } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { DryRunFailed } from '@flatchat/effects';
import { dryRun, DryRunner } from '../src/effect/dry-run.ts';
import { fuzzCorpus } from '../src/effect/fuzz.ts';
import { sampleBundle } from '../src/effect/samples.ts';

describe('a fuzzed effect corpus', () => {
  it('never crashes the runtime’s host or hangs it', async () => {
    const outcomes = { reader: 0, runtime: 0, deadline: 0, measured: 0 };
    const runner = new DryRunner({ deadlineMs: 3000 });
    const main = (rel: string): Uint8Array => {
      const b = sampleBundle(rel);
      return b.files.get(b.main)!;
    };
    for (const c of fuzzCorpus(main)) {
      try {
        readEffectFile(c.bytes);
      } catch (err) {
        expect(err).toBeInstanceOf(EffectFormatError);
        outcomes.reader++;
        continue;
      }
      const bundle = sampleBundle(c.sample);
      const files = new Map(bundle.files);
      files.set(bundle.main, c.bytes);
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

  it('keeps the next run when a worker ended past its deadline stops', async () => {
    const main = (rel: string): Uint8Array => {
      const b = sampleBundle(rel);
      return b.files.get(b.main)!;
    };
    // Case 270, a broken trail, makes one update take about 32 s.
    let slow;
    for (const c of fuzzCorpus(main)) if (c.index === 270) slow = c;
    const bundle = sampleBundle(slow!.sample);
    const files = new Map(bundle.files);
    files.set(bundle.main, slow!.bytes);
    const runner = new DryRunner({ deadlineMs: 2000 });
    try {
      await expect(runner.run({ main: bundle.main, files }, { scale: 1 })).rejects.toThrow(/took longer than/);
      // The ended worker exits while the next run is on a new one: that run must still answer.
      const laser = await runner.run(sampleBundle('00_Basic/Laser01.efkefc'), { scale: 1 });
      expect(laser.peak.instances).toBe(122);
    } finally {
      await runner.close();
    }
  }, 60_000);
});
