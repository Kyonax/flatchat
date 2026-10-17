// SPDX-License-Identifier: MPL-2.0
// Opus for the voice chain (DR-09): libopus 1.6.1 compiled to WebAssembly (libopus-wasm, MIT, with
// Xiph's BSD libopus inside), the same codec on both ends. WebCodecs could encode, but its decoder
// cannot rebuild a lost frame from the next packet's in-band FEC, which S0.08's loss line needs;
// this decoder can (decode(next, { decodeFec: true })) and also conceals (decodePacketLossFloat).
// Settings from the plan's VOICE: mono 48 kHz, 20 ms frames, 24 kb/s, VoIP, in-band FEC.
import { Application, createDecoder, createEncoder, type OpusDecoderHandle, type OpusEncoderHandle, Signal } from 'libopus-wasm';

export const SAMPLE_RATE = 48_000;
export const FRAME_SAMPLES = 960;
export const VOICE_BITRATE = 24_000;

export function voiceEncoder(expectedLossPercent = 5): Promise<OpusEncoderHandle> {
  return createEncoder({
    channels: 1,
    sampleRate: SAMPLE_RATE,
    application: Application.Voip,
    signal: Signal.Voice,
    bitrate: VOICE_BITRATE,
    frameSize: FRAME_SAMPLES,
    fec: true,
    packetLossPercent: expectedLossPercent,
    complexity: 5,
  });
}

export function voiceDecoder(): Promise<OpusDecoderHandle> {
  return createDecoder({ channels: 1, sampleRate: SAMPLE_RATE });
}

export type { OpusDecoderHandle, OpusEncoderHandle };
