// SPDX-License-Identifier: MPL-2.0
// The voice test of spike S0.08, run by the client with --voice-test against a world server.
//
// One renderer joins twice: a speaker and a listener in the same AudioContext, so both ends read
// the same clock. The speaker sends tone bursts (1 kHz, 60 ms, every 400 ms) through the real
// chain: the capture worklet, the voice gate, Opus, the unreliable data channel, the world
// server's voice bundles, the listener's playout buffer, the decoder, the distance filter and the
// HRTF panner. A detector marks when each burst comes out, so latency is measured from scheduled
// sound to played sound; the output device's own latency (outputLatency) is reported beside it.
// Then the listener walks away at 5 m/s and the heard level is recorded by distance: the voice
// must fade to silence by 25 m.
import { fromHex } from '@flatchat/protocol';
import { WorldConnection } from '../net/connection';
import { VoiceChain, type VoiceStats } from './chain';
import onsetUrl from './onset-worklet.ts?worker&url';

export interface VoiceTestReport {
  ok: boolean;
  error?: string;
  bursts: number;
  heard: number;
  /** From the burst's scheduled start to the moment it left the listener's chain. */
  latencyMs: { p50: number; p95: number; max: number };
  outputLatencyMs: number;
  baseLatencyMs: number;
  fade: Array<{ distanceM: number; levelDb: number }>;
  voice: VoiceStats;
  encodeMsPerFrame: number;
  decodeMsPerFrame: number;
}

const BURST_EVERY_S = 0.4;
const BURST_S = 0.06;

function quantile(sorted: number[], q: number): number {
  return sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0) : 0;
}

export async function runVoiceTest(signalUrl: string, speakerHex: string, listenerHex: string, seconds: number): Promise<VoiceTestReport> {
  const report: VoiceTestReport = {
    ok: false,
    bursts: 0,
    heard: 0,
    latencyMs: { p50: 0, p95: 0, max: 0 },
    outputLatencyMs: 0,
    baseLatencyMs: 0,
    fade: [],
    voice: { sent: 0, gated: 0, encodeMs: 0, decoded: 0, decodeMs: 0, speakers: 0, jitter: { played: 0, gaps: 0, recovered: 0, concealed: 0, late: 0, duplicates: 0, spurts: 0, jitterMs: 0, delayMs: 0 } },
    encodeMsPerFrame: 0,
    decodeMsPerFrame: 0,
  };
  let chain: VoiceChain | undefined;
  const conns: WorldConnection[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  try {
    chain = await VoiceChain.create();
    const ctx = chain.ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule(onsetUrl);
    const speaker = await WorldConnection.join({ signalUrl, token: fromHex(speakerHex) });
    conns.push(speaker);
    const second = fromHex(listenerHex);
    const listener = await WorldConnection.join({ signalUrl, token: second });
    conns.push(listener);
    const sAt = speaker.spawn!.position;
    const lSpawn = listener.spawn!.position;

    // Both keep sending their pose at 20 Hz; the listener's position is moved by the fade phase.
    const lAt = { ...lSpawn };
    let sSeq = 0;
    let lSeq = 0;
    timers.push(
      setInterval(() => {
        sSeq = (sSeq + 1) & 0xffff;
        lSeq = (lSeq + 1) & 0xffff;
        speaker.send({ type: 'pose', seq: sSeq, position: sAt, yaw: 0, look: 0, stance: 'standing' });
        listener.send({ type: 'pose', seq: lSeq, position: lAt, yaw: 0, look: 0, stance: 'standing' });
        chain?.place({ x: lAt.x, y: 1.6, z: lAt.z }, Math.PI / 2, new Map([[speaker.entity, { x: sAt.x, y: 1.6, z: sAt.z }]]));
      }, 50),
    );
    listener.onMessage((m) => {
      if (m.type === 'voiceBundle') chain?.receive(m);
    });

    // The heard voices go to a burst detector and a level meter, then to a silent output.
    const mute = new GainNode(ctx, { gain: 0 });
    mute.connect(ctx.destination);
    const onset = new AudioWorkletNode(ctx, 'flatchat-onset', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const meter = new AnalyserNode(ctx, { fftSize: 2048 });
    chain.output.connect(onset).connect(mute);
    chain.output.connect(meter);
    const detected: number[] = [];
    onset.port.onmessage = (e: MessageEvent<number>) => detected.push(e.data);

    // The speaker's "voice": 1 kHz bursts on the audio clock.
    const tone = new OscillatorNode(ctx, { frequency: 1000 });
    const envelope = new GainNode(ctx, { gain: 0 });
    tone.connect(envelope);
    await chain.startSending(envelope, (f) => speaker.send({ type: 'voice', seq: f.seq, start: f.start, mouth: f.mouth, opus: f.opus }));
    const first = ctx.currentTime + 0.5;
    const count = Math.max(1, Math.floor(seconds / BURST_EVERY_S));
    const scheduled: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = first + i * BURST_EVERY_S;
      envelope.gain.setValueAtTime(0.3, t);
      envelope.gain.setValueAtTime(0, t + BURST_S);
      scheduled.push(t);
    }
    tone.start();
    await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));

    const latencies: number[] = [];
    for (const t of scheduled) {
      const hit = detected.find((d) => d >= t && d < t + BURST_EVERY_S);
      if (hit !== undefined) latencies.push((hit - t) * 1000);
    }
    latencies.sort((a, b) => a - b);
    report.bursts = scheduled.length;
    report.heard = latencies.length;
    report.latencyMs = { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), max: latencies.at(-1) ?? 0 };
    report.outputLatencyMs = (ctx.outputLatency || 0) * 1000;
    report.baseLatencyMs = (ctx.baseLatency || 0) * 1000;

    // The fade: keep the bursts going (every 400 ms) and walk away at 5 m/s.
    const more = Math.ceil(8 / BURST_EVERY_S);
    const restart = ctx.currentTime + 0.1;
    for (let i = 0; i < more; i++) {
      envelope.gain.setValueAtTime(0.3, restart + i * BURST_EVERY_S);
      envelope.gain.setValueAtTime(0, restart + i * BURST_EVERY_S + 0.2);
    }
    const buf = new Float32Array(meter.fftSize);
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const walk = setInterval(() => {
        const s = (performance.now() - started) / 1000;
        lAt.x = lSpawn.x + 5 * s;
        meter.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        const d = Math.hypot(lAt.x - sAt.x, lAt.z - sAt.z);
        report.fade.push({ distanceM: Math.round(d * 10) / 10, levelDb: Math.round(20 * Math.log10(peak + 1e-9) * 10) / 10 });
        if (s >= 7.5) {
          clearInterval(walk);
          resolve();
        }
      }, 100);
    });
    tone.stop();
    report.voice = chain.stats();
    report.encodeMsPerFrame = report.voice.sent ? report.voice.encodeMs / report.voice.sent : 0;
    report.decodeMsPerFrame = report.voice.decoded ? report.voice.decodeMs / report.voice.decoded : 0;
    report.ok = report.heard >= report.bursts * 0.9;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    for (const t of timers) clearInterval(t);
    for (const c of conns) c.close('voice test over');
    chain?.close();
  }
  return report;
}
