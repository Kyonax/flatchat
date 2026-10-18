// SPDX-License-Identifier: MPL-2.0
// How a body moves (Track P's P.05, replacing S4.06's procedural set): the default clips played by
// gait. The gait comes from the speed and the stance; walk, jog and sprint play at the pace that
// keeps a planted foot where it stands (the speed over the clip's ground speed for the avatar's leg
// length, clips.json's speedPerLeg); landing, sitting down and getting up play once between gaits;
// every change cross-fades. The body turns on the spot without stepping: neither library has an
// in-place turn. Pure but for the clips it reads, so it is tested without a window.
import { blend, bobAt, type BoneAngles, type ClipData, defaultClips, eulerXYZ, type Quat, rotationAt } from './clips';

export type Gait = 'idle' | 'walk' | 'jog' | 'sprint' | 'air' | 'fall' | 'sit';

/** Speeds, metres a second: below WALK_FROM a body stands; from JOG_FROM it jogs, from SPRINT_FROM
 *  it sprints (the movement set walks at 3.6 and runs at 7). */
export const WALK_FROM = 0.25;
export const JOG_FROM = 2.2;
export const SPRINT_FROM = 6;
/** A change of clip blends over this long, seconds. */
export const FADE_S = 0.25;
/** A walking clip's pace stays between these shares of its own. */
export const RATE_MIN = 0.4;
export const RATE_MAX = 2.5;

export function gaitFor(speed: number, stance: string): Gait {
  if (stance === 'sitting') return 'sit';
  if (stance === 'falling') return 'fall';
  if (stance === 'jumping' || stance === 'flying') return 'air';
  if (speed >= SPRINT_FROM) return 'sprint';
  if (speed >= JOG_FROM) return 'jog';
  if (speed >= WALK_FROM) return 'walk';
  return 'idle';
}

/** The clip each gait loops. */
const LOOP: Record<Gait, string> = { idle: 'idle', walk: 'walk', jog: 'jog', sprint: 'sprint', air: 'jump-air', fall: 'fall', sit: 'sit-idle' };
const WALKING = new Set<Gait>(['walk', 'jog', 'sprint']);

/** A walking clip's pace for a speed and a leg length (metres from the hips to the ground). */
export function paceOf(clip: ClipData, speed: number, legLength: number): number {
  if (clip.speedPerLeg <= 0) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, speed / (clip.speedPerLeg * Math.max(0.2, legLength))));
}

export interface Pose {
  bones: BoneAngles;
  /** The hips' rise and fall, as a share of their height. */
  bob: number;
  gait: Gait;
  /** How far down into a seat the body is: 0 standing, 1 seated. */
  seated: number;
}

interface Playing {
  clip: ClipData;
  time: number;
}

export class Motion {
  private readonly clips: Map<string, ClipData>;
  private gait: Gait = 'idle';
  private now: Playing;
  /** The clip faded from, still moving, and how far the fade has come. */
  private from: Playing | undefined;
  private fade = 1;
  /** A clip that plays once before the gait's own loop (a landing, sitting down, getting up). */
  private once = false;
  private seated = 0;
  private readonly qa: Quat = [0, 0, 0, 1];
  private readonly qb: Quat = [0, 0, 0, 1];

  constructor(clips: Map<string, ClipData> = defaultClips()) {
    this.clips = clips;
    this.now = { clip: this.clip('idle'), time: 0 };
  }

  private clip(name: string): ClipData {
    const c = this.clips.get(name);
    if (!c) throw new Error(`no default clip ${name}`);
    return c;
  }

  private play(name: string, once: boolean, keepPhase = false): void {
    const clip = this.clip(name);
    if (clip === this.now.clip) return;
    // From one walking clip to another the stride goes on where it was.
    const time = keepPhase && this.now.clip.duration > 0 ? (this.now.time / this.now.clip.duration) * clip.duration : 0;
    this.from = this.now;
    this.fade = 0;
    this.now = { clip, time };
    this.once = once;
  }

  /** The body's pose after `dt` seconds at this speed and stance, for these legs. */
  update(dt: number, speed: number, stance: string, legLength: number): Pose {
    const gait = gaitFor(speed, stance);
    if (gait !== this.gait) {
      const was = this.gait;
      this.gait = gait;
      if (gait === 'sit') this.play('sit-enter', true);
      else if (was === 'sit' && gait === 'idle') this.play('sit-exit', true);
      else if ((was === 'air' || was === 'fall') && gait === 'idle') this.play('land', true);
      else this.play(LOOP[gait], false, WALKING.has(was) && WALKING.has(gait));
    }
    // A one-shot ends into its gait's loop; a gait that moves on cuts it short.
    if (this.once && this.now.time >= this.now.clip.duration) this.play(LOOP[this.gait], false);
    if (this.once && this.gait !== 'sit' && this.gait !== 'idle') this.play(LOOP[this.gait], false);
    const rate = WALKING.has(this.gait) ? paceOf(this.now.clip, speed, legLength) : 1;
    this.now.time += dt * rate;
    if (this.from) {
      this.from.time += dt * (this.from.clip.speedPerLeg > 0 ? paceOf(this.from.clip, speed, legLength) : 1);
      this.fade = Math.min(1, this.fade + dt / FADE_S);
      if (this.fade >= 1) this.from = undefined;
    }
    // Into the seat while sitting down, out while getting up.
    const name = this.now.clip.name;
    this.seated = name === 'sit-enter' ? Math.min(1, this.now.time / Math.max(0.01, this.now.clip.duration)) : name === 'sit-exit' ? 1 - Math.min(1, this.now.time / Math.max(0.01, this.now.clip.duration)) : this.gait === 'sit' ? 1 : 0;
    return { bones: this.bones(), bob: this.bob(), gait: this.gait, seated: this.seated };
  }

  private bones(): BoneAngles {
    const out: BoneAngles = {};
    for (const bone of this.now.clip.rotations.keys()) {
      const b = rotationAt(this.now.clip, bone, this.now.time, this.qb);
      if (!b) continue;
      const a = this.from ? rotationAt(this.from.clip, bone, this.from.time, this.qa) : undefined;
      out[bone] = eulerXYZ(a ? blend(a, b, this.fade, this.qa) : b);
    }
    return out;
  }

  private bob(): number {
    // A seat sets the sitting body's height; the clips' own drop would count it twice.
    const bobOf = (p: Playing): number => (p.clip.name.startsWith('sit') ? 0 : bobAt(p.clip, p.time));
    const b = bobOf(this.now);
    return this.from ? bobOf(this.from) * (1 - this.fade) + b * this.fade : b;
  }
}
