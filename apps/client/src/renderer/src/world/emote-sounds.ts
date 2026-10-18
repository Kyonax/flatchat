// SPDX-License-Identifier: MPL-2.0
// Emotes' and dances' sounds (S5.07): a dance's music or an emote's sound, played at the player who
// plays it, in step with the motion (from the seconds since the world tick it started at), within
// the voice's reach (25 m), at most a few at once, nearest first, at the viewer's own volume for
// them (Settings, Sound; 0 turns them off). A dance's sound repeats with it; an emote's plays once.
// Each sound is fetched and decoded once and shared.
import type { SoundContext } from './sounds';

/** How far an emote's sound carries, and how many play at once. */
export const EMOTE_REACH = 25;
export const EMOTE_SOUNDS_MAX = 8;

export interface EmoteSound {
  entity: number;
  /** The animation's manifest, the world tick it started at, and how long ago that was (seconds). */
  anim: string;
  start: number;
  time: number;
  at: { x: number; y: number; z: number };
}

/** One playing of one animation: started again, it is another. */
const keyOf = (e: EmoteSound): string => `${e.entity}:${e.anim}:${e.start}`;

/** An animation's sound and whether it repeats: undefined when it has none. */
export type EmoteSoundFetcher = (anim: string) => Promise<{ bytes: ArrayBuffer; loop: boolean } | undefined>;

interface Playing {
  key: string;
  source: AudioBufferSourceNode;
  panner: PannerNode;
}

export class EmoteSounds {
  private readonly ctx: SoundContext;
  private readonly master: GainNode;
  private readonly fetch: EmoteSoundFetcher;
  private readonly sounds = new Map<string, Promise<{ buffer: AudioBuffer; loop: boolean } | undefined>>();
  private readonly playing = new Map<number, Playing>();
  /** Starts under way, so a frame does not start one twice; and what each player should play now. */
  private readonly starting = new Set<string>();
  private wanted = new Map<number, string>();

  constructor(ctx: SoundContext, volume: number, fetch: EmoteSoundFetcher) {
    this.ctx = ctx;
    this.fetch = fetch;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(ctx.destination);
  }

  set volume(v: number) {
    this.master.gain.value = Math.min(1, Math.max(0, v));
  }

  /** How many sounds play now. */
  get count(): number {
    return this.playing.size;
  }

  private sound(anim: string): Promise<{ buffer: AudioBuffer; loop: boolean } | undefined> {
    let s = this.sounds.get(anim);
    if (!s) {
      s = (async () => {
        const got = await this.fetch(anim);
        if (!got) return undefined;
        return { buffer: await this.ctx.decodeAudioData(got.bytes), loop: got.loop };
      })().catch(() => undefined);
      this.sounds.set(anim, s);
    }
    return s;
  }

  /** Each frame: what plays where, and the listener's place (the camera). */
  update(list: readonly EmoteSound[], ears: { x: number; y: number; z: number }): void {
    const near = list
      .map((e) => ({ e, d: Math.hypot(e.at.x - ears.x, e.at.y - ears.y, e.at.z - ears.z) }))
      .filter((x) => x.d <= EMOTE_REACH && this.master.gain.value > 0)
      .sort((a, b) => a.d - b.d)
      .slice(0, EMOTE_SOUNDS_MAX)
      .map((x) => x.e);
    this.wanted = new Map(near.map((e) => [e.entity, keyOf(e)]));
    // Stopped, changed, started again or out of reach.
    for (const [entity, p] of this.playing) if (this.wanted.get(entity) !== p.key) this.stop(entity);
    for (const e of near) {
      const p = this.playing.get(e.entity);
      if (p) {
        p.panner.positionX.value = e.at.x;
        p.panner.positionY.value = e.at.y + 1.5;
        p.panner.positionZ.value = e.at.z;
        continue;
      }
      const key = keyOf(e);
      if (this.starting.has(key)) continue;
      this.starting.add(key);
      const started = performance.now();
      void this.sound(e.anim).then((s) => {
        this.starting.delete(key);
        // Decoded too late: the player has moved on, or out of reach.
        if (!s || this.playing.has(e.entity) || this.wanted.get(e.entity) !== key) return;
        const time = e.time + (performance.now() - started) / 1000;
        const offset = s.loop ? time % s.buffer.duration : time;
        if (!s.loop && offset >= s.buffer.duration) return;
        const source = this.ctx.createBufferSource();
        source.buffer = s.buffer;
        source.loop = s.loop;
        const panner = this.ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'linear';
        panner.refDistance = 2;
        panner.maxDistance = EMOTE_REACH;
        panner.positionX.value = e.at.x;
        panner.positionY.value = e.at.y + 1.5;
        panner.positionZ.value = e.at.z;
        source.connect(panner).connect(this.master);
        source.start(0, offset);
        source.onended = () => {
          if (this.playing.get(e.entity)?.source === source) this.playing.delete(e.entity);
        };
        this.playing.set(e.entity, { key, source, panner });
      });
    }
  }

  private stop(entity: number): void {
    const p = this.playing.get(entity);
    if (!p) return;
    this.playing.delete(entity);
    try {
      p.source.stop();
    } catch {
      // Already ended.
    }
    p.source.disconnect();
    p.panner.disconnect();
  }

  close(): void {
    for (const entity of [...this.playing.keys()]) this.stop(entity);
    this.master.disconnect();
  }
}
