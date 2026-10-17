// SPDX-License-Identifier: MPL-2.0
// Turns one run's records (run.json, server.jsonl, swarm-*.jsonl, wire.jsonl) into its results
// and the pass lines of spike S0.07 (the MVP plan): 30 minutes with no disconnects; the server's
// tick p99 at most 15 ms at 20 Hz; per-client download at most 350 kbps without voice and 750 kbps
// with it; serialisations per tick that follow the busy cells, not the clients; a join snapshot of
// at most 64 KB; the server's upload logged (at most 30 Mbps at 50 bots); memory growth under 10%.
// Pure: it reads parsed records and returns numbers and a Markdown table.
import type { Summary } from '@flatchat/world-server/metrics';
import type { BotSummary } from './bot.ts';

export interface RunConfig {
  transport: 'udp' | 'rtc';
  bots: number;
  seconds: number;
  scenario: string;
  voice: boolean;
  netem: string;
  isolated: boolean;
  serverPort: number;
  machine: Record<string, string | number>;
  startedAt: string;
}

export type Line = Record<string, unknown> & { event?: string };

export interface PassLine {
  id: string;
  what: string;
  value: string;
  limit: string;
  ok: boolean | null;
}

export interface Results {
  config: RunConfig;
  joined: number;
  failed: number;
  refused: number;
  disconnects: number;
  lostReasons: Record<string, number>;
  durationS: number;
  peakPlayers: number;
  tickMs: Summary;
  worstWindowTickP99: number;
  voiceMs: Summary;
  /** Server CPU over the steady windows, percent of one core (all threads), and the main thread's busy share. */
  serverCpuPct: number;
  mainThreadPct: number;
  encodingsPerTick: number;
  busyCellsPerTick: number;
  maxEncodings: number;
  joinSnapshotMaxBytes: number;
  rosterAtJoinMaxBytes: number;
  downKbps: { noVoice: Stat; withVoice: Stat; voiceOnly: Stat };
  upKbps: Stat;
  serverUpMbps: { app: number; wire: number | null };
  serverDownMbps: { app: number; wire: number | null };
  wireOverhead: number | null;
  /** Growth judged from the 5-minute mark (the heap settles in the first minutes); from 2 minutes and the trend shown too. */
  memory: { warmRssMB: number; endRssMB: number; growthPct: number; from2MinPct: number; settledRssMB: number; trendMBPer10Min: number; warmHeapMB: number; endHeapMB: number; heapGrowthPct: number };
  rttMs: { p50: number; p99: number; max: number };
  corrections: number;
  bad: number;
  voiceFramesPerBotSecond: number;
  seenFullMean: number;
  pass: PassLine[];
}

export interface Stat {
  mean: number;
  p95: number;
  max: number;
}

function stat(values: number[]): Stat {
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { mean, p95: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0, max: sorted.at(-1) ?? 0 };
}

const sum = (o: Record<string, number> | undefined): number => Object.values(o ?? {}).reduce((s, v) => s + v, 0);
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

