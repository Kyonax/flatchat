// SPDX-License-Identifier: MPL-2.0
// The bots' pure parts: how they move and talk, and how a run's records become pass lines. Also
// the golden packets, through the protocol as the bots link it.
import { runGolden } from '@flatchat/protocol/golden';
import { describe, expect, it } from 'vitest';
import type { BotSummary } from '../src/bot.ts';
import { Brain, DEFAULT_BRAIN, hubsFor } from '../src/brain.ts';
import { analyse, markdown, type RunConfig } from '../src/report.ts';
import { Talker } from '../src/talker.ts';

describe('the protocol the bots link', () => {
  it('passes every golden packet', async () => {
    const report = await runGolden();
    expect(report.failures).toEqual([]);
    expect(report.cases).toBeGreaterThan(0);
  });
});

describe('movement', () => {
  it('stays inside the world, never faster than a run, and gathers at hubs', () => {
    const brain = new Brain(42, DEFAULT_BRAIN, { x: 128, z: 128 });
    const hubs = hubsFor(256, 'hubs');
    let last = brain.step(0);
    let nearHub = 0;
    for (let i = 0; i < 20 * 600; i++) {
      const p = brain.step(0.05);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeLessThan(256);
      expect(Math.hypot(p.x - last.x, p.z - last.z)).toBeLessThanOrEqual(DEFAULT_BRAIN.run * 0.05 + 1e-9);
      if (hubs.some((h) => Math.hypot(p.x - h.x, p.z - h.z) <= h.r + 0.01)) nearHub += 1;
      last = p;
    }
    expect(nearHub / (20 * 600)).toBeGreaterThan(0.5);
  });

  it('repeats exactly for the same seed', () => {
    const a = new Brain(7, DEFAULT_BRAIN, { x: 10, z: 10 });
    const b = new Brain(7, DEFAULT_BRAIN, { x: 10, z: 10 });
    for (let i = 0; i < 1000; i++) expect(a.step(0.05)).toEqual(b.step(0.05));
  });

  it('keeps a crowd on its one stage', () => {
    const brain = new Brain(3, { ...DEFAULT_BRAIN, scenario: 'crowd' }, { x: 128, z: 128 });
    for (let i = 0; i < 20 * 300; i++) {
      const p = brain.step(0.05);
      expect(Math.hypot(p.x - 128, p.z - 128)).toBeLessThanOrEqual(15.01);
    }
  });
});

describe('talking', () => {
  it('talks about a quarter of the time, in bursts of speech-sized Opus frames', () => {
    const talker = new Talker(11);
    let talking = 0;
    let lines = 0;
    for (let i = 0; i < 10 * 3600; i++) {
      if (talker.advance(0.1)) lines += 1;
      if (talker.isTalking) talking += 1;
    }
    expect(talking / (10 * 3600)).toBeGreaterThan(0.15);
    expect(talking / (10 * 3600)).toBeLessThan(0.4);
    expect(lines).toBeGreaterThan(30);
    const frame = talker.frame();
    expect(frame.opus.length).toBeGreaterThanOrEqual(50);
    expect(frame.opus.length).toBeLessThanOrEqual(80);
    for (const v of Object.values(frame.mouth)) expect(v).toBeLessThanOrEqual(15);
  });

  it('starts its first burst within the time asked', () => {
    const talker = new Talker(5, 1);
    let at = 0;
    while (!talker.isTalking && at < 100) {
      talker.advance(0.1);
      at += 1;
    }
    expect(at).toBeLessThanOrEqual(10);
  });
});

