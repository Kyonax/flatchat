// SPDX-License-Identifier: MPL-2.0
// How a voice changes with distance (the plan's VOICE, DR-10): full up to 1 m, then quieter and
// darker until it is silent at the voice range (25 m by default, the same range the world server
// forwards within). The curve falls smoothly to zero, so a voice fades out instead of stopping at
// the edge. Pure, so the player's audio graph and the tests share it.

export const VOICE_RANGE_M = 25;
const NEAR_M = 1;

/** Gain 0…1 for a speaker `d` metres away. */
export function voiceGain(d: number, range = VOICE_RANGE_M): number {
  if (!(d > NEAR_M)) return 1;
  if (d >= range) return 0;
  const x = (d - NEAR_M) / (range - NEAR_M);
  return (1 - x) * (1 - x);
}

/** The low-pass cutoff for a speaker `d` metres away: 18 kHz near, 2.5 kHz at the range. */
export function voiceCutoffHz(d: number, range = VOICE_RANGE_M): number {
  const x = Math.min(1, Math.max(0, (d - NEAR_M) / (range - NEAR_M)));
  return 18_000 * Math.pow(2_500 / 18_000, x);
}

/** Earmuffs (S3.08): voices beyond this many metres drop to EARMUFF_GAIN. */
export const EARMUFF_M = 2.5;
export const EARMUFF_GAIN = 0.15;

/** How loud one speaker plays: its distance within its range (the world's, from each frame), the
 *  world's gain for it (a stage), this player's volume for that person, and earmuffs. */
export function speakerLevel(d: number, range: number, worldGain: number, volume: number, earmuffs: boolean): number {
  return voiceGain(d, range) * worldGain * volume * (earmuffs && d > EARMUFF_M ? EARMUFF_GAIN : 1);
}
