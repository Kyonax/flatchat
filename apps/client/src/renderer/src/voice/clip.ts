// SPDX-License-Identifier: MPL-2.0
// The reporter's voice clip (S3.02, OQ-18): the last seconds of what this client heard, kept only
// in memory. Each decoded 20 ms frame (48 kHz, the voice chain's) is kept at 16 kHz with its
// speaker and the moment it played; older frames fall away. A report alone takes the clip
// (world/report.ts, the only caller of takeClip: trap T20), so it never leaves the client without
// one. Hosts may not record voice (the host agreement); this is the player's own evidence.

export const CLIP_SECONDS = 15;
export const CLIP_RATE = 16_000;
const SAMPLES_PER_MS = CLIP_RATE / 1000;

interface Piece {
  at: number;
  entity: number;
  pcm: Int16Array;
}

export interface Clip {
  /** A WAV file: 16 kHz, mono, 16-bit. */
  wav: Uint8Array;
  /** The clip's start and end, on the clock `add` and `takeClip` were given. */
  from: number;
  to: number;
  /** Who spoke, and when, in milliseconds from the clip's start. */
  speech: Array<{ entity: number; from: number; to: number }>;
}

export class ClipRecorder {
  private readonly seconds: number;
  private pieces: Piece[] = [];
  private head = 0;

  constructor(seconds = CLIP_SECONDS) {
    this.seconds = seconds;
  }

  /** One decoded frame from a speaker (48 kHz, -1…1), played at `at` milliseconds. */
  add(entity: number, at: number, pcm48: Float32Array): void {
    const n = Math.floor(pcm48.length / 3);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = (pcm48[i * 3]! + pcm48[i * 3 + 1]! + pcm48[i * 3 + 2]!) / 3;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    this.pieces.push({ at, entity, pcm });
    const cutoff = at - this.seconds * 1000;
    while (this.head < this.pieces.length && this.pieces[this.head]!.at < cutoff) this.head += 1;
    // Drop what fell away now and then, not on every frame.
    if (this.head > 2048) {
      this.pieces = this.pieces.slice(this.head);
      this.head = 0;
    }
  }

  /** How many frames it holds, for tests and the debug view. */
  get frames(): number {
    return this.pieces.length - this.head;
  }

  /** The last seconds before `now`, mixed into one WAV; undefined when nothing was heard. */
  takeClip(now: number): Clip | undefined {
    const from = now - this.seconds * 1000;
    const kept = this.pieces.slice(this.head).filter((p) => p.at >= from && p.at <= now);
    if (kept.length === 0) return undefined;
    const length = Math.ceil(this.seconds * CLIP_RATE);
    const mix = new Int32Array(length);
    const spans = new Map<number, { from: number; to: number }[]>();
    for (const p of kept) {
      const start = Math.round((p.at - from) * SAMPLES_PER_MS);
      for (let i = 0; i < p.pcm.length && start + i < length; i++) if (start + i >= 0) mix[start + i]! += p.pcm[i]!;
      const ms = p.at - from;
      const end = ms + (p.pcm.length / SAMPLES_PER_MS);
      const list = spans.get(p.entity) ?? [];
      const last = list.at(-1);
      // Frames less than 100 ms apart are one stretch of speech.
      if (last && ms - last.to < 100) last.to = end;
      else list.push({ from: ms, to: end });
      spans.set(p.entity, list);
    }
    const pcm = new Int16Array(length);
    for (let i = 0; i < length; i++) pcm[i] = Math.max(-32768, Math.min(32767, mix[i]!));
    const speech = [...spans].flatMap(([entity, list]) => list.map((s) => ({ entity, from: Math.round(s.from), to: Math.round(s.to) })));
    return { wav: wavFile(pcm, CLIP_RATE), from, to: now, speech };
  }

  clear(): void {
    this.pieces = [];
    this.head = 0;
  }
}

/** A RIFF WAVE file around 16-bit mono samples. */
export function wavFile(pcm: Int16Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return bytes;
}
