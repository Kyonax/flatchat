// SPDX-License-Identifier: MPL-2.0
// The dry run in Node (S6.01, rr-013): every uploaded effect is played in the pinned runtime before
// anyone sees it (packages/effects' measure measures). The runtime cannot be stopped inside one of
// its own calls, and a broken effect can make a single update take half a minute (the fuzzing
// found one). Where the converter runs sandboxed (the core), no worker threads are allowed: there
// dryRun runs in the converter's own thread and the core gives effect conversions a short deadline
// for the whole process. Elsewhere (the host tool, the tests) a DryRunner runs each in a worker
// thread with a deadline, ends the thread past it, and keeps one worker for many effects.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { EFFECT_LIMITS, type EffectBundle } from '@flatchat/content';
import { type DryRun, DryRunFailed, type DryRunOptions, measure, type NativeFactory, standIn, type WebGLBuild } from '@flatchat/effects';

let webgl: WebGLBuild | undefined;
/** The WebGL build, read from @flatchat/effects' third_party/effekseer once; or with the
 *  WebAssembly given, where the package's files are bundled away (the client's main process). */
export async function webglBuild(wasm?: Uint8Array): Promise<WebGLBuild> {
  webgl ??= {
    factory: ((await import('@flatchat/effects/runtime/effekseer-webgl-native.js')) as { default: NativeFactory }).default,
    wasm: wasm ?? new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve('@flatchat/effects/runtime/wasm/effekseer-webgl-native.wasm')))),
  };
  return webgl;
}

/** A runtime over the stand-in context, in this thread. */
export async function standInRuntime(): ReturnType<typeof standIn> {
  return standIn(await webglBuild());
}

/** The dry run in this thread, with no deadline: for the tests and trusted files. */
export async function dryRun(bundle: EffectBundle, o: DryRunOptions): Promise<DryRun> {
  return measure(await webglBuild(), bundle, o);
}

interface Reply {
  id: number;
  ok: boolean;
  result?: DryRun;
  error?: string;
}

export interface DryRunnerOptions {
  deadlineMs?: number;
  /** Starts the worker thread (dry-run-worker.ts). The client's main process is bundled, so it
   *  passes its own (electron-vite's `?nodeWorker`), with the runtime's WebAssembly it read. */
  worker?: (o: WorkerOptions) => Worker;
  wasm?: Uint8Array;
}

/** Dry runs in a worker thread, each with a deadline. */
export class DryRunner {
  private worker: Worker | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (r: DryRun) => void; reject: (e: Error) => void }>();
  readonly deadlineMs: number;
  private readonly makeWorker: (o: WorkerOptions) => Worker;
  private readonly wasm: Uint8Array | undefined;

  constructor(o: DryRunnerOptions = {}) {
    this.deadlineMs = o.deadlineMs ?? EFFECT_LIMITS.dryRunMs;
    this.makeWorker = o.worker ?? ((w) => new Worker(new URL('./dry-run-worker.ts', import.meta.url), w));
    this.wasm = o.wasm;
  }

  private start(): Worker {
    const w = this.makeWorker({ workerData: { wasm: this.wasm } });
    w.on('message', (m: Reply) => {
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.ok && m.result) p.resolve(m.result);
      else p.reject(new DryRunFailed(m.error ?? 'the dry run failed'));
    });
    w.on('error', (err) => this.failAll(new DryRunFailed(`the dry run's worker failed: ${err.message.slice(0, 200)}`)));
    w.on('exit', () => {
      if (this.worker === w) this.worker = undefined;
      this.failAll(new DryRunFailed('the dry run stopped'));
    });
    w.unref();
    return w;
  }

  private failAll(err: Error): void {
    for (const p of this.waiting.values()) p.reject(err);
    this.waiting.clear();
  }

  /** Measures one effect; refuses it (DryRunFailed) when it fails or runs past the deadline. */
  async run(bundle: EffectBundle, o: DryRunOptions): Promise<DryRun> {
    const worker = (this.worker ??= this.start());
    const id = this.next++;
    const files = [...bundle.files].map(([path, bytes]) => [path, bytes.slice()] as const);
    return new Promise<DryRun>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiting.has(id)) return;
        this.waiting.delete(id);
        // The runtime may be inside one long call: only ending the thread stops it.
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        reject(new DryRunFailed(`the effect took longer than ${Math.round(this.deadlineMs / 1000)} s to play`));
      }, this.deadlineMs);
      this.waiting.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, main: bundle.main, files, o: { ...o, budgetMs: this.deadlineMs } });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}
