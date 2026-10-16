// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { startTicker } from '../src/ticker.ts';

describe('startTicker', () => {
  it('runs the requested number of ticks at about the requested rate', async () => {
    const seen: number[] = [];
    const t0 = performance.now();
    const ticker = startTicker({ hz: 100, maxTicks: 20, onTick: (n) => seen.push(n) });
    expect(await ticker.done).toBe(20);
    const elapsed = performance.now() - t0;
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // 20 ticks at 100 Hz are planned over 190 ms; allow for a busy test machine.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
  });

  it('stops on request and reports the ticks that ran', async () => {
    const ticker = startTicker({ hz: 200, onTick: () => {} });
    await new Promise((r) => setTimeout(r, 60));
    const ran = await ticker.stop();
    expect(ran).toBeGreaterThan(0);
    expect(await ticker.done).toBe(ran);
    await new Promise((r) => setTimeout(r, 30));
    expect(ticker.ticks).toBe(ran);
  });

  it('rejects a rate outside 1 to 1000 Hz', () => {
    expect(() => startTicker({ hz: 0, onTick: () => {} })).toThrow(RangeError);
    expect(() => startTicker({ hz: 5000, onTick: () => {} })).toThrow(RangeError);
  });
});
