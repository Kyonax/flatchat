// SPDX-License-Identifier: MPL-2.0
// The voice chain's pure parts: the playout buffer under loss and jitter, the distance curve and
// the mouth shapes.
import { describe, expect, it } from 'vitest';
import { voiceCutoffHz, voiceGain } from '../src/renderer/src/voice/distance';
import { JitterBuffer, seqDiff } from '../src/renderer/src/voice/jitter';
import { mouthShape } from '../src/renderer/src/voice/mouth';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Talk spurts over a lossy, jittery link, played on a 20 ms clock. As in protocol 1, seq counts
 * every 20 ms slot and the first frame after silence has `start`; `pauses` adds a short pause of
 * `pauses` slots every 500 ms of speech, the gaps between words that real speech has.
 */
function simulate(loss: number, jitterMs: number, seconds: number, seed = 1, pauses = 0) {
  const random = seeded(seed);
  const buffer = new JitterBuffer();
  const arrivals: Array<{ at: number; seq: number; start: boolean }> = [];
  let silent = true;
  for (let t = 0, slot = 1; t < seconds * 1000; t += 20, slot += 1) {
    const talking = t % 4000 < 3000 && !(pauses > 0 && t % 500 < pauses * 20 && t % 4000 >= 500); // 3 s of speech, 1 s of silence
    if (!talking) {
      silent = true;
      continue;
    }
    const start = silent;
    silent = false;
    if (random() < loss) continue;
    arrivals.push({ at: t + 5 + random() * jitterMs, seq: slot & 0xffff, start });
  }
  arrivals.sort((a, b) => a.at - b.at);
  let i = 0;
  for (let now = 0; now < seconds * 1000 + 500; now += 20) {
    while (i < arrivals.length && arrivals[i]!.at <= now) {
      buffer.push(arrivals[i]!.seq, new Uint8Array([1]), arrivals[i]!.at, arrivals[i]!.start);
      i += 1;
    }
    buffer.step(now);
  }
  return buffer.stats();
}

/** A link already measured as clean: the delay is one frame, so the tests can name each step's time. */
const MEASURED = { initialJitterMs: 0 };