export function analyse(config: RunConfig, server: Line[], swarms: Line[][], wire: Line[]): Results {
  const stopped = server.find((l) => l.event === 'stopped');
  const summary = (stopped?.['summary'] ?? {}) as Record<string, unknown>;
  const metrics = server.filter((l) => l.event === 'metrics');
  const bots: BotSummary[] = swarms.flatMap((lines) => ((lines.find((l) => l.event === 'summary')?.['bots'] ?? []) as BotSummary[]));
  const joined = bots.filter((b) => b.entity !== undefined);
  const lostReasons: Record<string, number> = {};
  for (const b of joined) if (b.lostReason) lostReasons[b.lostReason] = (lostReasons[b.lostReason] ?? 0) + 1;

  // Per-client rates over each bot's time in the world.
  const kbps = (bytes: number, ms: number): number => (ms > 0 ? (bytes * 8) / ms : 0);
  const withVoice = joined.map((b) => kbps(sum(b.down), b.joinedMs));
  const voiceOnly = joined.map((b) => kbps(b.down['voiceBundle'] ?? 0, b.joinedMs));
  const noVoice = withVoice.map((v, i) => v - (voiceOnly[i] ?? 0));
  const up = joined.map((b) => kbps(sum(b.up), b.joinedMs));

  // Steady state: the metrics windows with every bot that joined still in the world.
  const peak = Math.max(0, ...metrics.map((m) => Number(m['players'] ?? 0)));
  const steady = metrics.filter((m) => Number(m['players'] ?? 0) >= peak && peak > 0);
  const windowBytes = (m: Line, key: 'sent' | 'received'): number => sum(Object.fromEntries(Object.entries((m[key] ?? {}) as Record<string, { bytes: number }>).map(([k, v]) => [k, v.bytes])));
  const steadySeconds = steady.length * 5;
  const appUp = steadySeconds > 0 ? (steady.reduce((s, m) => s + windowBytes(m, 'sent'), 0) * 8) / steadySeconds / 1e6 : 0;
  const appDown = steadySeconds > 0 ? (steady.reduce((s, m) => s + windowBytes(m, 'received'), 0) * 8) / steadySeconds / 1e6 : 0;

  // Wire bytes over the same steady span, from the nftables counters.
  let wireUp: number | null = null;
  let wireDown: number | null = null;
  const firstSteady = steady[0];
  const lastSteady = steady.at(-1);
  if (wire.length > 1 && firstSteady && lastSteady) {
    const t0 = Date.parse(String(firstSteady['time'])) - 5000;
    const t1 = Date.parse(String(lastSteady['time']));
    const near = (t: number): Line | undefined => wire.reduce<Line | undefined>((best, l) => (best === undefined || Math.abs(Number(l['t']) - t) < Math.abs(Number(best['t']) - t) ? l : best), undefined);
    const a = near(t0);
    const b = near(t1);
    const port = config.serverPort;
    const bytes = (l: Line | undefined, name: string): number => Number(((l?.['counters'] ?? {}) as Record<string, { bytes: number }>)[name]?.bytes ?? 0);
    const seconds = (Number(b?.['t']) - Number(a?.['t'])) / 1000;
    if (a && b && seconds > 0) {
      wireUp = ((bytes(b, `from-${port}`) - bytes(a, `from-${port}`)) * 8) / seconds / 1e6;
      wireDown = ((bytes(b, `to-${port}`) - bytes(a, `to-${port}`)) * 8) / seconds / 1e6;
    }
  }

  const tickMs = (summary['tickMs'] ?? { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }) as Summary;
  const voiceMs = (summary['voiceMs'] ?? { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }) as Summary;
  const encodings = (summary['encodings'] ?? { mean: 0, max: 0 }) as Summary;
  const busy = (summary['busyCells'] ?? { mean: 0 }) as Summary;
  const joinSnap = (summary['joinSnapshotBytes'] ?? { max: 0 }) as Summary;
  const warm = (summary['memoryWarm'] ?? summary['memoryStart'] ?? {}) as Record<string, number>;
  const end = (summary['memoryEnd'] ?? {}) as Record<string, number>;
  const growth = (a: number | undefined, b: number | undefined): number => (a && b ? ((b - a) / a) * 100 : 0);
  // RSS from the metrics lines: the first one after 5 minutes, and the least-squares trend from there.
  const rssAt = metrics.map((m) => ({ s: Number(m['uptimeS'] ?? 0), rss: Number((m['memory'] as Record<string, number> | undefined)?.['rssMB'] ?? 0) }));
  const settledRows = rssAt.filter((x) => x.s >= 300);
  const settled = settledRows[0]?.rss ?? 0;
  let trend = 0;
  if (settledRows.length > 2) {
    const n = settledRows.length;
    const ms = settledRows.reduce((a, x) => a + x.s, 0) / n;
    const mr = settledRows.reduce((a, x) => a + x.rss, 0) / n;
    const cov = settledRows.reduce((a, x) => a + (x.s - ms) * (x.rss - mr), 0);
    const varS = settledRows.reduce((a, x) => a + (x.s - ms) ** 2, 0);
    trend = varS > 0 ? (cov / varS) * 600 : 0;
  }
  const rtts = joined.map((b) => b.rtt);
  const roster = (summary['rosterBytes'] ?? { max: 0 }) as Summary;

  const r: Omit<Results, 'pass'> = {
    config,
    joined: joined.length,
    failed: bots.filter((b) => b.state === 'failed').length,
    refused: bots.filter((b) => b.state === 'refused').length,
    disconnects: joined.filter((b) => b.lostReason !== '').length,
    lostReasons,
    durationS: Number(summary['uptimeS'] ?? 0),
    peakPlayers: Number(summary['peakPlayers'] ?? peak),
    tickMs,
    worstWindowTickP99: Math.max(0, ...metrics.map((m) => Number((m['tickMs'] as Summary | undefined)?.p99 ?? 0))),
    voiceMs,
    serverCpuPct: steady.length ? steady.reduce((s, m) => s + Number(m['cpuPct'] ?? 0), 0) / steady.length : 0,
    mainThreadPct: steady.length ? steady.reduce((s, m) => s + Number(m['mainThreadPct'] ?? 0), 0) / steady.length : 0,
    encodingsPerTick: encodings.mean,
    busyCellsPerTick: busy.mean,
    maxEncodings: encodings.max,
    joinSnapshotMaxBytes: joinSnap.max,
    rosterAtJoinMaxBytes: roster.max,
    downKbps: { noVoice: stat(noVoice), withVoice: stat(withVoice), voiceOnly: stat(voiceOnly) },
    upKbps: stat(up),
    serverUpMbps: { app: appUp, wire: wireUp },
    serverDownMbps: { app: appDown, wire: wireDown },
    wireOverhead: wireUp !== null && appUp > 0 ? wireUp / appUp : null,
    memory: {
      warmRssMB: warm['rssMB'] ?? 0,
      endRssMB: end['rssMB'] ?? 0,
      growthPct: settled ? growth(settled, end['rssMB']) : growth(warm['rssMB'], end['rssMB']),
      from2MinPct: growth(warm['rssMB'], end['rssMB']),
      settledRssMB: settled,
      trendMBPer10Min: trend,
      warmHeapMB: warm['heapUsedMB'] ?? 0,
      endHeapMB: end['heapUsedMB'] ?? 0,
      heapGrowthPct: growth(warm['heapUsedMB'], end['heapUsedMB']),
    },
    rttMs: { p50: stat(rtts.map((x) => x.p50)).mean, p99: stat(rtts.map((x) => x.p99)).p95, max: Math.max(0, ...rtts.map((x) => x.max)) },
    corrections: joined.reduce((s, b) => s + b.corrections, 0),
    bad: joined.reduce((s, b) => s + b.bad, 0),
    voiceFramesPerBotSecond: stat(joined.map((b) => (b.joinedMs > 0 ? (b.voiceFrames * 1000) / b.joinedMs : 0))).mean,
    seenFullMean: stat(joined.map((b) => b.seenFull.mean)).mean,
  };
  return { ...r, pass: passLines(r) };
}

