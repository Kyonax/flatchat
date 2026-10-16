// SPDX-License-Identifier: MPL-2.0
// A fixed-rate tick loop that keeps its schedule (each tick is planned from the start time, so
// delays never accumulate) and records how long each tick took.

export interface Ticker {
  /** Ticks run so far. */
  readonly ticks: number;
  /** Stops the loop; resolves with the number of ticks that ran. */
  stop(): Promise<number>;
  /** Resolves when the loop stops, by stop() or by reaching its tick limit. */
  readonly done: Promise<number>;
}

export interface TickerOptions {
  hz: number;
  onTick: (tick: number) => void;
  /** Stop by itself after this many ticks. */
  maxTicks?: number;
  /** Called with each tick's duration in milliseconds. */
  onTiming?: (ms: number) => void;
}

export function startTicker({ hz, onTick, maxTicks, onTiming }: TickerOptions): Ticker {
  if (!(hz > 0 && hz <= 1000)) throw new RangeError(`tick rate out of range: ${hz}`);
  const period = 1000 / hz;
  const start = performance.now();
  let ticks = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = true;
  let finish: (n: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const halt = (): number => {
    if (running) {
      running = false;
      if (timer) clearTimeout(timer);
      finish(ticks);
    }
    return ticks;
  };

  const loop = (): void => {
    if (!running) return;
    const t0 = performance.now();
    onTick(ticks);
    ticks += 1;
    onTiming?.(performance.now() - t0);
    if (maxTicks !== undefined && ticks >= maxTicks) {
      halt();
      return;
    }
    const next = start + ticks * period;
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  };

  timer = setTimeout(loop, 0);
  return {
    get ticks() {
      return ticks;
    },
    stop: async () => halt(),
    done,
  };
}
