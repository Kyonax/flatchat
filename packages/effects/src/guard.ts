// SPDX-License-Identifier: Apache-2.0
// The guard layer (S6.01, rr-013): what keeps strangers' effects from costing a viewer more than
// the platform allows. Pure bookkeeping, shared by the client and the tests:
//
//   - Admission: an effect plays only if its dry run's peaks fit its owner's budget (an avatar's,
//     or the world's) and everyone's together; the runtime itself is made with the global caps.
//   - Trimming: while it plays, an owner over its budget (a seed the dry run never saw) has its
//     effects stop making particles until it is back under; those alive play out.
//   - The time watches: an effect whose drawing took longer than EFFECT_LIMITS.gpuMs on the GPU
//     for EFFECT_LIMITS.gpuFrames measured frames in a row, or whose own update took longer than
//     cpuMs for cpuFrames (or stallMs once), is stopped, and its file is not played again during
//     the visit.
import { EFFECT_LIMITS } from '@flatchat/content';

/** Who an effect belongs to: an avatar (by the world's entity number) or the world itself. */
export type Owner = number | 'world';

export interface Peaks {
  instances: number;
  quads: number;
  triangles: number;
}

export type Refusal = 'owner-budget' | 'global-budget' | 'blocked';

/** The dry-run peaks of every effect admitted, by owner and in all. */
export class EffectBudget {
  private readonly by = new Map<Owner, Map<number, Peaks>>();
  private readonly total: Peaks = { instances: 0, quads: 0, triangles: 0 };
  private readonly blocked = new Set<string>();

  /** An owner's budget: an avatar's or the world's. */
  static capOf(owner: Owner): Peaks {
    return owner === 'world' ? EFFECT_LIMITS.world : EFFECT_LIMITS.avatar;
  }

  /** What an owner's admitted effects may reach together. */
  used(owner: Owner): Peaks {
    const s: Peaks = { instances: 0, quads: 0, triangles: 0 };
    for (const p of this.by.get(owner)?.values() ?? []) {
      s.instances += p.instances;
      s.quads += p.quads;
      s.triangles += p.triangles;
    }
    return s;
  }

  get all(): Readonly<Peaks> {
    return this.total;
  }

  /** Admits effect `id` (any number unique among the owner's) with its file's hash; undefined
   *  when admitted, else why not. */
  admit(owner: Owner, id: number, file: string, peaks: Peaks): Refusal | undefined {
    if (this.blocked.has(file)) return 'blocked';
    const cap = EffectBudget.capOf(owner);
    const u = this.used(owner);
    if (u.instances + peaks.instances > cap.instances || u.quads + peaks.quads > cap.quads || u.triangles + peaks.triangles > cap.triangles) return 'owner-budget';
    if (this.total.instances + peaks.instances > EFFECT_LIMITS.instances || this.total.quads + peaks.quads > EFFECT_LIMITS.quads || this.total.triangles + peaks.triangles > EFFECT_LIMITS.triangles) return 'global-budget';
    let mine = this.by.get(owner);
    if (!mine) this.by.set(owner, (mine = new Map()));
    mine.set(id, { ...peaks });
    this.total.instances += peaks.instances;
    this.total.quads += peaks.quads;
    this.total.triangles += peaks.triangles;
    return undefined;
  }

  release(owner: Owner, id: number): void {
    const p = this.by.get(owner)?.get(id);
    if (!p) return;
    this.by.get(owner)!.delete(id);
    if (this.by.get(owner)!.size === 0) this.by.delete(owner);
    this.total.instances -= p.instances;
    this.total.quads -= p.quads;
    this.total.triangles -= p.triangles;
  }

  /** A file never played again this visit (stopped by the GPU watch, or it stopped the runtime). */
  block(file: string): void {
    this.blocked.add(file);
  }

  isBlocked(file: string): boolean {
    return this.blocked.has(file);
  }
}

/** Trimming: given each owner's live instances this frame, the owners whose effects must stop
 *  making particles (over their cap) and those that may again (back under nine tenths of it). */
export class InstanceTrim {
  private readonly trimmed = new Set<Owner>();

  step(live: ReadonlyMap<Owner, number>): { trim: Owner[]; resume: Owner[] } {
    const trim: Owner[] = [];
    const resume: Owner[] = [];
    for (const [owner, n] of live) {
      const cap = EffectBudget.capOf(owner).instances;
      if (!this.trimmed.has(owner) && n > cap) {
        this.trimmed.add(owner);
        trim.push(owner);
      } else if (this.trimmed.has(owner) && n <= cap * 0.9) {
        this.trimmed.delete(owner);
        resume.push(owner);
      }
    }
    for (const owner of [...this.trimmed]) if (!live.has(owner)) this.trimmed.delete(owner);
    return { trim, resume };
  }

  isTrimmed(owner: Owner): boolean {
    return this.trimmed.has(owner);
  }
}

/** A time watch: fed the measured time of each playing effect (by handle, in milliseconds), it
 *  names the ones to stop: over `limitMs` for `frames` measured frames in a row, or over `stallMs`
 *  once. A frame with no measurement for a handle neither counts nor resets it. */
export class TimeWatch {
  private readonly over = new Map<number, number>();
  readonly limitMs: number;
  readonly frames: number;
  readonly stallMs: number;

  constructor(o: { limitMs: number; frames: number; stallMs?: number }) {
    this.limitMs = o.limitMs;
    this.frames = o.frames;
    this.stallMs = o.stallMs ?? Infinity;
  }

  /** The GPU watch: EFFECT_LIMITS.gpuMs for EFFECT_LIMITS.gpuFrames frames. */
  static gpu(): TimeWatch {
    return new TimeWatch({ limitMs: EFFECT_LIMITS.gpuMs, frames: EFFECT_LIMITS.gpuFrames });
  }

  /** The CPU watch on each effect's update: EFFECT_LIMITS.cpuMs for cpuFrames, or stallMs once. */
  static cpu(): TimeWatch {
    return new TimeWatch({ limitMs: EFFECT_LIMITS.cpuMs, frames: EFFECT_LIMITS.cpuFrames, stallMs: EFFECT_LIMITS.stallMs });
  }

  report(ms: ReadonlyMap<number, number>): number[] {
    const stop: number[] = [];
    for (const [handle, t] of ms) {
      if (t > this.stallMs) {
        stop.push(handle);
        this.over.delete(handle);
      } else if (t > this.limitMs) {
        const n = (this.over.get(handle) ?? 0) + 1;
        this.over.set(handle, n);
        if (n >= this.frames) {
          stop.push(handle);
          this.over.delete(handle);
        }
      } else this.over.delete(handle);
    }
    return stop;
  }

  forget(handle: number): void {
    this.over.delete(handle);
  }
}
