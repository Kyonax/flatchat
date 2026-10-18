// SPDX-License-Identifier: MPL-2.0
// Occlusion and reverb (S6.06, DR-10, Q-H1). A sound behind a wall is muffled: a ray from the
// listener's head to each sound through the world's solids (Rapier's ray cast, physics.ts), at most
// OCCLUSION_RAYS a frame, each sound in turn, and an occluded one goes through a low-pass and a lower
// gain, eased so it never clicks. A reverb zone (a world's zone of kind `reverb`, its room and its
// mix) puts the room around the listener: every sound also goes to one convolver per audio context,
// its impulse made here (noise falling away over the room's reverberation time, darker as it falls),
// and a change of room crossfades from one convolver to the next. Voices (voice/chain.ts) and the
// world's sounds (sounds.ts, its emitters, footsteps and emotes) both use it. Pure where it can be,
// so tests drive it without an audio device.
import { type BuiltZone, insideBox, REVERB_MIX, type ReverbRoom } from '@flatchat/content';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** At most this many rays a frame: with 16 voices and 64 emitters each sound is tested every 5
 *  frames (about 80 ms at 60 frames a second). */
export const OCCLUSION_RAYS = 16;
/** An occluded sound: its low-pass cutoff and its gain (about -8 dB). */
export const OCCLUDED_HZ = 900;
export const OCCLUDED_GAIN = 0.4;
/** The time constant of every change (seconds): a quick ease, never a click. */
export const OCCLUSION_EASE = 0.08;
/** The last half metre before a sound is not tested: a sound inside its own fountain or speaker box
 *  is not muffled by it. */
export const SOURCE_CLEARANCE = 0.5;

/** Each room's reverberation time (seconds to fall by 60 dB), its delay before the first
 *  reflections, and how bright it starts and ends (the low-pass cutoff at the start and at the end). */
export const ROOM_ACOUSTICS: Readonly<Record<ReverbRoom, { rt60: number; predelay: number; brightHz: number; darkHz: number }>> = {
  small: { rt60: 0.45, predelay: 0.004, brightHz: 9_000, darkHz: 3_500 },
  room: { rt60: 0.9, predelay: 0.008, brightHz: 8_000, darkHz: 2_500 },
  hall: { rt60: 1.9, predelay: 0.02, brightHz: 7_000, darkHz: 1_800 },
  cave: { rt60: 3.2, predelay: 0.035, brightHz: 4_000, darkHz: 900 },
  cathedral: { rt60: 4.8, predelay: 0.045, brightHz: 6_000, darkHz: 1_200 },
};
/** No impulse is longer than this (seconds): the convolver's cost grows with it. */
export const IMPULSE_MAX_S = 5;

/** A seeded random number generator (mulberry32): the same room always sounds the same. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A room's impulse response: two channels of noise, apart so the room is wide, falling by 60 dB
 *  over its reverberation time and darker as it falls (a one-pole low-pass from its bright cutoff to
 *  its dark one), after its delay; scaled to unit energy, so every room is about as loud. */
export function impulseResponse(room: ReverbRoom, sampleRate: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const a = ROOM_ACOUSTICS[room];
  const length = Math.min(IMPULSE_MAX_S, a.predelay + a.rt60 * 1.1);
  const n = Math.max(1, Math.round(length * sampleRate));
  const start = Math.round(a.predelay * sampleRate);
  const out: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const rand = seeded(0x5eed + ch * 7919 + Math.round(a.rt60 * 1000));
    const data = out[ch]!;
    let low = 0;
    let energy = 0;
    for (let i = start; i < n; i++) {
      const t = (i - start) / sampleRate;
      const fall = Math.exp((-6.907755 * t) / a.rt60);
      const hz = a.darkHz + (a.brightHz - a.darkHz) * fall;
      const k = 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);
      low += k * (rand() * 2 - 1 - low);
      data[i] = low * fall;
      energy += data[i]! * data[i]!;
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < n; i++) data[i]! *= scale;
  }
  return out;
}

/** A sound the occlusion tests: where it is and how far it carries (beyond that it is not tested). */
export interface Audible {
  key: string;
  at: Vec3;
  reach: number;
}

/** Which sounds are behind something, tested a few a frame (each in turn) within a ray budget. */
export class Occlusion {
  private readonly blocked: (from: Vec3, to: Vec3) => boolean;
  private readonly budget: number;
  private readonly state = new Map<string, boolean>();
  private cursor = 0;
  /** Rays cast, frames updated and the milliseconds the rays took in all. */
  rays = 0;
  frames = 0;
  ms = 0;
  /** The most milliseconds one frame's rays took. */
  worstMs = 0;

  constructor(blocked: (from: Vec3, to: Vec3) => boolean, budget = OCCLUSION_RAYS) {
    this.blocked = blocked;
    this.budget = budget;
  }

