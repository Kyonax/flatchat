// SPDX-License-Identifier: MPL-2.0
// The playout buffer for one speaker's voice (the plan's VOICE, DR-09): 20 ms Opus frames arrive
// out of order and late over the unreliable channel; this decides, every 20 ms, what to play.
//
// A talk spurt starts playing `delay` after its first frame arrived; the delay is one frame (20 ms)
// plus three times the measured jitter, at most 80 ms, and is chosen again at each spurt's start
// (never mid-spurt, so speech is never stretched). Until the link is measured the jitter is taken
// as 7 ms, so the first spurt waits 41 ms; on a clean link the later ones wait about 21 ms (the world
// server forwards a speaker's frames on its own 20 ms step, so they arrive evenly). Each 20 ms step
// plays the next frame in order.
//
// Protocol version 1: `seq` counts the sender's 20 ms slots, silent ones too, and `start` marks
// the first frame after silence. So a missing `seq` before a buffered start frame is silence and
// plays as silence; any other missing frame is lost: rebuilt from the following packet's in-band
// FEC when that packet is already here, concealed (Opus packet-loss concealment) otherwise. A
// concealed step that a start frame turns out to follow was silence too, and is not counted.
// After 5 empty steps (100 ms) the spurt ends and the buffer goes idle until the next frame; the
// concealed steps of that tail are the speech ending, not losses, and are not counted either.
// Pure: the caller passes the times.

export type Step =
  | { kind: 'frame'; seq: number; packet: Uint8Array }
  /** A slot the speaker left silent: play silence. */
  | { kind: 'gap'; seq: number }
  /** `packet` is the NEXT frame's packet: decode it with FEC to rebuild frame `seq`. */
  | { kind: 'fec'; seq: number; packet: Uint8Array }
  | { kind: 'conceal'; seq: number }
  | { kind: 'idle' };

export interface JitterConfig {
  frameMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  /** Frames held at most; older ones are dropped. */
  capacity: number;
  /** Empty steps before a spurt ends. */
  endAfter: number;
  /** The jitter assumed before any is measured, ms. */
  initialJitterMs: number;
}

export const DEFAULT_JITTER: JitterConfig = { frameMs: 20, minDelayMs: 20, maxDelayMs: 80, capacity: 25, endAfter: 5, initialJitterMs: 7 };

export interface JitterStats {
  played: number;
  /** Silent slots inside a spurt, played as silence (not losses). */
  gaps: number;
  recovered: number;
  concealed: number;
  late: number;
  duplicates: number;
  spurts: number;
  /** The interarrival jitter estimate (RFC 3550), ms. */
  jitterMs: number;
  delayMs: number;
}

/** a − b on 16-bit sequence numbers, in −32768…32767. */
export function seqDiff(a: number, b: number): number {
  return ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
}

export class JitterBuffer {
  readonly config: JitterConfig;
  private readonly frames = new Map<number, { packet: Uint8Array; start: boolean }>();
  private playing = false;
  /** True from a spurt's first arrival until its playback starts: its first frame is chosen then. */
  private fresh = false;
  /** The next sequence number to play, and when its step is due. */
  private next = 0;
  private startAt = 0;
  private empty = 0;
  /** Concealed steps since the last frame played: a loss if a frame follows, the tail if not. */
  private tail = 0;
  private lastArrival: { seq: number; at: number } | undefined;
  private jitter: number;
  private delay: number;
  private readonly counts = { played: 0, gaps: 0, recovered: 0, concealed: 0, late: 0, duplicates: 0, spurts: 0 };

  constructor(config: Partial<JitterConfig> = {}) {
    this.config = { ...DEFAULT_JITTER, ...config };
    this.jitter = this.config.initialJitterMs;
    this.delay = this.config.minDelayMs;
  }

  stats(): JitterStats {
    return { ...this.counts, jitterMs: this.jitter, delayMs: this.delay };
  }

  push(seq: number, packet: Uint8Array, arrivalMs: number, start = false): void {
    // Transit-time difference between arrivals, against the sender's 20 ms slot clock (RFC 3550).
    // Only between arrivals under 200 ms apart: across a long silence the sender's clock may have
    // paused (a suspended audio context), and one such sample would skew the estimate.
    if (this.lastArrival && arrivalMs - this.lastArrival.at < 200) {
      const d = arrivalMs - this.lastArrival.at - seqDiff(seq, this.lastArrival.seq) * this.config.frameMs;
      this.jitter += (Math.abs(d) - this.jitter) / 16;
    }
    if (!this.lastArrival || seqDiff(seq, this.lastArrival.seq) > 0) this.lastArrival = { seq, at: arrivalMs };
    if (this.playing && !this.fresh && seqDiff(seq, this.next) < 0) {
      this.counts.late += 1;
      return;
    }
    if (this.frames.has(seq)) {
      this.counts.duplicates += 1;
      return;
    }
    this.frames.set(seq, { packet, start });
    if (this.frames.size > this.config.capacity) {
      let oldest: number | undefined;
      for (const s of this.frames.keys()) if (oldest === undefined || seqDiff(s, oldest) < 0) oldest = s;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
    if (!this.playing) {
      // The spurt's first frame is chosen when playback starts, not now: with jitter, a later frame
      // can arrive before the first one.
      this.playing = true;
      this.fresh = true;
      this.counts.spurts += 1;
      this.delay = Math.min(this.config.maxDelayMs, Math.max(this.config.minDelayMs, this.config.frameMs + 3 * this.jitter));
      // Each frame waits `delay` between its arrival and the start of its playback.
      this.startAt = arrivalMs + this.delay;
      this.empty = 0;
    }
  }

  /** One 20 ms step of playback at `nowMs`; returns what to play. */
  step(nowMs: number): Step {
    if (!this.playing || nowMs < this.startAt) return { kind: 'idle' };
    if (this.fresh) {
      this.fresh = false;
      this.next = this.earliest() ?? this.next;
    }
    const seq = this.next;
    this.next = (this.next + 1) & 0xffff;
    const here = this.frames.get(seq);
    if (here) {
      this.frames.delete(seq);
      this.empty = 0;
      // Concealed steps right before a spurt's first frame were the speaker's silence.
      if (here.start) {
        this.counts.concealed -= this.tail;
        this.counts.gaps += this.tail;
      }
      this.tail = 0;
      this.counts.played += 1;
      return { kind: 'frame', seq, packet: here.packet };
    }
    const ahead = this.earliest();
    if (ahead !== undefined && seqDiff(ahead, seq) > 0 && this.frames.get(ahead)?.start) {
      this.empty = 0;
      this.counts.gaps += 1;
      return { kind: 'gap', seq };
    }
    this.empty += 1;
    if (this.empty >= this.config.endAfter) {
      this.counts.concealed -= this.tail;
      this.tail = 0;
      this.playing = false;
      this.frames.clear();
      return { kind: 'idle' };
    }
    const following = this.frames.get((seq + 1) & 0xffff);
    if (following && !following.start) {
      this.counts.recovered += 1;
      this.tail = 0;
      return { kind: 'fec', seq, packet: following.packet };
    }
    this.counts.concealed += 1;
    this.tail += 1;
    return { kind: 'conceal', seq };
  }

  private earliest(): number | undefined {
    let first: number | undefined;
    for (const s of this.frames.keys()) if (first === undefined || seqDiff(s, first) < 0) first = s;
    return first;
  }
}
