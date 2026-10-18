// SPDX-License-Identifier: MPL-2.0
// The voice chain in the renderer (the plan's VOICE; DR-09, DR-10).
//
// Sending: an audio source (the microphone, with Chromium's echo cancellation, noise suppression
// and gain control; or a test signal) → the capture worklet's 20 ms frames → mouth shapes and a
// simple voice-activity gate (frames below the speech level are not sent, 200 ms of hangover) →
// Opus → `send`. While `muted`, the gate stays shut.
// Hearing: each voiceBundle frame goes into its speaker's playout buffer (jitter.ts); the
// speaker's playout worklet asks for a frame every 20 ms of audio, and the chain answers with the
// decoded frame, an FEC rebuild, a concealment or silence → a low-pass and a gain by distance
// (distance.ts), lower and darker when a wall stands between (S6.06's occlusion) → an HRTF panner at
// the speaker's position → the output, and the room around the listener (a reverb zone's, on this
// context's own convolver). At most 16 speakers.
import type { ReverbRoom } from '@flatchat/content';
import type { MessageOf } from '@flatchat/protocol';
import { type Audible, OCCLUDED_GAIN, OCCLUDED_HZ, Reverb } from '../world/acoustics';
import captureUrl from './capture-worklet.ts?worker&url';
import type { ClipRecorder } from './clip';
import { speakerLevel, VOICE_RANGE_M, voiceCutoffHz } from './distance';
import { JitterBuffer, type JitterStats } from './jitter';
import { type MouthShape, mouthShape } from './mouth';
import { FRAME_SAMPLES, type OpusDecoderHandle, type OpusEncoderHandle, SAMPLE_RATE, voiceDecoder, voiceEncoder } from './opus';
import playoutUrl from './playout-worklet.ts?worker&url';

export interface VoiceFrameOut {
  seq: number;
  /** The first frame after silence (protocol version 1). */
  start: boolean;
  mouth: MouthShape;
  opus: Uint8Array;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface VoiceStats {
  sent: number;
  gated: number;
  encodeMs: number;
  decoded: number;
  decodeMs: number;
  speakers: number;
  jitter: JitterStats;
}

interface Speaker {
  entity: number;
  jitter: JitterBuffer;
  decoder: OpusDecoderHandle;
  node: AudioWorkletNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  lastHeard: number;
  mouth: MouthShape;
  /** The world's gain and range for this speaker, from its latest frame (S3.08). */
  worldGain: number;
  range: number;
  /** Where it was last placed, to set its level again when a setting changes. */
  at: Vec3 | undefined;
  /** Whether a wall stands between it and the listener (S6.06). */
  occluded: boolean;
}

const MAX_SPEAKERS = 16;
const SPEECH_LEVEL = 2;
const HANGOVER_FRAMES = 10;
const FORGET_MS = 3000;
const SILENCE = new Float32Array(FRAME_SAMPLES);

export class VoiceChain {
  readonly ctx: AudioContext;
  /** Where every heard voice goes; connect it to ctx.destination, a recorder or a meter. */
  readonly output: GainNode;
  /** Keeps the last seconds of what was heard, for a report's clip (S3.02). */
  recorder: ClipRecorder | undefined;
  /** Speakers this player muted (S3.08, their accounts mapped to entities): their voice is dropped. */
  silenced: ReadonlySet<number> = new Set();
  /** Earmuffs (S3.08): far voices drop to a murmur. */
  earmuffs = false;
  /** This player's volume for one person, by entity (S3.08); 1 when not set. */
  volumeOf: (entity: number) => number = () => 1;
  private readonly freeDecoders: OpusDecoderHandle[];
  private readonly speakers = new Map<number, Speaker>();
  /** While true, captured frames are not sent; the first frame after unmuting has `start`. */
  muted = false;
  /** The loudness of the last captured frame, 0 to 15, sent or not. */
  micLevel = 0;
  private encoder: OpusEncoderHandle | undefined;
  private seq = 0;
  private hangover = 0;
  private gated = true;
  private listener: Vec3 = { x: 0, y: 1.6, z: 0 };
  private readonly counts = { sent: 0, gated: 0, encodeMs: 0, decoded: 0, decodeMs: 0 };
  private readonly finished: JitterStats[] = [];

  /** The room around the listener; every voice is sent to it. */
  readonly reverb: Reverb;

  private constructor(ctx: AudioContext, decoders: OpusDecoderHandle[]) {
    this.ctx = ctx;
    this.freeDecoders = decoders;
    this.output = new GainNode(ctx);
    this.reverb = new Reverb(ctx, this.output);
  }

