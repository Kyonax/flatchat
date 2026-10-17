// SPDX-License-Identifier: MPL-2.0
// The reporter's voice clip (S3.02, OQ-18): the recorder keeps only the last seconds, mixes the
// speakers it heard into one WAV, says who spoke when, and a report takes it only when asked.
import { describe, expect, it } from 'vitest';
import { buildReport, type ReportDraft, type ReportEvidence } from '../src/renderer/src/world/report';
import { CLIP_RATE, CLIP_SECONDS, ClipRecorder } from '../src/renderer/src/voice/clip';

const frame = (value: number): Float32Array => new Float32Array(960).fill(value);

describe('the clip recorder', () => {
  it('keeps the last seconds only, and mixes what it heard into one 16 kHz WAV', () => {
    const r = new ClipRecorder();
    // 30 s of one speaker, then two speakers at once for the last second.
    for (let t = 0; t < 30_000; t += 20) r.add(7, t, frame(0.1));
    for (let t = 29_000; t < 30_000; t += 20) r.add(9, t, frame(0.2));
    expect(r.frames).toBeLessThanOrEqual((CLIP_SECONDS * 1000) / 20 + 50 + 1);
    const clip = r.takeClip(30_000)!;
    const v = new DataView(clip.wav.buffer, clip.wav.byteOffset, clip.wav.byteLength);
    expect(new TextDecoder().decode(clip.wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(CLIP_RATE);
    expect(v.getUint32(40, true)).toBe(CLIP_SECONDS * CLIP_RATE * 2);
    // Early in the clip one speaker; in its last second both, summed.
    const at = (ms: number): number => v.getInt16(44 + Math.round(ms * 16) * 2, true);
    expect(at(1000)).toBe(Math.round(0.1 * 32767));
    expect(at(14_500)).toBe(Math.round(0.1 * 32767) + Math.round(0.2 * 32767));
    expect(clip.speech).toEqual([
      { entity: 7, from: 0, to: 15_000 },
      { entity: 9, from: 14_000, to: 15_000 },
    ]);
  });

  it('gives nothing when nothing was heard, and forgets on clear', () => {
    const r = new ClipRecorder();
    expect(r.takeClip(1000)).toBeUndefined();
    r.add(1, 0, frame(0.5));
    r.clear();
    expect(r.takeClip(10)).toBeUndefined();
  });
});

describe('a report', () => {
  const evidence: ReportEvidence = { world: { id: 'w', name: 'Plaza', instance: 'relay' }, chat: [], near: [], times: { joined: 1, reported: 2 } };
  const draft = (withClip: boolean): ReportDraft => ({ category: 'harassment', target: { kind: 'player', account: 'a', name: 'Bo' }, text: 'mean', withClip });

  it('carries the clip, with who spoke and when, only while the player keeps it', () => {
    const r = new ClipRecorder();
    for (let t = 0; t < 2000; t += 20) r.add(4, t, frame(0.3));
    const who = (e: number) => (e === 4 ? { account: 'acc-4', name: 'Bo' } : undefined);
    const without = buildReport(draft(false), evidence, r, 2000, (t) => 1_000_000 + t, who);
    expect(without.clip).toBeUndefined();
    expect(without.evidence.speech).toBeUndefined();
    const withIt = buildReport(draft(true), evidence, r, 2000, (t) => 1_000_000 + t, who);
    expect(withIt.clip?.length).toBe(44 + CLIP_SECONDS * CLIP_RATE * 2);
    expect(withIt.evidence.speech).toEqual([{ account: 'acc-4', name: 'Bo', from: 13_000, to: 15_000 }]);
    expect(withIt.evidence.times).toMatchObject({ clipFrom: 1_000_000 + 2000 - CLIP_SECONDS * 1000, clipTo: 1_002_000 });
  });
});
