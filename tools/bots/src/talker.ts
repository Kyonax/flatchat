// SPDX-License-Identifier: MPL-2.0
// When a bot talks and what it says. Voice comes in bursts (1.5 to 6 s of talking, then 4 to 20 s
// of silence, about a quarter of the time), as one synthetic Opus frame every 20 ms (`seq` counts
// every 20 ms slot, silent ones too, and a burst's first frame has `start`: protocol 1): 50 to 80
// bytes, what 24 kb/s speech produces (the plan's VOICE), behind a plausible table-of-contents
// byte, with mouth shapes that follow a loudness envelope. The world server never decodes Opus,
// so random payload bytes cost it exactly what speech would. Chat is a short line every 30 to
// 120 s. Deterministic for a seed; pure.
import { seededRandom } from '@flatchat/world-server/metrics';

export interface Mouth {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
  level: number;
}

const LINES = ['hola', 'hello', 'qué tal', 'gg', 'nice avatar', 'anyone here?', 'brb', 'look at this', 'lol', 'see you at the plaza'];
/** Opus TOC: config 9 (SILK wideband, 20 ms), mono, one frame. */
const TOC = 9 << 3;

export class Talker {
  private readonly random: () => number;
  private talking = false;
  private left: number;
  private chatIn: number;
  private seq = 0;
  private wasTalking = false;
  private envelope = 0;
  private readonly mouth: Mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 };

  /** `firstWithin`: the first burst starts within this many seconds (the smoke test uses 1). */
  constructor(seed: number, firstWithin = 16) {
    this.random = seededRandom(seed ^ 0x9e3779b9);
    this.left = Math.min(1, firstWithin / 4) + this.random() * firstWithin * 0.9;
    this.chatIn = 10 + this.random() * 110;
  }

  get isTalking(): boolean {
    return this.talking;
  }

  /** Advances by dt seconds; returns a chat line when one is due. */
  advance(dt: number): string | undefined {
    this.left -= dt;
    if (this.left <= 0) {
      this.talking = !this.talking;
      this.left = this.talking ? 1.5 + this.random() * 4.5 : 4 + this.random() * 16;
    }
    this.chatIn -= dt;
    if (this.chatIn <= 0) {
      this.chatIn = 30 + this.random() * 90;
      return LINES[Math.floor(this.random() * LINES.length)];
    }
    return undefined;
  }

  /** One 20 ms slot: the frame to send while talking, nothing in silence. */
  slot(): { seq: number; start: boolean; mouth: Mouth; opus: Uint8Array } | undefined {
    this.seq = (this.seq + 1) & 0xffff;
    const start = !this.wasTalking;
    this.wasTalking = this.talking;
    if (!this.talking) return undefined;
    return { ...this.frame(), start };
  }

  /** A 20 ms voice frame's payload, for the slot that is sending. */
  frame(): { seq: number; mouth: Mouth; opus: Uint8Array } {
    this.envelope = Math.min(1, Math.max(0, this.envelope + (this.random() - 0.45) * 0.3));
    const level = Math.round(this.envelope * 15);
    const vowel = Math.floor(this.random() * 5);
    const keys = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
    keys.forEach((k, i) => {
      this.mouth[k] = i === vowel ? level : Math.max(0, Math.round(level * this.random() * 0.4));
    });
    this.mouth.level = level;
    const opus = new Uint8Array(50 + Math.floor(this.random() * 31));
    opus[0] = TOC;
    for (let i = 1; i < opus.length; i++) opus[i] = Math.floor(this.random() * 256);
    return { seq: this.seq, mouth: { ...this.mouth }, opus };
  }
}