  /** Loads the worklets and 16 decoders (one per speaker that can be heard at once). */
  static async create(ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })): Promise<VoiceChain> {
    await ctx.audioWorklet.addModule(captureUrl);
    await ctx.audioWorklet.addModule(playoutUrl);
    const decoders = await Promise.all(Array.from({ length: MAX_SPEAKERS }, () => voiceDecoder()));
    return new VoiceChain(ctx, decoders);
  }

  /** Captures `source`, and hands every 20 ms frame of speech to `send`, encoded. */
  async startSending(source: AudioNode, send: (frame: VoiceFrameOut) => void): Promise<AudioWorkletNode> {
    this.encoder ??= await voiceEncoder();
    // One silent output to the destination keeps the node in the rendered graph.
    const capture = new AudioWorkletNode(this.ctx, 'flatchat-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    source.connect(capture);
    capture.connect(new GainNode(this.ctx, { gain: 0 })).connect(this.ctx.destination);
    capture.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const pcm = e.data;
      const mouth = mouthShape(pcm);
      this.micLevel = mouth.level;
      // seq counts every 20 ms slot, silent or not, so listeners see how long a gap was.
      this.seq = (this.seq + 1) & 0xffff;
      if (mouth.level >= SPEECH_LEVEL) this.hangover = HANGOVER_FRAMES;
      else if (this.hangover > 0) this.hangover -= 1;
      if (this.hangover === 0 || this.muted) {
        this.counts.gated += 1;
        this.gated = true;
        return;
      }
      const t0 = performance.now();
      const opus = this.encoder!.encodeFloat(pcm);
      this.counts.encodeMs += performance.now() - t0;
      this.counts.sent += 1;
      send({ seq: this.seq, start: this.gated, mouth, opus });
      this.gated = false;
    };
    return capture;
  }

  /** Whether the microphone's frames are going out right now: not muted, and the voice gate open. */
  get sending(): boolean {
    return !this.muted && this.hangover > 0;
  }

  /** A voiceBundle from the world server. */
  receive(bundle: MessageOf<'voiceBundle'>): void {
    const now = performance.now();
    for (const frame of bundle.frames) {
      if (this.silenced.has(frame.from)) continue;
      const speaker = this.speakers.get(frame.from) ?? this.addSpeaker(frame.from);
      if (!speaker) continue;
      speaker.jitter.push(frame.seq, frame.opus, now, frame.start);
      speaker.mouth = frame.mouth;
      speaker.lastHeard = now;
      speaker.worldGain = frame.gain / 64;
      speaker.range = frame.range || VOICE_RANGE_M;
    }
    for (const s of [...this.speakers.values()]) if (now - s.lastHeard > FORGET_MS) this.removeSpeaker(s);
  }

  /** Where the listener stands and where each speaker's mouth is (metres, world axes; yaw in radians). */
  place(listener: Vec3, yaw: number, speakers: ReadonlyMap<number, Vec3>): void {
    this.listener = listener;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    l.positionX.setValueAtTime(listener.x, t);
    l.positionY.setValueAtTime(listener.y, t);
    l.positionZ.setValueAtTime(listener.z, t);
    l.forwardX.setValueAtTime(Math.sin(yaw), t);
    l.forwardY.setValueAtTime(0, t);
    l.forwardZ.setValueAtTime(Math.cos(yaw), t);
    for (const [entity, at] of speakers) {
      const s = this.speakers.get(entity);
      if (s) this.position(s, at);
    }
  }

  /** The speakers placed, for the occlusion's rays: each within its range. */
  audibles(): Audible[] {
    const out: Audible[] = [];
    for (const s of this.speakers.values()) if (s.at) out.push({ key: `voice:${s.entity}`, at: s.at, reach: s.range });
    return out;
  }

  /** Muffles the voices behind something (by the occlusion's latest state); returns how many are. */
  occlude(state: ReadonlyMap<string, boolean>): number {
    let n = 0;
    for (const s of this.speakers.values()) {
      const occluded = state.get(`voice:${s.entity}`) ?? false;
      if (occluded) n += 1;
      if (occluded === s.occluded) continue;
      s.occluded = occluded;
      if (s.at) this.position(s, s.at);
    }
    return n;
  }

  /** The room around the listener (a reverb zone's; undefined: none). */
  room(room: ReverbRoom | undefined, mix: number): void {
    this.reverb.set(room, mix);
  }

  /** The mouth shapes last heard from a speaker, for its avatar's lips. */
  mouthOf(entity: number): MouthShape | undefined {
    return this.speakers.get(entity)?.mouth;
  }

  stats(): VoiceStats {
    const jitter: JitterStats = { played: 0, gaps: 0, recovered: 0, concealed: 0, late: 0, duplicates: 0, spurts: 0, jitterMs: 0, delayMs: 0 };
    const all = [...this.finished, ...[...this.speakers.values()].map((s) => s.jitter.stats())];
    for (const j of all) {
      jitter.played += j.played;
      jitter.gaps += j.gaps;
      jitter.recovered += j.recovered;
      jitter.concealed += j.concealed;
      jitter.late += j.late;
      jitter.duplicates += j.duplicates;
      jitter.spurts += j.spurts;
      jitter.jitterMs = Math.max(jitter.jitterMs, j.jitterMs);
      jitter.delayMs = Math.max(jitter.delayMs, j.delayMs);
    }
    return { ...this.counts, speakers: this.speakers.size, jitter };
  }

  close(): void {
    for (const s of [...this.speakers.values()]) this.removeSpeaker(s);
    this.reverb.close();
    this.encoder?.free();
    for (const d of this.freeDecoders) d.free();
    void this.ctx.close();
  }

  private addSpeaker(entity: number): Speaker | undefined {
    const decoder = this.freeDecoders.pop();
    if (!decoder) return undefined;
    const node = new AudioWorkletNode(this.ctx, 'flatchat-playout', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const filter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 18_000, Q: 0.7 });
    const gain = new GainNode(this.ctx, { gain: 1 });
    // Distance loudness is the gain node's (distance.ts), so the panner only places the voice.
    const panner = new PannerNode(this.ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, refDistance: 1, maxDistance: 10_000 });
    node.connect(filter).connect(gain).connect(panner).connect(this.output);
    panner.connect(this.reverb.input);
    const speaker: Speaker = { entity, jitter: new JitterBuffer(), decoder, node, filter, gain, panner, lastHeard: performance.now(), mouth: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, level: 0 }, worldGain: 1, range: VOICE_RANGE_M, at: undefined, occluded: false };
    node.port.onmessage = () => node.port.postMessage(...this.nextFrame(speaker));
    this.speakers.set(entity, speaker);
    return speaker;
  }

  private nextFrame(s: Speaker): [Float32Array, Transferable[]] {
    const step = s.jitter.step(performance.now());
    if (step.kind === 'idle' || step.kind === 'gap') return [SILENCE.slice(), []];
    const t0 = performance.now();
    let pcm: Float32Array;
    try {
      if (step.kind === 'frame') pcm = s.decoder.decodeFloat(step.packet);
      else if (step.kind === 'fec') pcm = s.decoder.decodeFloat(step.packet, { decodeFec: true, frameSize: FRAME_SAMPLES });
      else pcm = s.decoder.decodePacketLossFloat(FRAME_SAMPLES);
    } catch {
      pcm = s.decoder.decodePacketLossFloat(FRAME_SAMPLES);
    }
    this.counts.decodeMs += performance.now() - t0;
    this.counts.decoded += 1;
    // The decoder's output may sit in WebAssembly memory: copy it before transferring.
    const copy = Float32Array.from(pcm);
    this.recorder?.add(s.entity, t0, copy);
    return [copy, [copy.buffer]];
  }

  private position(s: Speaker, at: Vec3): void {
    const t = this.ctx.currentTime;
    const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
    s.at = at;
    s.panner.positionX.setValueAtTime(at.x, t);
    s.panner.positionY.setValueAtTime(at.y, t);
    s.panner.positionZ.setValueAtTime(at.z, t);
    s.gain.gain.setTargetAtTime(speakerLevel(d, s.range, s.worldGain, this.volumeOf(s.entity), this.earmuffs) * (s.occluded ? OCCLUDED_GAIN : 1), t, 0.05);
    s.filter.frequency.setTargetAtTime(s.occluded ? Math.min(OCCLUDED_HZ, voiceCutoffHz(d, s.range)) : voiceCutoffHz(d, s.range), t, 0.05);
  }

  private removeSpeaker(s: Speaker): void {
    s.node.port.onmessage = null;
    s.node.disconnect();
    s.panner.disconnect();
    this.finished.push(s.jitter.stats());
    this.freeDecoders.push(s.decoder);
    this.speakers.delete(s.entity);
  }
}
