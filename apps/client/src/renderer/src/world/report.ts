// SPDX-License-Identifier: MPL-2.0
// A report from inside a world (S3.02): what the player chose, the evidence the session holds (the
// chat excerpt, the world and instance, who was near, the times) and, while the player keeps it
// ticked, the voice clip of what they heard. The only place that takes the clip (trap T20): the
// recorder's audio leaves the client only inside a report.
import type { ClipRecorder } from '../voice/clip';

export const REPORT_CATEGORIES = ['csam', 'grooming', 'threats', 'intimate', 'underage', 'harassment', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface ReportDraft {
  category: ReportCategory;
  /** A player (by account) or the world itself; `name` is what the player saw. */
  target: { kind: 'player' | 'world'; account?: string; world?: string; name: string };
  text: string;
  withClip: boolean;
}

export interface ReportEvidence {
  world: { id: string; name: string; instance: string };
  chat: Array<{ from: string; text: string; at: number }>;
  near: Array<{ account: string; name: string; distance: number }>;
  times: { joined: number; reported: number; clipFrom?: number; clipTo?: number };
  speech?: Array<{ account: string; name: string; from: number; to: number }>;
}

export interface ReportPayload {
  category: ReportCategory;
  target: { kind: 'player' | 'world'; account?: string; world?: string; ref: string };
  text: string;
  evidence: ReportEvidence;
  /** The WAV clip, only when the player kept it ticked and something was heard. */
  clip?: Uint8Array;
}

/** The report to send. `now` is on the recorder's clock (performance.now()); `wall` turns a time
 *  on it into the wall clock; `who` names a speaker by its entity. */
export function buildReport(
  draft: ReportDraft,
  evidence: ReportEvidence,
  recorder: ClipRecorder | undefined,
  now: number,
  wall: (t: number) => number,
  who: (entity: number) => { account: string; name: string } | undefined,
): ReportPayload {
  const clip = draft.withClip ? recorder?.takeClip(now) : undefined;
  const speech = clip?.speech.flatMap((s) => {
    const p = who(s.entity);
    return p ? [{ account: p.account, name: p.name, from: s.from, to: s.to }] : [];
  });
  return {
    category: draft.category,
    target: { kind: draft.target.kind, ...(draft.target.account ? { account: draft.target.account } : {}), ...(draft.target.world ? { world: draft.target.world } : {}), ref: draft.target.name.slice(0, 300) },
    text: draft.text.slice(0, 2000),
    evidence: clip ? { ...evidence, speech: speech ?? [], times: { ...evidence.times, clipFrom: Math.round(wall(clip.from)), clipTo: Math.round(wall(clip.to)) } } : evidence,
    ...(clip ? { clip: clip.wav } : {}),
  };
}