export function passLines(r: Omit<Results, 'pass'>): PassLine[] {
  const c = r.config;
  const minutes = c.seconds / 60;
  const lines: PassLine[] = [
    {
      id: 'no-disconnects',
      what: `${round(minutes, 0)} minutes, every bot joined, none disconnected`,
      value: `${r.joined} of ${c.bots} joined, ${r.disconnects} lost`,
      limit: '30 min, 0 lost',
      ok: minutes >= 30 ? r.joined === c.bots && r.disconnects === 0 : null,
    },
    { id: 'tick-p99', what: 'server tick p99 at 20 Hz', value: `${round(r.tickMs.p99, 2)} ms`, limit: '≤ 15 ms', ok: r.tickMs.p99 <= 15 },
    { id: 'down-state', what: 'per-client download without voice (p95 of clients)', value: `${round(r.downKbps.noVoice.p95)} kbps`, limit: '≤ 350 kbps', ok: r.downKbps.noVoice.p95 <= 350 },
    { id: 'down-voice', what: 'per-client download with voice (p95 of clients)', value: `${round(r.downKbps.withVoice.p95)} kbps`, limit: '≤ 750 kbps', ok: r.downKbps.withVoice.p95 <= 750 },
    {
      id: 'serialisations',
      what: 'cell encodings per tick against busy cells and clients',
      value: `${round(r.encodingsPerTick)} for ${round(r.busyCellsPerTick)} busy cells and ${r.peakPlayers} clients`,
      limit: '≤ 2 per busy cell, independent of clients',
      ok: r.busyCellsPerTick > 0 ? r.encodingsPerTick <= 2 * r.busyCellsPerTick + 0.5 : null,
    },
    {
      id: 'join-snapshot',
      what: 'largest join snapshot (the full roster beside it)',
      value: `${round(r.joinSnapshotMaxBytes / 1024, 2)} KB (roster ${round(r.rosterAtJoinMaxBytes / 1024, 2)} KB)`,
      limit: '≤ 64 KB',
      ok: r.joinSnapshotMaxBytes <= 65_536,
    },
    {
      id: 'server-upload',
      what: `server upload at ${c.bots} bots`,
      value: `${round(r.serverUpMbps.wire ?? r.serverUpMbps.app, 2)} Mbps ${r.serverUpMbps.wire !== null ? 'on the wire' : '(application bytes)'}`,
      limit: c.bots === 50 ? '≤ 30 Mbps at 50' : 'logged',
      ok: c.bots === 50 ? (r.serverUpMbps.wire ?? r.serverUpMbps.app) <= 30 : null,
    },
    {
      id: 'memory',
      what: 'server memory growth once settled (RSS, 5 minutes to the end)',
      value: `${round(r.memory.growthPct)} % (${r.memory.settledRssMB} → ${r.memory.endRssMB} MB; trend ${round(r.memory.trendMBPer10Min, 2)} MB per 10 min)`,
      limit: '< 10 %',
      ok: r.durationS >= 600 ? r.memory.growthPct < 10 : null,
    },
  ];
  return lines;
}

