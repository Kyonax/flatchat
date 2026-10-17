// SPDX-License-Identifier: MPL-2.0
// Runs on the audio thread for the voice test: watches a signal for the start of each tone burst
// (the block's level crossing a threshold after at least 100 ms of quiet) and posts the audio-clock
// time of that sample, so the test compares it with when the burst was scheduled.
export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const currentTime: number;
declare const sampleRate: number;

const THRESHOLD = 0.02;
const QUIET_S = 0.1;

class OnsetProcessor extends AudioWorkletProcessor {
  private quietSince = 0;
  private loud = false;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const t = currentTime + i / sampleRate;
      if (Math.abs(input[i] ?? 0) >= THRESHOLD) {
        if (!this.loud && t - this.quietSince >= QUIET_S) this.port.postMessage(t);
        this.loud = true;
      } else if (this.loud) {
        this.loud = false;
        this.quietSince = t;
      }
    }
    return true;
  }
}

registerProcessor('flatchat-onset', OnsetProcessor);
