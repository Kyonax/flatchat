// SPDX-License-Identifier: MPL-2.0
// The voice load test of spike S0.08 (--voice-load): the cost of hearing 16 voices at once, the
// plan's cap. It encodes a few seconds of a speech-like test signal once, then feeds 16 speakers
// through the whole hearing side of the chain (voiceBundle frames every 20 ms → playout buffers →
// Opus decoding → distance filters → HRTF panners → the output) with no network, while the main
// process samples the renderer's CPU. The pass line: at most 10 % of one laptop core.
import { VoiceChain } from './chain';
import { FRAME_SAMPLES, SAMPLE_RATE, voiceEncoder } from './opus';

export interface VoiceLoadReport {
  ok: boolean;
  error?: string;
  speakers: number;
  seconds: number;
  decoded: number;
  decodeMsPerFrame: number;
  concealed: number;
  /** Main-thread time spent decoding, as a share of the run. */
  decodeSharePct: number;
}

/** A vowel-like signal: a 140 Hz voice with moving formants and syllable-rate loudness. */
function speechLike(frames: number): Float32Array[] {
  const out: Float32Array[] = [];
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const pcm = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const t = (f * FRAME_SAMPLES + i) / SAMPLE_RATE;
      const pitch = 140 + 20 * Math.sin(2 * Math.PI * 0.7 * t);
      phase += (2 * Math.PI * pitch) / SAMPLE_RATE;
      const f1 = 500 + 250 * Math.sin(2 * Math.PI * 2.1 * t);
      const f2 = 1500 + 600 * Math.sin(2 * Math.PI * 1.3 * t);
      const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      let v = 0;
      for (let h = 1; h <= 30; h++) {
        const hz = h * pitch;
        const shape = Math.exp(-(((hz - f1) / 150) ** 2)) + 0.6 * Math.exp(-(((hz - f2) / 200) ** 2)) + 0.05;
        v += shape * Math.sin(h * phase) / h;
      }
      pcm[i] = 0.25 * syllable * v;
    }
    out.push(pcm);
  }
  return out;
}

export async function runVoiceLoad(seconds: number, speakers = 16): Promise<VoiceLoadReport> {
  const report: VoiceLoadReport = { ok: false, speakers, seconds, decoded: 0, decodeMsPerFrame: 0, concealed: 0, decodeSharePct: 0 };
  let chain: VoiceChain | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    chain = await VoiceChain.create();
    await chain.ctx.resume();
    // Heard through the real output path, at zero volume.
    chain.output.connect(new GainNode(chain.ctx, { gain: 0 })).connect(chain.ctx.destination);
    const encoder = await voiceEncoder();
    const packets = speechLike(150).map((pcm) => encoder.encodeFloat(pcm));
    encoder.free();
    const mouth = { aa: 8, ih: 2, ou: 1, ee: 3, oh: 4, level: 10 };
    const around = new Map<number, { x: number; y: number; z: number }>();
    for (let s = 0; s < speakers; s++) {
      const angle = (2 * Math.PI * s) / speakers;
      const d = 2 + (s % 8) * 2.5;
      around.set(100 + s, { x: Math.cos(angle) * d, y: 1.6, z: Math.sin(angle) * d });
    }
    let n = 0;
    const started = performance.now();
    timer = setInterval(() => {
      chain!.receive({
        type: 'voiceBundle',
        frames: [...around.keys()].map((from, s) => ({ from, seq: (n + 1) & 0xffff, start: n === 0, mouth, gain: 64, range: 0, opus: packets[(n + s * 7) % packets.length]! })),
      });
      if (n % 5 === 0) chain!.place({ x: 0, y: 1.6, z: 0 }, 0, around);
      n += 1;
    }, 20);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(timer);
    timer = undefined;
    const elapsed = performance.now() - started;
    const stats = chain.stats();
    report.decoded = stats.decoded;
    report.decodeMsPerFrame = stats.decoded ? stats.decodeMs / stats.decoded : 0;
    report.concealed = stats.jitter.concealed;
    report.decodeSharePct = (stats.decodeMs / elapsed) * 100;
    report.ok = stats.decoded > speakers * seconds * 40;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearInterval(timer);
    chain?.close();
  }
  return report;
}
