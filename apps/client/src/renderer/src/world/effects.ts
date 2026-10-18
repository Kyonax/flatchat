// SPDX-License-Identifier: MPL-2.0
// Effects in the world (S6.01): the effects players wear, played in the pinned Effekseer runtime
// (packages/effects) and kept within budget by its guard layer. An avatar's effect rides a marker
// at its attachment point (avatar-layer.ts puts one there, as for a prop); it loops while worn.
//
//   - Who shows: the viewer's policy (`allowed`): effects on, the person's avatar not shielded or
//     hidden, and a stranger's only when the viewer allows strangers' effects (Q-M10).
//   - Admission: an effect plays only if its dry run's peaks fit its owner's budget and everyone's
//     together; the runtime is made with the global caps.
//   - While it plays: its update is timed alone each frame (the CPU watch), its drawing on the GPU
//     when the GPU can say (the GPU watch); one over the line is stopped and its file not played
//     again this visit. An owner over its particle budget stops making particles until back under.
//   - A runtime that gives up (a broken file) is replaced, the effect that did it blocked, the rest
//     played again.
//
// A world's effects (its scenes' markers) play where the world put them, looping, owned by the
// world. A world comes from its host, who is not trusted: each of its effects is checked by the
// upload rules and measured here first, in a worker (effects-measure.ts), and those numbers, not
// the host's, decide.
//
// The runtime loads only when the first effect is admitted, on the renderer's backend; it draws
// after three's frame (effects-draw.ts).
import * as THREE from 'three/webgpu';
import { type BuiltEffect, type EffectBundle, type EffectFit, effectFitProblems, readBundle } from '@flatchat/content';
import { EffectBudget, EffectsRuntime, type EffectImage, InstanceTrim, type LoadedEffect, type Owner, RuntimeSpent, TimeWatch } from '@flatchat/effects';
import { type DrawResult, WebGlEffectsDraw, WebGpuEffectsDraw } from './effects-draw';
import type { EffectMeasurer } from './effects-measure';
import { effectsBuild } from './effects-runtime';

/** Where the avatar layer hands its worn effects (implemented by EffectsLayer). */
export interface EffectSink {
  wear(owner: Owner, item: string, fit: EffectFit, marker: THREE.Object3D): number;
  takeOff(id: number): void;
}

/** An effect's bundle, by the item that carries it. */
export type BundleFetcher = (item: string) => Promise<Uint8Array>;

export interface EffectStats {
  /** Effects playing now (the world's among them), and their particles. */
  playing: number;
  world: number;
  instances: number;
  /** Effects not played: over a budget, blocked, or not allowed (Q-M10); and why the last one was
   *  (a world's effect that did not pass the client's own check, or its budget). */
  refused: number;
  refusedWhy: string;
  /** Effects stopped by the guard this visit. */
  stopped: number;
  /** Whether the scene's depth hid effects behind what stands in front of them. */
  depth: boolean;
  backend: string;
  /** The runtime could not start here: no effects this visit. */
  failed: boolean;
}

interface WornEffect {
  id: number;
  owner: Owner;
  item: string;
  fit: EffectFit;
  marker: THREE.Object3D;
  admitted: boolean;
  handle?: number;
  refused?: boolean;
  /** Frames since it last started: its first ones (a procedural mesh made, pipelines compiled)
   *  are not held against it. */
  age: number;
}

/** Frames after a start whose times the watches leave out. */
const WARM_UP = 5;

interface Loaded {
  bundle?: EffectBundle;
  effect?: LoadedEffect;
  loading?: Promise<LoadedEffect | undefined>;
}

const visible = (o: THREE.Object3D): boolean => {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
};

/** A world effect's slowest update in the client's dry run, at most: far above a busy worker's
 *  scheduling noise (a loaded machine drawing in software paused the worker past 100 ms), far
 *  below the runtime's worst (a broken file took 32 s). */
const WORLD_HITCH_US = 1_000_000;

