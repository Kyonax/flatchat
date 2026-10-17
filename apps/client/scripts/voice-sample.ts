// SPDX-License-Identifier: MPL-2.0
// Spike S0.08's listening sample: real speech through the voice chain's own codec, voice gate and
// playout buffer, with packet loss and jitter simulated, written as WAV files to listen to side by
// side: the original, the speech through Opus on a clean link, and through the lossy link. The
// network is simulated (each 20 ms packet lost with the given chance, delayed by a random 0 to
// JITTER ms); everything else is the client's code. Beside the playout buffer's own counts, stats.json
// has the truth: what became of each sent frame (played, rebuilt from FEC, concealed or never played)
// and how many silent slots were concealed instead of left silent.
//
//   node apps/client/scripts/voice-sample.ts INPUT.wav OUTDIR [--loss 5] [--jitter 40] [--seed 1]
//
// INPUT is mono 16-bit PCM at 48 kHz. Writes original.wav, opus-clean.wav, opus-loss<L>-jitter<J>.wav
// and stats.json to OUTDIR.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { JitterBuffer } from '../src/renderer/src/voice/jitter.ts';
import { mouthShape } from '../src/renderer/src/voice/mouth.ts';
import { FRAME_SAMPLES, SAMPLE_RATE, voiceDecoder, voiceEncoder } from '../src/renderer/src/voice/opus.ts';

function readWav(path: string): Float32Array {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let at = 12;
  let format: { channels: number; rate: number; bits: number } | undefined;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') format = { channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) throw new Error(`${path}: needs mono 16-bit PCM at 48 kHz`);
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function writeWav(path: string, pcm: Float32Array): void {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((pcm[i] ?? 0) * 32767))), 44 + i * 2);
  writeFileSync(path, out);
}

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

const { values, positionals } = parseArgs({ allowPositionals: true, options: { loss: { type: 'string', default: '5' }, jitter: { type: 'string', default: '40' }, seed: { type: 'string', default: '1' } } });
const [input, outDir] = positionals;
if (!input || !outDir) {
  process.stderr.write('usage: voice-sample.ts INPUT.wav OUTDIR [--loss 5] [--jitter 40] [--seed 1]\n');
  process.exit(2);
}
const loss = Number(values.loss) / 100;
const jitter = Number(values.jitter);
const random = seeded(Number(values.seed));
mkdirSync(outDir, { recursive: true });

const pcm = readWav(input);
const frames: Float32Array[] = [];
for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) frames.push(pcm.slice(i, i + FRAME_SAMPLES));

// The sender: the client's voice gate (speech level 2 of 15, 200 ms of hangover), then Opus. As in
// protocol 1, seq counts every 20 ms slot and the first frame after silence has `start`.
const encoder = await voiceEncoder(Math.round(loss * 100));
const sent: Array<{ index: number; seq: number; start: boolean; packet: Uint8Array }> = [];
let hangover = 0;
let gated = true;
frames.forEach((frame, index) => {
  const level = mouthShape(frame).level;
  if (level >= 2) hangover = 10;
  else if (hangover > 0) hangover -= 1;
  if (hangover === 0) {
    gated = true;
    return;
  }
  sent.push({ index, seq: (index + 1) & 0xffff, start: gated, packet: encoder.encodeFloat(frame) });
  gated = false;
});
encoder.free();

// A clean link: every packet decoded at its own place.
const clean = new Float32Array(frames.length * FRAME_SAMPLES);
const cleanDecoder = await voiceDecoder();
for (const s of sent) clean.set(cleanDecoder.decodeFloat(s.packet), s.index * FRAME_SAMPLES);
cleanDecoder.free();

// The lossy link, through the playout buffer on a 20 ms clock.
const arrivals = sent.filter(() => random() >= loss).map((s) => ({ ...s, at: s.index * 20 + 5 + random() * jitter }));
arrivals.sort((a, b) => a.at - b.at);
const buffer = new JitterBuffer();
const bySeq = new Map(sent.map((s) => [s.seq, s]));
const decoder = await voiceDecoder();
const lossy = new Float32Array(frames.length * FRAME_SAMPLES + SAMPLE_RATE);
const outcome = new Map<number, string>();
let concealedSilence = 0;
let next = 0;
let out = 0;
for (let now = 0; out + FRAME_SAMPLES <= lossy.length; now += 20) {
  while (next < arrivals.length && arrivals[next]!.at <= now) {
    const a = arrivals[next]!;
    buffer.push(a.seq, a.packet, a.at, a.start);
    next += 1;
  }
  const step = buffer.step(now);
  if (step.kind !== 'idle') {
    if (bySeq.has(step.seq)) outcome.set(step.seq, step.kind);
    else if (step.kind === 'conceal') concealedSilence += 1;
  }
  const frame =
    step.kind === 'frame'
      ? decoder.decodeFloat(step.packet)
      : step.kind === 'fec'
        ? decoder.decodeFloat(step.packet, { decodeFec: true, frameSize: FRAME_SAMPLES })
        : step.kind === 'conceal'
          ? decoder.decodePacketLossFloat(FRAME_SAMPLES)
          : new Float32Array(FRAME_SAMPLES);
  lossy.set(frame, out);
  out += FRAME_SAMPLES;
}
decoder.free();

const name = `opus-loss${values.loss}-jitter${values.jitter}`;
writeWav(join(outDir, 'original.wav'), pcm);
writeWav(join(outDir, 'opus-clean.wav'), clean);
writeWav(join(outDir, `${name}.wav`), lossy);
const stats = buffer.stats();
const due = stats.played + stats.recovered + stats.concealed;
const truth = { played: 0, recovered: 0, concealed: 0, neverPlayed: 0, concealedSilence };
for (const s of sent) {
  const kind = outcome.get(s.seq);
  if (kind === 'frame') truth.played += 1;
  else if (kind === 'fec') truth.recovered += 1;
  else if (kind === 'conceal') truth.concealed += 1;
  else truth.neverPlayed += 1;
}
const truthPct = { concealedPct: ((truth.concealed + truth.neverPlayed) / sent.length) * 100, recoveredPct: (truth.recovered / sent.length) * 100 };
const summary = {
  input,
  frames: frames.length,
  sent: sent.length,
  lost: sent.length - arrivals.length,
  ...stats,
  concealedPct: due ? (stats.concealed / due) * 100 : 0,
  recoveredPct: due ? (stats.recovered / due) * 100 : 0,
  truth: { ...truth, ...truthPct },
};
writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ event: 'voice-sample', ...summary, files: ['original.wav', 'opus-clean.wav', `${name}.wav`] })}\n`);
