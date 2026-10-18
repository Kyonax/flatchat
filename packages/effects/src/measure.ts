// SPDX-License-Identifier: Apache-2.0
// The dry run's measurement (S6.01, rr-013), with web APIs only, so the converter (Node, dry-run.ts)
// and the client (a worker, for a world's effects, which come from its host) measure alike. It
// plays an effect from the start with each of a few random seeds, frame by frame at 60 a second,
// in the WebGL build over the stand-in context (stub-gl.ts), and keeps the most it had alive
// (instances), the most it drew in one frame (quads, and its models' triangles), its length (or
// that it loops) and how long its updates took: the 95th percentile, which a busy machine's odd
// slow frame does not move (the slowest alone did, in CI-like runs), and the slowest. It stops
// when the whole run passes its time budget: one update the runtime cannot be interrupted in is
// the caller's to bound, in a thread it can end.
import { EFFECT_LIMITS, type EffectBundle, imageSize } from '@flatchat/content';
import type { NativeFactory } from './native.ts';
import { type EffectImage, EffectsRuntime, RuntimeSpent } from './runtime.ts';
import { stubGl } from './stub-gl.ts';

/** The WebGL build: its module factory and its WebAssembly. */
export interface WebGLBuild {
  factory: NativeFactory;
  wasm: Uint8Array;
}

/** A runtime over the stand-in context, and its draw counter. */
export async function standIn(build: WebGLBuild): Promise<{ runtime: EffectsRuntime; stub: ReturnType<typeof stubGl> }> {
  const stub = stubGl();
  const runtime = await EffectsRuntime.create({ backend: 'webgl', factory: build.factory, wasm: build.wasm, gl: stub.gl });
  // A camera 10 m from the effect, so nothing is culled or drawn at a distant level of detail.
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  runtime.setCamera(identity, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]);
  return { runtime, stub };
}

/** The sizes of a bundle's images, for the stand-in (it uploads nothing). */
export function imageSizes(bundle: EffectBundle): Map<string, EffectImage> {
  const out = new Map<string, EffectImage>();
  for (const [path, bytes] of bundle.files) {
    const size = imageSize(bytes);
    if (size) out.set(path, size);
  }
  return out;
}

export interface DryRun {
  peak: { instances: number; quads: number; triangles: number };
  /** Frames until it ended, or null when it was still playing at the end (a loop). */
  frames: number | null;
  /** Its updates' 95th percentile, and the slowest, in microseconds. */
  updateUs: number;
  slowestUs: number;
  /** What it asked for, and what the bundle lacked. */
  asked: string[];
  missing: string[];
}

export interface DryRunOptions {
  scale: number;
  frames?: number;
  seeds?: readonly number[];
  /** The whole run's time budget, in milliseconds (EFFECT_LIMITS.dryRunMs). */
  budgetMs?: number;
}

export class DryRunFailed extends Error {}

/** Plays an effect from its bundle with each seed and measures it. Throws DryRunFailed when the
 *  runtime cannot read it, gives up on it, or the run passes its time budget. */
export async function measure(build: WebGLBuild, bundle: EffectBundle, o: DryRunOptions): Promise<DryRun> {
  const frames = o.frames ?? EFFECT_LIMITS.dryRunFrames;
  const seeds = o.seeds ?? EFFECT_LIMITS.dryRunSeeds;
  const budget = o.budgetMs ?? EFFECT_LIMITS.dryRunMs;
  const { runtime, stub } = await standIn(build);
  const started = performance.now();
  const peak = { instances: 0, quads: 0, triangles: 0 };
  let length: number | null = 0;
  const updates: number[] = [];
  try {
    const effect = runtime.load(bundle, { scale: o.scale, images: imageSizes(bundle), sounds: false });
    for (const seed of seeds) {
      const handle = runtime.play(effect, seed);
      let ended = false;
      for (let f = 1; f <= frames; f++) {
        const t0 = performance.now();
        runtime.update(1);
        updates.push(Math.round((performance.now() - t0) * 1000));
        stub.reset();
        runtime.drawGl();
        peak.instances = Math.max(peak.instances, runtime.instances(handle));
        peak.quads = Math.max(peak.quads, stub.count.quads);
        peak.triangles = Math.max(peak.triangles, stub.count.modelTriangles);
        if (performance.now() - started > budget) throw new DryRunFailed(`the effect took longer than ${Math.round(budget / 1000)} s to play`);
        if (!runtime.exists(handle)) {
          if (length !== null) length = Math.max(length, f);
          ended = true;
          break;
        }
      }
      if (!ended) length = null;
      runtime.stop(handle);
      runtime.update(1);
    }
    updates.sort((a, b) => a - b);
    const updateUs = updates[Math.min(updates.length - 1, Math.floor(updates.length * 0.95))] ?? 0;
    return { peak, frames: length, updateUs, slowestUs: updates[updates.length - 1] ?? 0, asked: effect.asked, missing: effect.missing };
  } catch (err) {
    if (err instanceof DryRunFailed) throw err;
    if (err instanceof RuntimeSpent) throw new DryRunFailed('the effect stopped the runtime');
    throw new DryRunFailed(err instanceof Error ? err.message : String(err));
  } finally {
    runtime.dispose();
  }
}
