// SPDX-License-Identifier: MPL-2.0
// A sound's mouth track (S5.07, rr-013): Rhubarb Lip Sync's cues (its JSON: mouthCues, each a
// start, an end and a shape A to H or X) as weights of VRM's five mouth expressions over time,
// which the VRMA carries and three-vrm-animation plays with the dance. Each shape holds over its
// cue and blends into the next over BLEND seconds, as a mouth moves.
import { RHUBARB_SHAPES, type Viseme, VISEMES } from '@flatchat/content';

export interface MouthCue {
  start: number;
  end: number;
  value: string;
}

export interface MouthTrack {
  /** Key times, seconds. */
  times: number[];
  /** Per viseme, its weight at each key time. */
  weights: Record<Viseme, number[]>;
}

const BLEND = 0.04;

/** Rhubarb's JSON, checked: at most `seconds` long, shapes it knows, in order. */
export function readCues(json: unknown, seconds: number): MouthCue[] {
  const cues = (json as { mouthCues?: unknown })?.mouthCues;
  if (!Array.isArray(cues) || cues.length > 20_000) throw new Error('not Rhubarb mouth cues');
  let last = 0;
  return cues.map((c) => {
    const cue = c as Record<string, unknown>;
    const start = Number(cue['start']);
    const end = Number(cue['end']);
    const value = String(cue['value']);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < last - 1e-6 || end < start || end > seconds + 1 || !(value in RHUBARB_SHAPES)) throw new Error('Rhubarb mouth cues out of order or unknown');
    last = end;
    return { start, end, value };
  });
}

export function mouthTrack(cues: readonly MouthCue[]): MouthTrack {
  const times: number[] = [];
  const weights = Object.fromEntries(VISEMES.map((v) => [v, [] as number[]])) as Record<Viseme, number[]>;
  const key = (t: number, shape: string): void => {
    const at = Math.round(t * 1000) / 1000;
    if (times.length > 0 && at <= times[times.length - 1]!) return;
    times.push(at);
    for (const v of VISEMES) weights[v].push(RHUBARB_SHAPES[shape]?.[v] ?? 0);
  };
  for (const c of cues) {
    // Reach the shape a moment after the cue starts; hold it until it ends.
    key(Math.min(c.start + BLEND, c.end), c.value);
    key(c.end, c.value);
  }
  if (times.length === 0 || times[0]! > 0) {
    times.unshift(0);
    for (const v of VISEMES) weights[v].unshift(0);
  }
  return { times, weights };
}
