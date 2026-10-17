// SPDX-License-Identifier: MPL-2.0
// Mouth shapes from the voice itself, on the sender (DR-09): for each 20 ms frame, the loudness and
// the weights of the five VRM visemes (aa, ih, ou, ee, oh), 0 to 15 each, three bytes on the wire
// beside the Opus frame, so the lips move in step with the sound.
//
// The method: a 1,024-point spectrum of the frame, the first two formants (F1 and F2: the
// strongest peaks between 250 and 1,000 Hz and between 800 and 2,800 Hz), and each vowel's
// closeness to its typical (F1, F2) on a log scale. It needs no calibration; uLipSync's MFCC
// matching (rr-013) can replace it behind the same function if it reads better on avatars.

export interface MouthShape {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
  level: number;
}

const N = 1024;
const RATE = 48_000;
const BIN_HZ = RATE / N;
/** Typical adult formants (F1, F2) in Hz for each viseme's vowel. */
const VOWELS = { aa: [750, 1250], ih: [300, 2300], ou: [320, 850], ee: [480, 1900], oh: [500, 900] } as const;
const SILENT_DB = -48;
const LOUD_DB = -12;

const bitReversed = new Uint16Array(N);
const cos = new Float64Array(N / 2);
const sin = new Float64Array(N / 2);
const hann = new Float64Array(960);
{
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    bitReversed[i] = r;
  }
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / N);
    sin[i] = Math.sin((-2 * Math.PI * i) / N);
  }
  for (let i = 0; i < hann.length; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (hann.length - 1));
}

/** Magnitude spectrum (N / 2 bins) of up to 960 samples, Hann-windowed and zero-padded. */
export function spectrum(frame: Float32Array): Float64Array {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < Math.min(frame.length, hann.length); i++) re[bitReversed[i]!] = (frame[i] ?? 0) * (hann[i] ?? 0);
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const tr = wr * re[b]! - wi * im[b]!;
        const ti = wr * im[b]! + wi * re[b]!;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}

function peakHz(mag: Float64Array, fromHz: number, toHz: number): number {
  let best = -1;
  let bestAt = Math.round(fromHz / BIN_HZ);
  for (let i = Math.round(fromHz / BIN_HZ); i <= Math.round(toHz / BIN_HZ) && i + 1 < mag.length; i++) {
    const smooth = (mag[i - 1] ?? 0) + 2 * (mag[i] ?? 0) + (mag[i + 1] ?? 0);
    if (smooth > best) {
      best = smooth;
      bestAt = i;
    }
  }
  return bestAt * BIN_HZ;
}

export function mouthShape(frame: Float32Array): MouthShape {
  let sum = 0;
  for (const v of frame) sum += v * v;
  const db = 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-12);
  const loud = Math.min(1, Math.max(0, (db - SILENT_DB) / (LOUD_DB - SILENT_DB)));
  const level = Math.round(loud * 15);
  if (level === 0) return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 };
  const mag = spectrum(frame);
  const f1 = peakHz(mag, 250, 1000);
  const f2 = peakHz(mag, Math.max(800, f1 + 200), 2800);
  const weights = Object.fromEntries(
    Object.entries(VOWELS).map(([name, [v1, v2]]) => {
      const d = Math.hypot(Math.log(f1 / v1) / 0.25, Math.log(f2 / v2) / 0.25);
      return [name, Math.exp(-d * d)];
    }),
  ) as Record<keyof typeof VOWELS, number>;
  const top = Math.max(...Object.values(weights), 1e-9);
  const q = (w: number): number => Math.round((w / top) * loud * 15);
  return { aa: q(weights.aa), ih: q(weights.ih), ou: q(weights.ou), ee: q(weights.ee), oh: q(weights.oh), level };
}
