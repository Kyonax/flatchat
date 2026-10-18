// SPDX-License-Identifier: MPL-2.0
// A world's sounds (S2.14, Q-H1). Its sound emitters (KHR_audio_emitter in the world's scenes,
// downloaded and hash-checked with the rest of the world) play where they stand, through Web Audio
// panners that follow the camera; global ones (music, ambience) play everywhere. Footsteps and the
// interface's sounds are the platform's default sounds (Track P's P.06, default-sounds.ts): recorded,
// CC0, carried inside the client; a footstep is never the same one twice running, its pitch a
// little off each time. Occlusion and reverb come in S6.06. Everything goes through `AudioContext`'s
// create… methods, so tests drive it with a fake context.
import type { BuiltWorld } from '@flatchat/content';
import { FOOTSTEPS, SoundBank, UI_SOUNDS, type UiSoundKind } from './default-sounds';

/** At most this many emitters play at once: a world that marks more keeps its first ones. */
export const MAX_EMITTERS = 64;

export interface EmitterPlan {
  /** The sound file's hash. */
  audio: string;
  position: [number, number, number];
  positional: boolean;
  gain: number;
  loop: boolean;
  refDistance: number;
  maxDistance: number;
}

/** The emitters that start with the world (`autoPlay`; the others wait for plugins, Stage 3). */
export function planEmitters(world: Pick<BuiltWorld, 'scenes'>): EmitterPlan[] {
  return world.scenes
    .flatMap((scene) => scene.emitters)
    .filter((e) => e.autoPlay)
    .slice(0, MAX_EMITTERS)
    .map((e) => ({
      audio: e.audio,
      position: [e.position[0], e.position[1], e.position[2]],
      positional: e.positional,
      gain: Math.min(4, Math.max(0, e.gain)),
      loop: e.loop,
      refDistance: Math.max(0.01, e.refDistance),
      maxDistance: Math.max(e.refDistance, e.maxDistance),
    }));
}

/** Counts a walker's strides: a step every 0.7 m on the ground (1.1 m running). */
export class Strides {
  private walked = 0;
  private last: { x: number; z: number } | undefined;

  /** True when this move completes a stride. */
  step(x: number, z: number, onGround: boolean, running: boolean): boolean {
    const was = this.last;
    this.last = { x, z };
    if (!was || !onGround) return false;
    const d = Math.hypot(x - was.x, z - was.z);
    // A jump in place of more than 3 m is a teleport, not a stride.
    if (d > 3) return false;
    this.walked += d;
    const stride = running ? 1.1 : 0.7;
    if (this.walked < stride) return false;
    this.walked %= stride;
    return true;
  }
}

/** The parts of an AudioContext this module uses (a fake one stands in for it in tests). */
export type SoundContext = Pick<
  AudioContext,
  'createGain' | 'createPanner' | 'createBufferSource' | 'decodeAudioData' | 'destination' | 'listener' | 'close' | 'resume'
>;

export class WorldSounds {
  readonly ctx: SoundContext;
  private readonly master: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly bank: SoundBank;
  /** The footstep played last, so the next is another. */
  private lastStep = -1;
  /** How many of the world's emitters are playing; how many footsteps have played. */
  playing = 0;
  steps = 0;

