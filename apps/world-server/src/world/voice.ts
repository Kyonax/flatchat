// SPDX-License-Identifier: MPL-2.0
// Proximity voice forwarding (dp-005, the plan's VOICE): the server never decodes Opus. Every
// 20 ms it gives each listener one bundle with one frame from each of up to 16 speakers inside the
// voice range, nearest first, so the packets per listener stay flat however full the room is. A
// speaker whose frames arrive bunched keeps the extra ones for the next steps, in order.
import { encodeMessage, type MessageBody } from '@flatchat/protocol';
import type { World } from './world.ts';

export type VoiceFrame = MessageBody<'voiceBundle'>['frames'][number];

export interface VoiceConfig {
  /** Metres beyond which a speaker is not heard (the plan's 25 m default). */
  rangeM: number;
  /** Speakers per bundle (the plan's 16, the protocol's limit). */
  maxSpeakers: number;
  /** Frames kept per speaker between steps; a longer queue drops its oldest. */
  maxQueued: number;
}

export const DEFAULT_VOICE: VoiceConfig = { rangeM: 25, maxSpeakers: 16, maxQueued: 3 };

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
  private readonly pending = new Map<number, VoiceFrame[]>();
  private dropped = 0;

  constructor(config: Partial<VoiceConfig> = {}) {
    this.config = { ...DEFAULT_VOICE, ...config };
  }

  /** Queues one frame from a speaker until a step forwards it. */
  push(frame: VoiceFrame): void {
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

  /** One 20 ms step: each listener's encoded bundle. */
  step(world: World): { bundles: Map<number, Uint8Array>; stats: VoiceStepStats } {
    const current = new Map<number, VoiceFrame>();
    for (const [speaker, queue] of this.pending) {
      const frame = queue.shift();
      if (frame && world.players.has(speaker)) current.set(speaker, frame);
      if (queue.length === 0) this.pending.delete(speaker);
    }
    const stats: VoiceStepStats = { speakers: current.size, bundles: 0, frames: 0, bytes: 0, largest: 0, dropped: this.dropped };
    this.dropped = 0;
    const bundles = new Map<number, Uint8Array>();
    if (current.size === 0) return { bundles, stats };
    for (const listener of world.players.values()) {
      const frames: VoiceFrame[] = [];
      for (const { player } of world.near(listener.x, listener.z, this.config.rangeM, listener.entity)) {
        const frame = current.get(player.entity);
        if (!frame) continue;
        frames.push(frame);
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
