// SPDX-License-Identifier: MPL-2.0
// Broken effects, made the same way every time (S6.01's Verify, R-18): copies of Effekseer's samples
// with bytes flipped, the file cut short, chunk sizes and counts that lie, garbage put in. The fuzz
// test runs the whole corpus through the reader and the runtime; scripts/hostile-effects.ts puts
// some of its cases into a built world, as a host that does not play fair would.

/** The samples the corpus breaks, in its order (kits/effects/samples). */
export const FUZZ_SAMPLES = ['00_Basic/Laser01.efkefc', '00_Version16/Aura01.efkefc', '00_Basic/Simple_Track1.efkefc'] as const;
/** Broken copies made of each sample, and the generator's seed. */
export const FUZZ_PER_SAMPLE = 100;
export const FUZZ_SEED = 20261018;

/** A small seeded generator (mulberry32), so the corpus is the same on every run. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the runtime body starts in a container (after "BIN_" and its size), or 0 for an .efk. */
function bodyAt(b: Uint8Array): number {
  for (let i = 8; i + 8 <= b.length; i++) if (b[i] === 0x42 && b[i + 1] === 0x49 && b[i + 2] === 0x4e && b[i + 3] === 0x5f) return i + 8;
  return 0;
}

/** One broken copy of `b`, by the kind of damage `kind` (0 to 5). */
export function broken(b: Uint8Array, kind: number, r: () => number): Uint8Array {
  const at = bodyAt(b);
  const pick = (lo: number): number => lo + Math.floor(r() * (b.length - lo));
  const out = b.slice();
  const view = new DataView(out.buffer);
  switch (kind) {
    case 0: {
      // A few bytes flipped in the body.
      const n = 1 + Math.floor(r() * 16);
      for (let i = 0; i < n; i++) out[pick(at)]! ^= 1 << Math.floor(r() * 8);
      return out;
    }
    case 1:
      // Cut short.
      return out.subarray(0, pick(0));
    case 2:
      // The runtime chunk's size lies.
      if (at >= 8) view.setInt32(at - 4, Math.floor((r() - 0.5) * 2 ** 31), true);
      return out;
    case 3: {
      // A 32-bit value somewhere in the body made huge or negative: a count, a length, a size.
      const p = pick(at) & ~3;
      if (p + 4 <= out.length) view.setInt32(p, [0x7fffffff, -1, 0x10000, 1025, -0x80000000][Math.floor(r() * 5)]!, true);
      return out;
    }
    case 4: {
      // Garbage written over a stretch of the body.
      const p = pick(at);
      const n = Math.min(out.length - p, 1 + Math.floor(r() * 64));
      for (let i = 0; i < n; i++) out[p + i] = Math.floor(r() * 256);
      return out;
    }
    default: {
      // Zeros put in, shifting everything after them.
      const p = pick(at);
      const zeros = new Uint8Array(1 + Math.floor(r() * 32));
      return new Uint8Array([...out.subarray(0, p), ...zeros, ...out.subarray(p)]);
    }
  }
}

export interface FuzzCase {
  /** Its place in the corpus, from 0. */
  index: number;
  sample: (typeof FUZZ_SAMPLES)[number];
  kind: number;
  bytes: Uint8Array;
}

/** The corpus, case by case: each sample's main file, from `read`, broken FUZZ_PER_SAMPLE ways. */
export function* fuzzCorpus(read: (sample: (typeof FUZZ_SAMPLES)[number]) => Uint8Array): Generator<FuzzCase> {
  const r = random(FUZZ_SEED);
  let index = 0;
  for (const sample of FUZZ_SAMPLES) {
    const main = read(sample);
    for (let i = 0; i < FUZZ_PER_SAMPLE; i++) yield { index: index++, sample, kind: i % 6, bytes: broken(main, i % 6, r) };
  }
}

/** An effect body by hand (an .efk): "SKFE", a version, then each resource list's paths, in the
 *  runtime's order (colour, normal and distortion textures, sounds, models, materials, curves). */
export function effectBody(version: number, lists: string[][]): Uint8Array {
  const parts: number[] = [];
  const i32 = (v: number): void => {
    parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  };
  parts.push(0x53, 0x4b, 0x46, 0x45);
  i32(version);
  for (const list of lists) {
    i32(list.length);
    for (const p of list) {
      i32(p.length + 1);
      for (const c of p + '\0') parts.push(c.charCodeAt(0), 0);
    }
  }
  return new Uint8Array(parts);
}