  /** Tests up to the budget of the sounds within their reach, in turn; returns each sound's state
   *  (true: something is between the ears and it). A sound out of reach is forgotten. */
  update(ears: Vec3, sounds: readonly Audible[]): ReadonlyMap<string, boolean> {
    const near = sounds.filter((s) => Math.hypot(s.at.x - ears.x, s.at.y - ears.y, s.at.z - ears.z) <= s.reach);
    const keep = new Set(near.map((s) => s.key));
    for (const k of [...this.state.keys()]) if (!keep.has(k)) this.state.delete(k);
    const t0 = performance.now();
    const count = Math.min(this.budget, near.length);
    for (let i = 0; i < count; i++) {
      const s = near[(this.cursor + i) % near.length]!;
      this.state.set(s.key, this.blocked(ears, s.at));
    }
    this.cursor = near.length ? (this.cursor + count) % near.length : 0;
    const took = performance.now() - t0;
    this.rays += count;
    this.frames += 1;
    this.ms += took;
    this.worstMs = Math.max(this.worstMs, took);
    return this.state;
  }

  /** The counts since the last call (rays, frames, milliseconds, the worst frame's), then zero. */
  takeCounts(): { rays: number; frames: number; ms: number; worstMs: number } {
    const c = { rays: this.rays, frames: this.frames, ms: this.ms, worstMs: this.worstMs };
    this.rays = 0;
    this.frames = 0;
    this.ms = 0;
    this.worstMs = 0;
    return c;
  }

  /** Whether a sound was behind something when last tested (false until tested). */
  occluded(key: string): boolean {
    return this.state.get(key) ?? false;
  }

  /** How many of the sounds in reach are occluded now. */
  get count(): number {
    let n = 0;
    for (const v of this.state.values()) if (v) n += 1;
    return n;
  }
}

/** The reverb zone the listener stands in: the smallest of those that hold the point (a room inside
 *  a hall is the room). */
export function reverbAt(zones: readonly BuiltZone[], p: Vec3): { room: ReverbRoom; mix: number } | undefined {
  let best: { room: ReverbRoom; mix: number; volume: number } | undefined;
  for (const z of zones) {
    if (z.kind !== 'reverb' || !z.room || !insideBox(z, p)) continue;
    const volume = z.half[0] * z.half[1] * z.half[2];
    if (!best || volume < best.volume) best = { room: z.room, mix: z.mix ?? REVERB_MIX, volume };
  }
  return best && { room: best.room, mix: best.mix };
}

/** The parts of an audio context the reverb uses (a fake one in tests). */
export type ReverbContext = Pick<BaseAudioContext, 'createGain' | 'createConvolver' | 'createBuffer' | 'currentTime' | 'sampleRate'>;

/** A room around the listener: every sound sent to `input` comes out of `output` as the room's
 *  reverberation, at the zone's mix. A change of room crossfades to a new convolver (no click), and
 *  the old one is let go once silent. Each room's impulse is made once a context. */
export class Reverb {
  readonly input: GainNode;
  private readonly ctx: ReverbContext;
  private readonly output: AudioNode;
  private readonly impulses = new Map<ReverbRoom, AudioBuffer>();
  private current: { room: ReverbRoom; conv: ConvolverNode; wet: GainNode } | undefined;
  private readonly fading: Array<{ conv: ConvolverNode; wet: GainNode; until: number }> = [];
  room: ReverbRoom | undefined;
  mix = 0;

  constructor(ctx: ReverbContext, output: AudioNode) {
    this.ctx = ctx;
    this.output = output;
    this.input = ctx.createGain();
  }

  private impulse(room: ReverbRoom): AudioBuffer {
    let b = this.impulses.get(room);
    if (!b) {
      const [l, r] = impulseResponse(room, this.ctx.sampleRate);
      b = this.ctx.createBuffer(2, l.length, this.ctx.sampleRate);
      b.copyToChannel(l, 0);
      b.copyToChannel(r, 1);
      this.impulses.set(room, b);
    }
    return b;
  }

  /** The room around the listener now (undefined: none) and its mix (0 to 1). */
  set(room: ReverbRoom | undefined, mix: number): void {
    const t = this.ctx.currentTime;
    this.release(t);
    if (room === this.room) {
      if (this.current && mix !== this.mix) this.current.wet.gain.setTargetAtTime(mix, t, OCCLUSION_EASE);
      this.mix = mix;
      return;
    }
    if (this.current) {
      this.current.wet.gain.setTargetAtTime(0, t, 0.1);
      this.fading.push({ conv: this.current.conv, wet: this.current.wet, until: t + 1 });
      this.current = undefined;
    }
    this.room = room;
    this.mix = mix;
    if (!room) return;
    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this.impulse(room);
    const wet = this.ctx.createGain();
    wet.gain.value = 0;
    wet.gain.setTargetAtTime(mix, t, 0.1);
    this.input.connect(conv);
    conv.connect(wet).connect(this.output);
    this.current = { room, conv, wet };
  }

  /** Lets go of the convolvers faded out (their input first, so they stop working). */
  private release(t: number): void {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]!;
      if (t < f.until) continue;
      this.input.disconnect(f.conv);
      f.conv.disconnect();
      f.wet.disconnect();
      this.fading.splice(i, 1);
    }
  }

  /** How many convolvers are working (the current one and those fading out). */
  get working(): number {
    return (this.current ? 1 : 0) + this.fading.length;
  }

  close(): void {
    this.set(undefined, 0);
    for (const f of this.fading) {
      f.conv.disconnect();
      f.wet.disconnect();
    }
    this.fading.length = 0;
    this.input.disconnect();
  }
}