  constructor(volume: number, ctx: SoundContext = new AudioContext({ latencyHint: 'interactive' })) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(ctx.destination);
    this.bank = new SoundBank(ctx);
    this.ready = this.bank.load(FOOTSTEPS);
  }

  /** Resolves once the footsteps are decoded (a step before then is silent). */
  readonly ready: Promise<void>;

  set volume(v: number) {
    this.master.gain.value = Math.min(1, Math.max(0, v));
  }

  /** Starts the world's emitters from its downloaded files; resolves with how many play. */
  async start(world: Pick<BuiltWorld, 'scenes'>, files: ReadonlyMap<string, Uint8Array>): Promise<number> {
    for (const plan of planEmitters(world)) {
      const bytes = files.get(plan.audio);
      if (!bytes) continue;
      let buffer: AudioBuffer;
      try {
        buffer = await this.ctx.decodeAudioData(bytes.slice().buffer);
      } catch {
        // A file the browser cannot decode stays silent.
        continue;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = plan.loop;
      const gain = this.ctx.createGain();
      gain.gain.value = plan.gain;
      source.connect(gain);
      if (plan.positional) {
        const panner = this.ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = plan.refDistance;
        panner.maxDistance = plan.maxDistance;
        panner.rolloffFactor = 1;
        panner.positionX.value = plan.position[0];
        panner.positionY.value = plan.position[1];
        panner.positionZ.value = plan.position[2];
        gain.connect(panner).connect(this.master);
      } else {
        gain.connect(this.master);
      }
      source.start();
      this.sources.push(source);
      this.playing += 1;
    }
    return this.playing;
  }

  /** Where the listener is: the camera, facing along yaw and pitch (yaw 0 faces -z). */
  listen(at: { x: number; y: number; z: number }, yaw: number, pitch: number): void {
    const l = this.ctx.listener;
    l.positionX.value = at.x;
    l.positionY.value = at.y;
    l.positionZ.value = at.z;
    l.forwardX.value = -Math.sin(yaw) * Math.cos(pitch);
    l.forwardY.value = Math.sin(pitch);
    l.forwardZ.value = -Math.cos(yaw) * Math.cos(pitch);
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  }

  /** A footstep at a place (another player's) or at the listener: one of the ten recorded, never
   *  the last one again, its pitch within 6 % either way. The recordings peak at full scale, so the
   *  loudness is the step's peak. */
  footstep(at?: { x: number; y: number; z: number }, loudness = 0.22): void {
    const ctx = this.ctx;
    const pick = this.lastStep < 0 ? Math.floor(Math.random() * FOOTSTEPS.length) : (this.lastStep + 1 + Math.floor(Math.random() * (FOOTSTEPS.length - 1))) % FOOTSTEPS.length;
    const buffer = this.bank.get(FOOTSTEPS[pick]!);
    if (!buffer) return;
    this.lastStep = pick;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 0.94 + Math.random() * 0.12;
    const env = ctx.createGain();
    env.gain.value = loudness;
    source.connect(env);
    if (at) {
      const panner = ctx.createPanner();
      panner.distanceModel = 'inverse';
      panner.refDistance = 1.5;
      panner.maxDistance = 15;
      panner.positionX.value = at.x;
      panner.positionY.value = at.y;
      panner.positionZ.value = at.z;
      env.connect(panner).connect(this.master);
    } else {
      env.connect(this.master);
    }
    source.start();
    this.steps += 1;
  }

  close(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // never started
      }
    }
    void this.ctx.close();
  }
}

// ------------------------------------------------------------------- the interface's sounds

/** Each interface sound's peak at full volume: quiet beside the world. */
const UI_GAIN: Readonly<Record<UiSoundKind, number>> = { click: 0.2, chime: 0.25, blip: 0.25 };

/** The interface's sounds in a context of their own (a fake one in tests). */
export class UiSounds {
  private readonly ctx: Pick<AudioContext, 'createGain' | 'createBufferSource' | 'decodeAudioData' | 'destination'>;
  private readonly gain: GainNode;
  private readonly bank: SoundBank;
  readonly ready: Promise<void>;
  /** How many have played. */
  played = 0;

  constructor(volume: number, ctx: Pick<AudioContext, 'createGain' | 'createBufferSource' | 'decodeAudioData' | 'destination'>) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(ctx.destination);
    this.bank = new SoundBank(ctx);
    this.ready = this.bank.load(Object.values(UI_SOUNDS));
  }

  set volume(v: number) {
    this.gain.gain.value = v;
  }

  /** Plays one, when it is decoded. */
  play(kind: UiSoundKind): void {
    const buffer = this.bank.get(UI_SOUNDS[kind]);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const env = this.ctx.createGain();
    env.gain.value = UI_GAIN[kind];
    source.connect(env).connect(this.gain);
    source.start();
    this.played += 1;
  }
}

let ui: UiSounds | undefined;
let uiVolume = 0.5;

export function setUiVolume(v: number): void {
  uiVolume = Math.min(1, Math.max(0, v));
  if (ui) ui.volume = uiVolume;
}

/** A soft click (a button), a chime (someone arrived) or a blip (a chat line), quiet by default and
 *  silent at volume 0. The first call makes their context (in a gesture, so it may sound) and plays
 *  once they are decoded. */
export function uiSound(kind: UiSoundKind): void {
  if (uiVolume === 0 || typeof AudioContext === 'undefined') return;
  if (ui) {
    ui.play(kind);
    return;
  }
  const made = new UiSounds(uiVolume, new AudioContext({ latencyHint: 'interactive' }));
  ui = made;
  void made.ready.then(() => made.play(kind));
}
