// SPDX-License-Identifier: MPL-2.0
// Measuring a world's effect before it plays (S6.01): one worker (effects-measure-worker.ts,
// inlined, so it starts under the page's policy), effects measured one at a time, the worker ended
// and replaced when one runs past the deadline (a broken effect can stall the runtime in one call).
import type { EffectFit } from '@flatchat/content';
import type { DryRun } from '@flatchat/effects';
import MeasureWorker from './effects-measure-worker?worker&inline';

/** What the worker read of the effect besides its dry run. */
export type EffectStatsRead = Pick<EffectFit, 'version' | 'textures' | 'texturePixels' | 'models' | 'sounds' | 'distortion'>;

export interface Measured {
  run: DryRun;
  stats: EffectStatsRead;
}

/** How long one effect's measuring may take here: longer than the converter's 20 s, because this is
 *  a viewer's machine, maybe a weak or busy one, and the measuring runs beside the view without
 *  holding it up (a loaded desktop took over 20 s for the tornado). It only has to stop a broken
 *  effect, whose single update can take half a minute. */
export const MEASURE_MS = 45_000;

export class EffectMeasurer {
  private worker: Worker | undefined;
  private next = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Checks and measures one effect's bundle; rejects when it breaks a rule, does not play or runs
   *  past the deadline. */
  measure(bytes: Uint8Array, scale: number): Promise<Measured> {
    const run = this.queue.then(() => this.one(bytes, scale));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private one(bytes: Uint8Array, scale: number): Promise<Measured> {
    const worker = (this.worker ??= new MeasureWorker());
    const id = this.next++;
    return new Promise<Measured>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        reject(new Error(`the effect took longer than ${MEASURE_MS / 1000} s to play`));
      }, MEASURE_MS);
      const done = (ev: MessageEvent<{ id: number; ok: boolean; result?: DryRun; stats?: EffectStatsRead; error?: string }>): void => {
        if (ev.data.id !== id) return;
        clearTimeout(timer);
        worker.removeEventListener('message', done);
        if (ev.data.ok && ev.data.result && ev.data.stats) resolve({ run: ev.data.result, stats: ev.data.stats });
        else reject(new Error(ev.data.error ?? 'the effect does not play'));
      };
      worker.addEventListener('message', done);
      worker.postMessage({ id, bytes: bytes.slice(), scale });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}