export class EffectsLayer implements EffectSink {
  readonly stats: EffectStats = { playing: 0, world: 0, instances: 0, refused: 0, refusedWhy: '', stopped: 0, depth: false, backend: '', failed: false };
  /** The viewer's policy: whether an owner's effects show. */
  allowed: (owner: Owner) => boolean = () => true;
  private runtime: EffectsRuntime | undefined;
  private starting: Promise<EffectsRuntime | undefined> | undefined;
  private drawer: WebGpuEffectsDraw | WebGlEffectsDraw | undefined;
  private readonly worn = new Map<number, WornEffect>();
  private readonly files = new Map<string, Loaded>();
  private budget = new EffectBudget();
  private readonly trim = new InstanceTrim();
  private readonly cpu = TimeWatch.cpu();
  private readonly gpu = TimeWatch.gpu();
  private probeOver = false;
  private nextId = 1;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly fetchBundle: BundleFetcher;
  /** A bundle's own source, for effects not fetched by item (a world's). */
  private readonly sources = new Map<string, () => Promise<Uint8Array>>();
  private measurer: EffectMeasurer | undefined;

  constructor(renderer: THREE.WebGPURenderer, fetchBundle: BundleFetcher) {
    this.renderer = renderer;
    this.fetchBundle = fetchBundle;
  }

  /** A world's effect: measured here first (the host's numbers are not taken), then played at its
   *  marker for the world. Resolves with its id, or undefined when it was refused. */
  async wearWorld(e: BuiltEffect, marker: THREE.Object3D, bytes: Uint8Array): Promise<number | undefined> {
    // Loaded when a world first has effects: the measuring worker carries the WebGL build inlined.
    this.measurer ??= new (await import('./effects-measure')).EffectMeasurer();
    let measured;
    try {
      measured = await this.measurer.measure(bytes, e.scale);
    } catch (err) {
      this.stats.refused += 1;
      this.stats.refusedWhy = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      return undefined;
    }
    const { run, stats } = measured;
    const fit: EffectFit = { file: e.file, bytes: bytes.length, ...stats, peak: run.peak, frames: run.frames, scale: e.scale, updateUs: run.updateUs };
    // Its peaks decide here. Its time is judged on this machine while it plays (the watches): the
    // dry run's update limit is for the converter's machine, and a weak laptop is slower. One
    // update the dry run saw take a whole second would freeze the view as long, so that refuses.
    const problems = [...(run.missing.length ? [`it asked for ${run.missing.join(', ')}, which its bundle lacks`] : []), ...(run.slowestUs > WORLD_HITCH_US ? [`one of its updates took ${Math.round(run.slowestUs / 1000)} ms`] : []), ...effectFitProblems({ ...fit, updateUs: 0 }, 'world')];
    if (problems.length) {
      this.stats.refused += 1;
      this.stats.refusedWhy = problems.join('; ').slice(0, 200);
      return undefined;
    }
    this.sources.set(e.file, async () => bytes);
    return this.wear('world', e.file, fit, marker);
  }

  wear(owner: Owner, item: string, fit: EffectFit, marker: THREE.Object3D): number {
    const w: WornEffect = { id: this.nextId++, owner, item, fit, marker, admitted: false, age: 0 };
    this.worn.set(w.id, w);
    this.consider(w);
    return w.id;
  }

  takeOff(id: number): void {
    const w = this.worn.get(id);
    if (!w) return;
    this.worn.delete(id);
    this.release(w);
  }

  /** Looks again at who may show (the policy changed). */
  refresh(): void {
    for (const w of this.worn.values()) {
      if (w.admitted && !this.allowed(w.owner)) this.release(w);
      else if (!w.admitted) this.consider(w);
    }
  }

  private release(w: WornEffect): void {
    if (w.handle !== undefined && this.runtime && !this.runtime.isSpent) {
      try {
        this.runtime.stop(w.handle);
      } catch {
        // A spent runtime stops nothing; the next frame replaces it.
      }
    }
    if (w.handle !== undefined) {
      this.cpu.forget(w.handle);
      this.gpu.forget(w.handle);
    }
    w.handle = undefined;
    if (w.admitted) this.budget.release(w.owner, w.id);
    w.admitted = false;
  }

  private consider(w: WornEffect): void {
    if (this.stats.failed || w.admitted || !this.allowed(w.owner)) return;
    const refusal = this.budget.admit(w.owner, w.id, w.fit.file, w.fit.peak);
    if (refusal) {
      if (!w.refused) {
        this.stats.refused += 1;
        this.stats.refusedWhy = refusal;
      }
      w.refused = true;
      return;
    }
    w.admitted = true;
    w.refused = false;
    void this.start(w);
  }