export function markdown(r: Results): string {
  const c = r.config;
  const mark = (ok: boolean | null): string => (ok === null ? '—' : ok ? 'PASS' : 'FAIL');
  const rows = r.pass.map((p) => `| ${p.what} | ${p.value} | ${p.limit} | ${mark(p.ok)} |`);
  const k = (s: Stat): string => `${round(s.mean)} mean, ${round(s.p95)} p95, ${round(s.max)} max`;
  return [
    `### ${c.transport === 'rtc' ? 'WebRTC data channels' : 'Raw UDP'} · ${c.bots} bots · ${round(c.seconds / 60, 1)} min · ${c.scenario}${c.voice ? '' : ' · no voice'}${c.netem ? ` · netem ${c.netem}` : ''}`,
    '',
    `Started ${c.startedAt}; ${c.isolated ? 'an isolated network namespace with wire counters' : 'plain loopback, application bytes only'}.`,
    '',
    '| Pass line | Measured | Limit | Result |',
    '|---|---|---|---|',
    ...rows,
    '',
    '| Detail | Value |',
    '|---|---|',
    `| Server tick | p50 ${round(r.tickMs.p50, 2)} ms, p99 ${round(r.tickMs.p99, 2)} ms, max ${round(r.tickMs.max, 1)} ms (worst 5 s window p99 ${round(r.worstWindowTickP99, 2)} ms) |`,
    `| Server CPU (steady) | ${round(r.serverCpuPct)} % of one core, all threads; main thread busy ${round(r.mainThreadPct)} % |`,
    `| Voice step (every 20 ms) | p50 ${round(r.voiceMs.p50, 2)} ms, p99 ${round(r.voiceMs.p99, 2)} ms, max ${round(r.voiceMs.max, 1)} ms |`,
    `| Download per client, kbps | state ${k(r.downKbps.noVoice)}; voice ${k(r.downKbps.voiceOnly)}; total ${k(r.downKbps.withVoice)} |`,
    `| Upload per client, kbps | ${k(r.upKbps)} |`,
    `| Server upload / download | ${round(r.serverUpMbps.app, 2)} / ${round(r.serverDownMbps.app, 2)} Mbps of messages${r.serverUpMbps.wire !== null ? `; ${round(r.serverUpMbps.wire, 2)} / ${round(r.serverDownMbps.wire ?? 0, 2)} Mbps on the wire (×${round(r.wireOverhead ?? 0, 2)})` : ''} |`,
    `| Round trip (ping) | p50 ${round(r.rttMs.p50, 1)} ms, p99 of clients ${round(r.rttMs.p99, 1)} ms, max ${round(r.rttMs.max, 1)} ms |`,
    `| Avatars in full per tick, per client | ${round(r.seenFullMean, 1)} |`,
    `| Voice frames heard per client per second | ${round(r.voiceFramesPerBotSecond, 1)} |`,
    `| Server memory (RSS, heap) | at 2 min ${r.memory.warmRssMB} MB, at 5 min ${r.memory.settledRssMB} MB, at the end ${r.memory.endRssMB} MB (${round(r.memory.from2MinPct)} % from 2 min, ${round(r.memory.growthPct)} % from 5 min; trend after 5 min ${round(r.memory.trendMBPer10Min, 2)} MB per 10 min); heap ${r.memory.warmHeapMB} → ${r.memory.endHeapMB} MB |`,
    `| Joins failed / refused / lost | ${r.failed} / ${r.refused} / ${r.disconnects}${Object.keys(r.lostReasons).length ? ` (${Object.entries(r.lostReasons).map(([k2, v]) => `${k2}: ${v}`).join(', ')})` : ''} |`,
    `| Corrections / malformed messages | ${r.corrections} / ${r.bad} |`,
    '',
  ].join('\n');
}
