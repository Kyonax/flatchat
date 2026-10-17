// SPDX-License-Identifier: MPL-2.0
// Proximity voice forwarding (dp-005, the plan's VOICE): the server never decodes Opus. Every
// 20 ms it gives each listener one bundle with one frame from each of up to 16 speakers inside the
// voice range, nearest first, so the packets per listener stay flat however full the room is. A
// speaker whose frames arrive bunched keeps the extra ones for the next steps, in order. The world's
// rules (S3.08) set each speaker's range and gain (stages, plugins) and who may hear whom (quiet and
// private zones; blocks and the minors' protections from S3.10 and S3.11); each forwarded frame
// carries its speaker's gain and range, so the listener's falloff ends where the world stops.
import { encodeMessage, type MessageBody } from '@flatchat/protocol';
import type { World } from './world.ts';

export type VoiceFrame = MessageBody<'voiceBundle'>['frames'][number];
/** A frame as its speaker sent it: the world adds the gain and range when it forwards it. */
export type SpokenFrame = Omit<VoiceFrame, 'gain' | 'range'>;

/** Who hears whom, how far and how loud: the world server's decision, per step. */
export interface VoiceRules {
  /** Metres within which the speaker is heard. */
  rangeOf(speaker: number): number;
  /** The speaker's gain in 64ths (64: as spoken). */
  gainOf(speaker: number): number;
  canHear(listener: number, speaker: number): boolean;
}

/** No range can carry a voice farther than this (a stage across a plaza, not across a world). */
export const MAX_RANGE_M = 200;

export interface VoiceConfig {
  /** Metres beyond which a speaker is not heard (the plan's 25 m default). */
  rangeM: number;
  /** Speakers per bundle (the plan's 16, the protocol's limit). */
  maxSpeakers: number;
  /** Frames kept per speaker between steps; a longer queue drops its oldest. */
  maxQueued: number;
}

export const DEFAULT_VOICE: VoiceConfig = { rangeM: 25, maxSpeakers: 16, maxQueued: 3 };

/** A frame's `gain` for a voice as spoken: 64ths, 0 to 255 (protocol version 6). */
export const GAIN_UNITY = 64;

/** Everyone hears everyone within the world's range, as spoken. */
export function openRules(rangeM = DEFAULT_VOICE.rangeM): VoiceRules {
  return { rangeOf: () => rangeM, gainOf: () => GAIN_UNITY, canHear: () => true };
}

export interface VoiceStepStats {
  speakers: number;
  bundles: number;
  frames: number;
  bytes: number;
  largest: number;
  dropped: number;
}

export class VoiceRouter {
  readonly config: VoiceConfig;
  private readonly pending = new Map<number, SpokenFrame[]>();
  private dropped = 0;

  constructor(config: Partial<VoiceConfig> = {}) {
    this.config = { ...DEFAULT_VOICE, ...config };
  }

  /** Queues one frame from a speaker until a step forwards it. */
  push(frame: SpokenFrame): void {
    let queue = this.pending.get(frame.from);
    if (!queue) {
      queue = [];
      this.pending.set(frame.from, queue);
    }
    queue.push(frame);
    if (queue.length > this.config.maxQueued) {
      queue.shift();
      this.dropped += 1;
    }
  }

  forget(entity: number): void {
    this.pending.delete(entity);
  }

  /** One 20 ms step: each listener's encoded bundle, under the world's rules. */
  step(world: World, rules: VoiceRules = openRules(this.config.rangeM)): { bundles: Map<number, Uint8Array>; stats: VoiceStepStats } {
    const current = new Map<number, { frame: VoiceFrame; range: number }>();
    let reach = 0;
    for (const [speaker, queue] of this.pending) {
      const spoken = queue.shift();
      if (queue.length === 0) this.pending.delete(speaker);
      if (!spoken || !world.players.has(speaker)) continue;
      const range = Math.min(MAX_RANGE_M, Math.max(1, rules.rangeOf(speaker)));
      const gain = Math.min(255, Math.max(0, Math.round(rules.gainOf(speaker))));
      reach = Math.max(reach, range);
      current.set(speaker, { frame: { ...spoken, gain, range: Math.round(range) === this.config.rangeM ? 0 : Math.round(range) }, range });
    }
    const stats: VoiceStepStats = { speakers: current.size, bundles: 0, frames: 0, bytes: 0, largest: 0, dropped: this.dropped };
    this.dropped = 0;
    const bundles = new Map<number, Uint8Array>();
    if (current.size === 0) return { bundles, stats };
    for (const listener of world.players.values()) {
      const frames: VoiceFrame[] = [];
      for (const { player, d2 } of world.near(listener.x, listener.z, reach, listener.entity)) {
        const heard = current.get(player.entity);
        if (!heard || d2 > heard.range * heard.range || !rules.canHear(listener.entity, player.entity)) continue;
        frames.push(heard.frame);
        if (frames.length >= this.config.maxSpeakers) break;
      }
      if (frames.length === 0) continue;
      const bytes = encodeMessage({ type: 'voiceBundle', frames });
      bundles.set(listener.entity, bytes);
      stats.bundles += 1;
      stats.frames += frames.length;
      stats.bytes += bytes.length;
      if (bytes.length > stats.largest) stats.largest = bytes.length;
    }
    return { bundles, stats };
  }
}
