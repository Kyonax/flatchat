// SPDX-License-Identifier: MPL-2.0
// Spike S0.09's pass lines (the MVP plan's S0.09), judged from a crowd report and the memory the
// main process sampled. On the compute-only stand-in the frame-time lines tighten by its headroom
// (OQ-24: 1.5 until a tester's real laptop recalibrates it), so 33.3 ms becomes 22.2 ms.

export interface PassLine {
  what: string;
  limit: string;
  value: string;
  ok: boolean;
}

export interface CrowdForPass {
  summary?: { p95Ms?: number; maxMs?: number; frames?: number };
  framesOver100?: number;
  tiers?: { full?: { count?: number } };
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function crowdPass(report: CrowdForPass, memoryPeakMB: number, headroom = 1): PassLine[] {
  const p95 = report.summary?.p95Ms ?? Number.POSITIVE_INFINITY;
  const worst = report.summary?.maxMs ?? Number.POSITIVE_INFINITY;
  const full = report.tiers?.full?.count ?? 0;
  const p95Limit = 33.3 / headroom;
  const spikeLimit = 100 / headroom;
  const measured = (report.summary?.frames ?? 0) > 0;
  return [
    { what: 'frame time p95 over the measured run', limit: `≤ ${round(p95Limit)} ms`, value: `${round(p95)} ms`, ok: measured && p95 <= p95Limit },
    { what: 'the worst frame after the warm-up, avatar loads included', limit: `≤ ${round(spikeLimit)} ms`, value: `${round(worst)} ms`, ok: measured && worst <= spikeLimit },
    { what: 'avatars drawn in full', limit: '≥ 8', value: String(full), ok: full >= 8 },
    { what: 'memory of every FlatChat process together (resident)', limit: '≤ 2,048 MB', value: `${Math.round(memoryPeakMB)} MB`, ok: memoryPeakMB > 0 && memoryPeakMB <= 2048 },
  ];
}
