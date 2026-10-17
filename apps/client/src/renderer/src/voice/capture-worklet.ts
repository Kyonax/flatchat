// SPDX-License-Identifier: MPL-2.0
// Runs on the audio thread: gathers the microphone's 128-sample render quanta into 20 ms frames
// (960 samples at 48 kHz) and posts each to the main thread, which encodes and sends it.
export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const FRAME = 960;

class CaptureProcessor extends AudioWorkletProcessor {
  private frame = new Float32Array(FRAME);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input) {
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, FRAME - this.filled);
        this.frame.set(input.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === FRAME) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(FRAME);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('flatchat-capture', CaptureProcessor);
