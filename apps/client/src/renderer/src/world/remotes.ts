// SPDX-License-Identifier: MPL-2.0
// Other players' positions arrive 20, 5 or 1 times a second depending on distance (interest tiers,
// dp-008). Each is drawn a little in the past, between the two updates around that moment, so
// movement is smooth whatever the rate: the delay follows each player's own update interval (at
// least 100 ms near, about a second far away). Pure, so it is tested in plain Node.

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Sample extends Pose {
  t: number;
}

const KEEP = 8;
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 1300;

/** The shortest turn from a to b, in radians. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

export class Remotes {
  private readonly samples = new Map<number, Sample[]>();
  private readonly delay = new Map<number, number>();

  push(entity: number, t: number, pose: Pose): void {
    let list = this.samples.get(entity);
    if (!list) {
      list = [];
      this.samples.set(entity, list);
    }
    const last = list[list.length - 1];
    if (last && t <= last.t) return;
    if (last) {
      // The delay follows this player's update interval: a little more than one gap.
      const gap = t - last.t;
      const was = this.delay.get(entity) ?? MIN_DELAY_MS;
      this.delay.set(entity, Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, was * 0.8 + gap * 1.2 * 0.2)));
    }
    list.push({ t, ...pose });
    if (list.length > KEEP) list.shift();
  }

  forget(entity: number): void {
    this.samples.delete(entity);
    this.delay.delete(entity);
  }

  /** Players not heard from since `before` (ms) are dropped; returns who was dropped. */
  prune(before: number): number[] {
    const gone: number[] = [];
    for (const [entity, list] of this.samples) {
      if ((list[list.length - 1]?.t ?? -Infinity) < before) {
        this.forget(entity);
        gone.push(entity);
      }
    }
    return gone;
  }

  entities(): IterableIterator<number> {
    return this.samples.keys();
  }

  /** Where `entity` is drawn at time `now`. */
  at(entity: number, now: number): Pose | undefined {
    const list = this.samples.get(entity);
    if (!list || list.length === 0) return undefined;
    const t = now - (this.delay.get(entity) ?? MIN_DELAY_MS);
    const first = list[0]!;
    if (t <= first.t) return { x: first.x, y: first.y, z: first.z, yaw: first.yaw };
    for (let i = 1; i < list.length; i++) {
      const b = list[i]!;
      if (t <= b.t) {
        const a = list[i - 1]!;
        const k = (t - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + angleDelta(a.yaw, b.yaw) * k };
      }
    }
    const last = list[list.length - 1]!;
    return { x: last.x, y: last.y, z: last.z, yaw: last.yaw };
  }
}
