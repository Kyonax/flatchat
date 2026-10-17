// SPDX-License-Identifier: MPL-2.0
// A world's sounds (S2.14, Q-H1). Its sound emitters (KHR_audio_emitter in the world's scenes,
// downloaded and hash-checked with the rest of the world) play where they stand, through Web Audio
// panners that follow the camera; global ones (music, ambience) play everywhere. Footsteps and the
// interface's sounds are made here from noise and tones, so no sound file ships with the client.
// Occlusion and reverb come in S6.06. Everything goes through `AudioContext`'s create… methods, so
// tests drive it with a fake context.
import type { BuiltWorld } from '@flatchat/content';

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
  'createGain' | 'createPanner' | 'createBufferSource' | 'createBiquadFilter' | 'createBuffer' | 'decodeAudioData' | 'destination' | 'listener' | 'currentTime' | 'sampleRate' | 'close' | 'resume'
>;

export class WorldSounds {
  readonly ctx: SoundContext;
  private readonly master: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private noise: AudioBuffer | undefined;
  /** How many of the world's emitters are playing. */
  playing = 0;

  constructor(volume: number, ctx: SoundContext = new AudioContext({ latencyHint: 'interactive' })) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(ctx.destination);
  }

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

  /** A footstep: a short burst of filtered noise, at a place (another player's) or at the listener. */
  footstep(at?: { x: number; y: number; z: number }, loudness = 0.22): void {
    const ctx = this.ctx;
    this.noise ??= noiseBuffer(ctx, 0.12);
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 520 + Math.random() * 380;
    band.Q.value = 1.3;
    const env = ctx.createGain();
    const t = ctx.currentTime;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(loudness, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    source.connect(band).connect(env);
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
    source.start(t);
    source.stop(t + 0.12);
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

function noiseBuffer(ctx: SoundContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// ------------------------------------------------------------------- the interface's sounds

let ui: { ctx: AudioContext; gain: GainNode } | undefined;
let uiVolume = 0.5;

export function setUiVolume(v: number): void {
  uiVolume = Math.min(1, Math.max(0, v));
  if (ui) ui.gain.gain.value = uiVolume;
}

/** A soft click (a button), a rising chime (someone arrived) or a blip (a chat line): tones made on
 *  the spot, in their own small context, quiet by default and silent at volume 0. */
export function uiSound(kind: 'click' | 'chime' | 'blip'): void {
  if (uiVolume === 0 || typeof AudioContext === 'undefined') return;
  if (!ui) {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.gain.value = uiVolume;
    gain.connect(ctx.destination);
    ui = { ctx, gain };
  }
  const { ctx, gain } = ui;
  const notes = kind === 'click' ? [[1400, 0.03]] : kind === 'chime' ? [[660, 0.12], [990, 0.16]] : [[880, 0.06]];
  let t = ctx.currentTime + 0.005;
  for (const [freq, length] of notes as Array<[number, number]>) {
    const osc = ctx.createOscillator();
    osc.type = kind === 'click' ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(kind === 'click' ? 0.12 : 0.18, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, t + length);
    osc.connect(env).connect(gain);
    osc.start(t);
    osc.stop(t + length + 0.02);
    t += length * 0.8;
  }
}