describe('the playout buffer', () => {
  it('plays a clean stream in order, the first spurt cautiously and then with the shortest delay', () => {
    const s = simulate(0, 0, 10);
    expect(s.concealed).toBe(0);
    expect(s.recovered).toBe(0);
    expect(s.late).toBe(0);
    expect(s.played).toBe(400); // spurts of 150, 150 and 100 frames in 10 s
    expect(s.delayMs).toBeCloseTo(20, 3);
  });

  it('conceals at most 2% of frames at 5% loss and 40 ms of jitter (S0.08), rebuilding the rest from FEC', () => {
    const s = simulate(0.05, 40, 60);
    const due = s.played + s.recovered + s.concealed;
    expect(s.recovered).toBeGreaterThan(0);
    expect(s.concealed / due).toBeLessThanOrEqual(0.02);
    expect(s.delayMs).toBeGreaterThan(40);
    expect(s.delayMs).toBeLessThanOrEqual(80);
  });

  it('plays short pauses between words as silence, not as lost frames (protocol 1)', () => {
    const s = simulate(0, 40, 20, 1, 3);
    expect(s.concealed).toBe(0);
    expect(s.late).toBe(0);
    expect(s.gaps).toBeGreaterThan(0);
    const lossy = simulate(0.05, 40, 60, 1, 3);
    expect(lossy.concealed / (lossy.played + lossy.recovered + lossy.concealed)).toBeLessThanOrEqual(0.02);
    expect(lossy.late).toBe(0);
  });

  it('knows a pause from a loss by the start flag', () => {
    // Slots 1 to 5 spoken, 6 to 8 silent, 9 and 10 spoken: 9 is a start frame and arrives early.
    const b = new JitterBuffer(MEASURED);
    for (let s = 1; s <= 5; s++) b.push(s, new Uint8Array([s]), s * 20, s === 1);
    b.push(9, new Uint8Array([9]), 100, true);
    b.push(10, new Uint8Array([10]), 110);
    const kinds: string[] = [];
    for (let now = 60; now <= 240; now += 20) kinds.push(b.step(now).kind);
    expect(kinds).toEqual(['frame', 'frame', 'frame', 'frame', 'frame', 'gap', 'gap', 'gap', 'frame', 'frame']);
    expect(b.stats()).toMatchObject({ played: 7, gaps: 3, concealed: 0, recovered: 0 });
  });

  it('counts the steps concealed while waiting for a start frame as silence', () => {
    // The start frame after the pause arrives just before its turn: the pause is concealed, then known.
    const b = new JitterBuffer(MEASURED);
    for (let s = 1; s <= 5; s++) b.push(s, new Uint8Array([s]), s * 20, s === 1);
    const kinds: string[] = [];
    for (let now = 60; now <= 200; now += 20) kinds.push(b.step(now).kind);
    b.push(9, new Uint8Array([9]), 210, true);
    expect(kinds).toEqual(['frame', 'frame', 'frame', 'frame', 'frame', 'conceal', 'conceal', 'conceal']);
    expect(b.step(220)).toMatchObject({ kind: 'frame', seq: 9 });
    expect(b.stats()).toMatchObject({ played: 6, gaps: 3, concealed: 0 });
  });

  it('never rebuilds a silent slot from a start frame', () => {
    const b = new JitterBuffer(MEASURED);
    b.push(1, new Uint8Array([1]), 20, true);
    b.push(3, new Uint8Array([3]), 30, true);
    expect(b.step(60)).toMatchObject({ kind: 'frame', seq: 1 });
    expect(b.step(80)).toMatchObject({ kind: 'gap', seq: 2 });
    expect(b.step(100)).toMatchObject({ kind: 'frame', seq: 3 });
  });

  it('drops duplicates and frames that come after their turn', () => {
    const b = new JitterBuffer(MEASURED);
    b.push(10, new Uint8Array([1]), 0);
    b.push(10, new Uint8Array([1]), 1);
    expect(b.stats().duplicates).toBe(1);
    expect(b.step(10).kind).toBe('idle');
    expect(b.step(20)).toMatchObject({ kind: 'frame', seq: 10 });
    b.push(9, new Uint8Array([1]), 21);
    expect(b.stats().late).toBe(1);
  });

  it('crosses the 16-bit wrap', () => {
    expect(seqDiff(0, 65_535)).toBe(1);
    expect(seqDiff(65_535, 0)).toBe(-1);
    const b = new JitterBuffer(MEASURED);
    b.push(65_535, new Uint8Array([1]), 0);
    b.push(0, new Uint8Array([2]), 20);
    expect(b.step(10).kind).toBe('idle');
    expect(b.step(20)).toMatchObject({ kind: 'frame', seq: 65_535 });
    expect(b.step(40)).toMatchObject({ kind: 'frame', seq: 0 });
  });

  it('does not count the end of speech as lost frames', () => {
    const b = new JitterBuffer();
    for (let s = 1; s <= 5; s++) b.push(s, new Uint8Array([1]), s * 20);
    for (let now = 40; now < 400; now += 20) b.step(now);
    expect(b.stats()).toMatchObject({ played: 5, concealed: 0, spurts: 1 });
  });
});

describe('the distance curve', () => {
  it('is full up to 1 m, fades smoothly and is silent by 25 m', () => {
    expect(voiceGain(0)).toBe(1);
    expect(voiceGain(1)).toBe(1);
    expect(voiceGain(25)).toBe(0);
    expect(voiceGain(40)).toBe(0);
    expect(voiceGain(24)).toBeGreaterThan(0);
    for (let d = 1; d < 25; d += 0.5) expect(voiceGain(d + 0.5)).toBeLessThan(voiceGain(d));
    expect(voiceCutoffHz(1)).toBeCloseTo(18_000, 0);
    expect(voiceCutoffHz(25)).toBeCloseTo(2_500, 0);
  });
});

describe('mouth shapes', () => {
  const vowel = (f1: number, f2: number, amp = 0.3): Float32Array => {
    const out = new Float32Array(960);
    for (let i = 0; i < out.length; i++) {
      const t = i / 48_000;
      out[i] = amp * (Math.sin(2 * Math.PI * f1 * t) + 0.6 * Math.sin(2 * Math.PI * f2 * t));
    }
    return out;
  };

  it('is closed for silence', () => {
    expect(mouthShape(new Float32Array(960))).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 });
  });

  it.each([
    ['aa', 750, 1250],
    ['ih', 300, 2300],
    ['ou', 320, 850],
    ['ee', 480, 1900],
    ['oh', 520, 950],
  ] as const)('opens most for %s', (name, f1, f2) => {
    const m = mouthShape(vowel(f1, f2));
    const best = (['aa', 'ih', 'ou', 'ee', 'oh'] as const).reduce((a, b) => (m[b] > m[a] ? b : a));
    expect(best).toBe(name);
    expect(m.level).toBeGreaterThan(8);
  });

  it('follows loudness', () => {
    expect(mouthShape(vowel(750, 1250, 0.02)).level).toBeLessThan(mouthShape(vowel(750, 1250, 0.3)).level);
  });
});
