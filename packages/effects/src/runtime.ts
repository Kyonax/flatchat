// SPDX-License-Identifier: Apache-2.0
// One running copy of the pinned Effekseer runtime (S6.01): made once per world visit on the
// client's renderer (WebGPU, or WebGL2 when the renderer fell back), or in Node over the stand-in
// context for the converter's dry run. It loads effects from their bundles (every file in memory,
// images decoded beforehand, so the runtime's synchronous file requests are answered at once),
// plays them, moves them, and draws them into the frame the client hands it.
//
// A hostile or broken file can make the runtime give up (an abort, a trap). After that the module
// is spent: every call throws RuntimeSpent, and the owner makes a new runtime without the effect
// that did it (packages/effects' guard; the client's effects layer).
import { bundleFile, bundlePathOf, EFFECT_LIMITS, type EffectBundle } from '@flatchat/content';
import { bindNative, isNativeFailure, type Native, type NativeFactory, type NativeModule, WEBGPU_COLOR_FORMATS, WEBGPU_DEPTH_FORMATS } from './native.ts';

export class RuntimeSpent extends Error {
  constructor(cause: unknown) {
    super(`the effects runtime stopped: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
  }
}

export interface RuntimeOptions {
  factory: NativeFactory;
  /** The build's .wasm, already fetched or read (nothing is fetched by the module itself). */
  wasm: Uint8Array;
  instances?: number;
  quads?: number;
}

/** The runtime takes the graphics objects as they are and never looks inside them, so this
 *  package needs no DOM or WebGPU types: a WebGL2RenderingContext, a GPUDevice, a render pass. */
export type GraphicsObject = object;

export interface WebGLRuntimeOptions extends RuntimeOptions {
  backend: 'webgl';
  /** A WebGL2RenderingContext (the client's, or the stand-in). */
  gl: GraphicsObject;
}

export interface WebGPURuntimeOptions extends RuntimeOptions {
  backend: 'webgpu';
  /** The renderer's GPUDevice. */
  device: GraphicsObject;
  width: number;
  height: number;
}

/** An image the WebGL build uploads as it is: an ImageBitmap in the client; in Node, only its size. */
export type EffectImage = { width: number; height: number };

export interface LoadOptions {
  /** The creator's scale for the effect. */
  scale: number;
  /** The bundle's images, decoded (WebGL build only: the WebGPU build decodes its own). */
  images?: ReadonlyMap<string, EffectImage>;
  /** Whether the effect's sounds load (Q-H1: never on avatars). Without them it plays silent. */
  sounds: boolean;
}

/** A loaded effect: the runtime's pointer to it, and the paths it asked for. */
export interface LoadedEffect {
  ptr: number;
  asked: string[];
  missing: string[];
}

const SOUND = /\.(wav|ogg|mp3)$/i;

export class EffectsRuntime {
  readonly backend: 'webgl' | 'webgpu';
  readonly module: NativeModule;
  readonly native: Native;
  readonly ctx: number;
  private glHandle = 0;
  private spent: RuntimeSpent | undefined;
  private matrix = 0;

  private constructor(backend: 'webgl' | 'webgpu', module: NativeModule, ctx: number, glHandle: number) {
    this.backend = backend;
    this.module = module;
    this.native = bindNative(module);
    this.ctx = ctx;
    this.glHandle = glHandle;
    this.matrix = module._malloc(16 * 4);
  }

  static async create(o: WebGLRuntimeOptions | WebGPURuntimeOptions): Promise<EffectsRuntime> {
    const module = await o.factory({
      wasmBinary: o.wasm,
      print: () => undefined,
      printErr: () => undefined,
      ...(o.backend === 'webgpu' ? { preinitializedWebGPUDevice: o.device } : {}),
    });
    const native = bindNative(module);
    native.setLogEnabled(0);
    const instances = o.instances ?? EFFECT_LIMITS.instances;
    const quads = o.quads ?? EFFECT_LIMITS.quads;
    if (o.backend === 'webgl') {
      if (!module.GL) throw new Error('the WebGL build has no GL object');
      const handle = module.GL.registerContext(o.gl, { majorVersion: 2, minorVersion: 0, enableExtensionsByDefault: true });
      module.GL.makeContextCurrent(handle);
      const ctx = native.initWebGL(instances, quads, 1, 0);
      if (!ctx) throw new Error('the effects runtime did not start on WebGL');
      const r = new EffectsRuntime('webgl', module, ctx, handle);
      // The client restores three's state itself (renderer.resetState()), so the runtime need not.
      native.setRestoration(ctx, 0);
      return r;
    }
    const ctx = native.initWebGPU(instances, quads, Math.max(1, o.width), Math.max(1, o.height), 0, 0);
    if (!ctx) throw new Error('the effects runtime did not start on WebGPU');
    return new EffectsRuntime('webgpu', module, ctx, 0);
  }

  /** Runs a native call; a runtime that gives up is spent from then on. */
  private call<T>(fn: () => T): T {
    if (this.spent) throw this.spent;
    try {
      return fn();
    } catch (err) {
      if (err instanceof RuntimeSpent) throw err;
      if (isNativeFailure(err) || err instanceof TypeError || err instanceof RangeError) {
        this.spent = new RuntimeSpent(err);
        throw this.spent;
      }
      throw err;
    }
  }

  get isSpent(): boolean {
    return this.spent !== undefined;
  }

  /** Loads an effect from its bundle. Throws when the runtime cannot read it; a file it asks for
   *  that the bundle lacks is listed in `missing` (the converter refuses those). */
  load(bundle: EffectBundle, o: LoadOptions): LoadedEffect {
    const main = bundle.files.get(bundle.main)!;
    const asked: string[] = [];
    const missing: string[] = [];
    const m = this.module;
    m._loadBinary = (path: string) => {
      if (!asked.includes(path)) asked.push(path);
      if (SOUND.test(path) && !o.sounds) return null;
      const b = bundleFile(bundle, path);
      if (!b) {
        if (!missing.includes(path)) missing.push(path);
        return null;
      }
      return b.slice().buffer as ArrayBuffer;
    };
    m._loadImage = (path: string) => {
      if (!asked.includes(path)) asked.push(path);
      const key = o.images ? bundlePathOf(o.images.keys(), path) : undefined;
      const img = key === undefined ? undefined : o.images!.get(key);
      if (!img && !missing.includes(path)) missing.push(path);
      return img ?? null;
    };
    m._isPowerOfTwo = (i) => i.width > 0 && i.height > 0 && (i.width & (i.width - 1)) === 0 && (i.height & (i.height - 1)) === 0;
    try {
      const ptr = this.call(() => {
        this.current();
        const at = m._malloc(main.length);
        m.HEAPU8.set(main, at);
        try {
          return this.native.loadEffect(this.ctx, at, main.length, o.scale);
        } finally {
          m._free(at);
        }
      });
      if (!ptr) throw new Error('the runtime could not read the effect');
      return { ptr, asked, missing };
    } finally {
      m._loadBinary = () => null;
      m._loadImage = () => null;
    }
  }

  release(effect: LoadedEffect): void {
    this.call(() => this.native.releaseEffect(this.ctx, effect.ptr));
  }

  /** Starts an effect at the origin; returns its handle. */
  play(effect: LoadedEffect, seed?: number): number {
    return this.call(() => {
      const h = this.native.play(this.ctx, effect.ptr, 0, 0, 0);
      if (seed !== undefined) this.native.setRandomSeed(this.ctx, h, seed);
      return h;
    });
  }

  stop(handle: number): void {
    this.call(() => this.native.stop(this.ctx, handle));
  }

  stopAll(): void {
    this.call(() => this.native.stopAll(this.ctx));
  }

  exists(handle: number): boolean {
    return this.call(() => this.native.exists(this.ctx, handle) !== 0);
  }

  /** Places a playing effect: a 4×4 matrix as three.js keeps one (column-major). */
  setMatrix(handle: number, m: ArrayLike<number>): void {
    this.call(() => {
      this.module.HEAPF32.set(m as Float32Array | number[], this.matrix >> 2);
      this.native.setMatrix(this.ctx, handle, this.matrix);
    });
  }

  setShown(handle: number, shown: boolean): void {
    this.call(() => this.native.setShown(this.ctx, handle, shown ? 1 : 0));
  }

  /** Stops an effect making new particles (the guard trims it); those alive play out. */
  setSpawnDisabled(handle: number, disabled: boolean): void {
    this.call(() => this.native.setSpawnDisabled(this.ctx, handle, disabled ? 1 : 0));
  }

  instances(handle: number): number {
    return this.call(() => this.native.instanceCount(this.ctx, handle));
  }

  totalInstances(): number {
    return this.call(() => this.native.totalInstances(this.ctx));
  }

  /** The runtime's last update and draw times, in microseconds (its own clock, on the CPU). */
  times(): { updateUs: number; drawUs: number } {
    return this.call(() => ({ updateUs: this.native.updateTime(this.ctx), drawUs: this.native.drawTime(this.ctx) }));
  }

  /** WebGL only: the runtime's GPU timer (the browser's timer queries), per effect. */
  enableGpuTimer(): boolean {
    return this.call(() => this.native.enableGpuTimer(this.ctx) !== 0);
  }

  /** The GPU time of a playing effect's drawing, in microseconds, when the timer runs. */
  gpuTime(handle: number): number {
    return this.call(() => this.native.gpuTime(this.ctx, handle));
  }

  /** Steps every playing effect: `frames` at 60 a second. */
  update(frames: number): void {
    this.call(() => this.native.update(this.ctx, frames));
  }

  /** Steps each playing effect on its own and times it (milliseconds, by handle), for the guard's
   *  CPU watch: the same work as update(), one call per effect. */
  updateTimed(handles: Iterable<number>, frames: number): Map<number, number> {
    return this.call(() => {
      const ms = new Map<number, number>();
      this.native.beginUpdate(this.ctx);
      try {
        for (const h of handles) {
          const t0 = performance.now();
          this.native.updateHandle(this.ctx, h, frames);
          ms.set(h, performance.now() - t0);
        }
      } finally {
        this.native.endUpdate(this.ctx);
      }
      return ms;
    });
  }

  /** The camera, as three.js keeps them: its projection and its world inverse. */
  setCamera(projection: ArrayLike<number>, view: ArrayLike<number>): void {
    this.call(() => {
      this.module.HEAPF32.set(projection as Float32Array | number[], this.matrix >> 2);
      this.native.setProjection(this.ctx, this.matrix);
      this.module.HEAPF32.set(view as Float32Array | number[], this.matrix >> 2);
      this.native.setCamera(this.ctx, this.matrix);
    });
  }

  private current(): void {
    if (this.backend === 'webgl') this.module.GL!.makeContextCurrent(this.glHandle);
  }

  /** WebGL: draws every shown effect into the bound framebuffer. */
  drawGl(): void {
    this.call(() => {
      this.current();
      this.native.draw(this.ctx);
    });
  }

  /** WebGPU: records every shown effect into a render pass the client began (single-sampled,
   *  its colour and depth formats among WEBGPU_COLOR_FORMATS and WEBGPU_DEPTH_FORMATS). */
  drawPass(pass: GraphicsObject, colorFormat: string, depthFormat: string): void {
    const color = WEBGPU_COLOR_FORMATS[colorFormat];
    const depth = WEBGPU_DEPTH_FORMATS[depthFormat];
    if (!color || !depth) throw new Error(`the effects runtime cannot draw into ${colorFormat} with ${depthFormat}`);
    this.call(() => {
      const imported = this.module.__effekseerImportWebGPURenderPassEncoder!(pass);
      if (this.native.drawToPass(this.ctx, imported, color, depth) === 0) {
        this.native.releasePass(imported);
        throw new Error('the effects runtime could not draw into the pass');
      }
    });
  }

  /** Stops everything and frees the runtime's context (nothing more may be called). */
  dispose(): void {
    if (this.spent) return;
    try {
      this.native.stopAll(this.ctx);
      this.native.terminate(this.ctx);
      this.module._free(this.matrix);
    } catch {
      // A runtime that cannot stop cleanly is dropped all the same.
    }
    this.spent = new RuntimeSpent('disposed');
  }
}
