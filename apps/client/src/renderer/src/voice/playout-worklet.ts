// SPDX-License-Identifier: MPL-2.0
// Runs on the audio thread, one per heard speaker: plays the 20 ms frames the main thread decodes,
// and asks for the next one whenever less than about 28 ms of audio is queued or asked for, so the
// audio clock itself paces the playout buffer and the decoder while adding little delay. The main
// thread always answers, with silence when idle.
export {};

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/** Keep this many samples queued or asked for: one 20 ms frame plus three 128-sample blocks. */
const AHEAD = 960 + 384;

class PlayoutProcessor extends AudioWorkletProcessor {
  private readonly queue: Float32Array[] = [];
  private current: Float32Array | undefined;
  private at = 0;
  private asked = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.queue.push(e.data);
      this.asked = Math.max(0, this.asked - 1);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (out) {
      for (let i = 0; i < out.length; i++) {
        if (!this.current || this.at >= this.current.length) {
          this.current = this.queue.shift();
          this.at = 0;
        }
        out[i] = this.current ? (this.current[this.at++] ?? 0) : 0;
      }
    }
    let ahead = (this.current ? this.current.length - this.at : 0) + this.asked * 960;
    for (const f of this.queue) ahead += f.length;
    while (ahead < AHEAD) {
      this.port.postMessage('next');
      this.asked += 1;
      ahead += 960;
    }
    return true;
  }
}

registerProcessor('flatchat-playout', PlayoutProcessor);