  private async start(w: WornEffect): Promise<void> {
    const runtime = await this.ensureRuntime();
    const loaded = runtime ? await this.load(runtime, w) : undefined;
    // Taken off, or no longer allowed, while it loaded.
    if (!loaded || !runtime || !w.admitted || this.worn.get(w.id) !== w || runtime !== this.runtime || runtime.isSpent) return;
    try {
      w.handle = runtime.play(loaded);
      w.age = 0;
    } catch (err) {
      this.fail(err, w.fit.file);
    }
  }

  private ensureRuntime(): Promise<EffectsRuntime | undefined> {
    if (this.runtime && !this.runtime.isSpent) return Promise.resolve(this.runtime);
    this.starting ??= (async () => {
      const backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl';
      try {
        const build = await effectsBuild(backend);
        const b = this.renderer.backend as unknown as { device?: GPUDevice; gl?: WebGL2RenderingContext };
        const runtime =
          backend === 'webgpu'
            ? await EffectsRuntime.create({ backend, factory: build.factory, wasm: build.wasm, device: b.device!, width: 16, height: 16 })
            : await EffectsRuntime.create({ backend, factory: build.factory, wasm: build.wasm, gl: b.gl! });
        this.drawer?.dispose();
        this.drawer = backend === 'webgpu' ? new WebGpuEffectsDraw(this.renderer) : new WebGlEffectsDraw(this.renderer, runtime);
        this.runtime = runtime;
        this.stats.backend = backend;
        // The bundles stay; what the old runtime loaded from them does not.
        for (const f of this.files.values()) {
          f.effect = undefined;
          f.loading = undefined;
        }
        return runtime;
      } catch {
        this.stats.failed = true;
        return undefined;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  private load(runtime: EffectsRuntime, w: WornEffect): Promise<LoadedEffect | undefined> {
    let entry = this.files.get(w.fit.file);
    if (!entry) this.files.set(w.fit.file, (entry = {}));
    if (entry.effect) return Promise.resolve(entry.effect);
    if (entry.loading) return entry.loading;
    const f = entry;
    f.loading = (async () => {
      try {
        f.bundle ??= readBundle(await (this.sources.get(w.fit.file)?.() ?? this.fetchBundle(w.item)));
        const images = runtime.backend === 'webgl' ? await decodeImages(f.bundle) : undefined;
        if (runtime !== this.runtime || runtime.isSpent) return undefined;
        f.effect = runtime.load(f.bundle, { scale: w.fit.scale, ...(images ? { images } : {}), sounds: false });
        return f.effect;
      } catch (err) {
        this.fail(err, w.fit.file);
        return undefined;
      } finally {
        f.loading = undefined;
      }
    })();
    return f.loading;
  }

  /** An effect's file failed: blocked for the visit; a spent runtime is replaced on the next frame. */
  private fail(err: unknown, file: string): void {
    this.budget.block(file);
    for (const w of this.worn.values()) if (w.fit.file === file && w.admitted) this.release(w);
    this.stats.stopped += 1;
    if (err instanceof RuntimeSpent) this.respawn();
  }

  private respawn(): void {
    const old = this.runtime;
    this.runtime = undefined;
    old?.dispose();
    // Every admitted effect plays again in the new runtime, but those blocked.
    const again = [...this.worn.values()].filter((w) => w.admitted);
    for (const w of again) this.release(w);
    this.budget = rebuilt(this.budget);
    for (const w of again) this.consider(w);
  }

  /** After three's frame: places, steps, guards and draws the effects; `depth` is the scene's when a
   *  world's look pipeline drew it (look.ts), else three's own is used. */
  frame(camera: THREE.Camera, dt: number, depth?: THREE.Texture): void {
    const runtime = this.runtime;
    if (!runtime || runtime.isSpent) {
      if (runtime?.isSpent) this.respawn();
      this.stats.playing = 0;
      this.stats.world = 0;
      this.stats.instances = 0;
      return;
    }
    const playing = [...this.worn.values()].filter((w) => w.handle !== undefined);
    this.stats.playing = playing.length;
    this.stats.world = playing.filter((w) => w.owner === 'world').length;
    if (playing.length === 0) {
      this.stats.instances = 0;
      return;
    }
    let culprit: WornEffect | undefined;
    try {
      const shown: number[] = [];
      for (const w of playing) {
        culprit = w;
        // A worn effect loops: one that ended starts again.
        if (!runtime.exists(w.handle!)) {
          const f = this.files.get(w.fit.file);
          if (!f?.effect) continue;
          this.cpu.forget(w.handle!);
          this.gpu.forget(w.handle!);
          w.handle = runtime.play(f.effect);
          w.age = 0;
        }
        w.age += 1;
        const on = visible(w.marker);
        runtime.setShown(w.handle!, on);
        runtime.setMatrix(w.handle!, w.marker.matrixWorld.elements);
        if (on) shown.push(w.handle!);
      }
      culprit = undefined;
      // Each effect stepped alone and timed: the CPU watch.
      const took = runtime.updateTimed(
        playing.map((w) => w.handle!),
        Math.min(dt, 0.25) * 60,
      );
      const warm = new Set(playing.filter((w) => w.age > WARM_UP).map((w) => w.handle!));
      for (const h of this.cpu.report(new Map([...took].filter(([h]) => warm.has(h))))) this.stopHandle(h);
      // Particles alive per owner: an owner over its budget stops making them for a while.
      const live = new Map<Owner, number>();
      let instances = 0;
      for (const w of playing) {
        if (w.handle === undefined) continue;
        const n = runtime.instances(w.handle);
        instances += n;
        live.set(w.owner, (live.get(w.owner) ?? 0) + n);
      }
      this.stats.instances = instances;
      const { trim, resume } = this.trim.step(live);
      for (const w of playing) {
        if (w.handle === undefined) continue;
        if (trim.includes(w.owner)) runtime.setSpawnDisabled(w.handle, true);
        if (resume.includes(w.owner)) runtime.setSpawnDisabled(w.handle, false);
      }
      if (!this.drawer || shown.length === 0) return;
      camera.updateMatrixWorld();
      runtime.setCamera(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements);
      const drawn: DrawResult = this.drawer instanceof WebGpuEffectsDraw ? this.drawer.draw(runtime, shown, this.probeOver, depth) : this.drawer.draw(runtime, shown, depth);
      this.stats.depth = drawn.depth;
      if (drawn.gpuMs) {
        const whole = drawn.gpuMs.get(-1);
        if (whole !== undefined) this.probeOver = whole > this.gpu.limitMs;
        else for (const h of this.gpu.report(new Map([...drawn.gpuMs].filter(([h]) => warm.has(h))))) this.stopHandle(h);
      }
    } catch (err) {
      if (culprit) this.fail(err, culprit.fit.file);
      else if (err instanceof RuntimeSpent) {
        // Spent while stepping or drawing every effect: the newest one admitted is the likeliest.
        const newest = [...this.worn.values()].filter((w) => w.admitted).sort((a, b) => b.id - a.id)[0];
        if (newest) this.fail(err, newest.fit.file);
        else this.respawn();
      } else throw err;
    }
  }

  private stopHandle(handle: number): void {
    const w = [...this.worn.values()].find((x) => x.handle === handle);
    if (!w) return;
    this.budget.block(w.fit.file);
    this.release(w);
    this.stats.stopped += 1;
  }

  dispose(): void {
    for (const w of this.worn.values()) this.release(w);
    this.worn.clear();
    this.measurer?.dispose();
    this.drawer?.dispose();
    this.runtime?.dispose();
    this.runtime = undefined;
  }
}

/** A new budget that keeps the old one's blocked files. */
function rebuilt(old: EffectBudget): EffectBudget {
  const b = new EffectBudget();
  for (const file of old.blockedFiles()) b.block(file);
  return b;
}

/** The bundle's PNGs decoded as the WebGL build uploads them: no premultiplying, no colour change. */
async function decodeImages(bundle: EffectBundle): Promise<Map<string, EffectImage>> {
  const out = new Map<string, EffectImage>();
  for (const [path, bytes] of bundle.files) {
    if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) continue;
    out.set(path, await createImageBitmap(new Blob([bytes.slice()]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
  }
  return out;
}