describe('the report', () => {
  const config: RunConfig = { transport: 'udp', bots: 2, seconds: 1800, scenario: 'hubs', voice: true, netem: '', isolated: true, serverPort: 7777, machine: {}, startedAt: '2026-10-16T00:00:00Z' };
  const bot = (index: number, lost = ''): BotSummary => ({
    index,
    entity: index + 1,
    state: 'closed',
    lostReason: lost,
    refuseReason: '',
    joinMs: 20,
    joinedMs: 1_800_000,
    down: { snapshot: 9_000_000, voiceBundle: 18_000_000 },
    downMessages: { snapshot: 36_000, roster: 1 },
    up: { pose: 2_000_000 },
    rtt: { n: 1800, mean: 1, p50: 1, p95: 2, p99: 3, max: 5 },
    seenFull: { n: 3600, mean: 20, p50: 20, p95: 30, p99: 31, max: 40 },
    corrections: 0,
    voiceFrames: 90_000,
    chats: 10,
    bad: 0,
  });
  const time = (s: number): string => new Date(Date.parse(config.startedAt) + s * 1000).toISOString();
  const metrics = Array.from({ length: 360 }, (_, i) => ({ event: 'metrics', time: time(5 * (i + 1)), uptimeS: 5 * (i + 1), players: 2, cpuPct: 20, mainThreadPct: 10, memory: { rssMB: 100 }, tickMs: { p99: 2 }, sent: { snapshot: { bytes: 125_000, messages: 1 } }, received: { pose: { bytes: 25_000, messages: 1 } } }));
  const stopped = {
    event: 'stopped',
    summary: {
      uptimeS: 1800,
      peakPlayers: 2,
      tickMs: { n: 36_000, mean: 1, p50: 1, p95: 2, p99: 2.5, max: 6 },
      voiceMs: { n: 90_000, mean: 0.5, p50: 0.4, p95: 0.8, p99: 1, max: 3 },
      encodings: { mean: 3, max: 4 },
      busyCells: { mean: 2, max: 2 },
      joinSnapshotBytes: { max: 900 },
      rosterBytes: { max: 120 },
      memoryWarm: { rssMB: 100, heapUsedMB: 20 },
      memoryEnd: { rssMB: 104, heapUsedMB: 21 },
    },
  };
  const wire = [
    { t: Date.parse(time(0)), counters: { 'from-7777': { packets: 0, bytes: 0 }, 'to-7777': { packets: 0, bytes: 0 } } },
    { t: Date.parse(time(1800)), counters: { 'from-7777': { packets: 1, bytes: 300_000_000 }, 'to-7777': { packets: 1, bytes: 60_000_000 } } },
  ];

  it('computes per-client rates and passes a clean run', () => {
    const r = analyse(config, [{ event: 'ready' }, ...metrics, stopped], [[{ event: 'summary', bots: [bot(0), bot(1)] }]], wire);
    expect(r.downKbps.noVoice.mean).toBeCloseTo(40, 5);
    expect(r.downKbps.withVoice.mean).toBeCloseTo(120, 5);
    expect(r.serverUpMbps.app).toBeCloseTo(0.2, 5);
    expect(r.memory.growthPct).toBeCloseTo(4, 5); // 100 MB at 5 minutes, 104 at the end
    expect(r.memory.trendMBPer10Min).toBeCloseTo(0, 5);
    expect(r.pass.filter((p) => p.ok === false)).toEqual([]);
    expect(markdown(r)).toContain('| server tick p99 at 20 Hz | 2.5 ms | ≤ 15 ms | PASS |');
  });

  it('fails a run that lost a bot or grew its memory', () => {
    const grown = { ...stopped, summary: { ...stopped.summary, memoryEnd: { rssMB: 130, heapUsedMB: 40 } } };
    const r = analyse(config, [...metrics, grown], [[{ event: 'summary', bots: [bot(0), bot(1, 'timeout')] }]], wire);
    expect(r.disconnects).toBe(1);
    expect(r.lostReasons).toEqual({ timeout: 1 });
    expect(Object.fromEntries(r.pass.map((p) => [p.id, p.ok]))).toMatchObject({ 'no-disconnects': false, memory: false, 'tick-p99': true });
  });
});
