// SPDX-License-Identifier: MPL-2.0
// The platform's default clips (Track P's P.05): the body's everyday motions, taken from two CC0
// libraries and converted to VRMA by this converter (the same retargeting as an uploaded emote),
// which kits/animations/ keeps and the client plays on every avatar. Mesh2Motion's human clips
// (Scott Petrovic and the Mesh2Motion contributors) and Quaternius's Universal Animation Library
// (the free standard pack) are pinned by their SHA-256; neither has an in-place turn, so the body
// turns as it did. Each clip must pass P.05's checks on all three standard bodies (checks.ts).
import { PROPORTION_ENDS } from '@flatchat/content';
import type { Body, Clip } from './checks.ts';
import { channelProblems, footSlide, handClearance, loopSeam } from './checks.ts';

export const CLIP_SOURCES = {
  mesh2motion: {
    what: 'Mesh2Motion human clips (static/animations/human-base-animations.glb)',
    url: 'https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/653a9698f5f315523072f1c3ff3496100401317b/static/animations/human-base-animations.glb',
    sha256: '406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c',
  },
  'mesh2motion-addon': {
    what: 'Mesh2Motion human add-on clips (static/animations/human-addon-animations.glb)',
    url: 'https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/653a9698f5f315523072f1c3ff3496100401317b/static/animations/human-addon-animations.glb',
    sha256: 'a0d64d555e0d492026b72d58bf8e16c5e86779295f9093e376dcc001915c2c95',
  },
  quaternius: {
    what: 'Quaternius Universal Animation Library, the standard pack (its Godot GLB)',
    url: 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip',
    sha256: '18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2',
    entry: 'Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb',
  },
} as const;
export type ClipSource = keyof typeof CLIP_SOURCES;

/** What a default clip is for: walking ones have a ground speed the client matches its pace to. */
export type ClipKind = 'stand' | 'walk' | 'air' | 'sit' | 'gesture';

export interface DefaultClip {
  name: string;
  from: ClipSource;
  clip: string;
  kind: ClipKind;
  loop: boolean;
}

/** P.05's fourteen less the turn neither library has. */
export const DEFAULT_CLIPS: readonly DefaultClip[] = [
  { name: 'idle', from: 'mesh2motion', clip: 'Idle_A', kind: 'stand', loop: true },
  { name: 'walk', from: 'mesh2motion', clip: 'Walk', kind: 'walk', loop: true },
  // Quaternius's runs: Mesh2Motion's slide (its jog 2.7 cm a step on the masculine body's longest
  // legs, its sprint up to 6 cm), Quaternius's hold (1.9 cm and 1.6 cm at worst).
  { name: 'jog', from: 'quaternius', clip: 'Jog_Fwd_Loop', kind: 'walk', loop: true },
  { name: 'sprint', from: 'quaternius', clip: 'Sprint_Loop', kind: 'walk', loop: true },
  { name: 'jump-start', from: 'mesh2motion', clip: 'Jump_Start', kind: 'air', loop: false },
  { name: 'jump-air', from: 'mesh2motion', clip: 'Jump_air', kind: 'air', loop: true },
  { name: 'land', from: 'mesh2motion', clip: 'Jump_Land', kind: 'air', loop: false },
  { name: 'fall', from: 'quaternius', clip: 'Jump_Loop', kind: 'air', loop: true },
  { name: 'sit-enter', from: 'mesh2motion', clip: 'Sitting_Enter', kind: 'sit', loop: false },
  { name: 'sit-idle', from: 'mesh2motion', clip: 'Sitting_Idle', kind: 'sit', loop: true },
  { name: 'sit-exit', from: 'mesh2motion', clip: 'Sitting_Exit', kind: 'sit', loop: false },
  { name: 'greeting', from: 'mesh2motion-addon', clip: 'Greeting', kind: 'gesture', loop: false },
  { name: 'dance', from: 'quaternius', clip: 'Dance_Loop', kind: 'gesture', loop: true },
];

/** P.05's lines (rr-014). */
export const SLIDE_MAX = 0.02;
export const SEAM_MAX_DEG = 1;
/** The legs slider's two ends (the client's proportions, S4.10). */
export const LEG_EXTREMES = PROPORTION_ENDS;

/** What a clip measures on the bodies, and what in it breaks P.05's lines. */
export function clipReport(c: DefaultClip, clip: Clip, bodies: ReadonlyArray<readonly [string, Body]>): { problems: string[]; seam: number; slide?: number; clearance?: number; speedPerLeg?: number } {
  const problems = channelProblems(clip);
  const seam = loopSeam(clip);
  if (c.loop && seam > SEAM_MAX_DEG) problems.push(`its loop's seam is ${seam.toFixed(2)}° (${SEAM_MAX_DEG}° at most)`);
  const out: { problems: string[]; seam: number; slide?: number; clearance?: number; speedPerLeg?: number } = { problems, seam };
  if (c.name === 'idle') {
    out.clearance = Math.min(...bodies.map(([, b]) => handClearance(b, clip)));
    if (out.clearance <= 0) problems.push(`a hand goes ${(-out.clearance * 100).toFixed(1)} cm into the torso`);
  }
  if (c.kind === 'walk') {
    // Its ground speed for a metre of leg (the hips' height at rest), which the client scales.
    const perLeg = bodies.map(([, b]) => footSlide(b, clip, 1).speed / (b.rest.get('hips')![1] - b.rest.get('leftToes')![1]));
    out.speedPerLeg = perLeg.reduce((a, v) => a + v, 0) / perLeg.length;
    if (c.name === 'walk' || c.name === 'jog') {
      out.slide = Math.max(...bodies.flatMap(([, b]) => LEG_EXTREMES.map((legs) => footSlide(b, clip, legs).slide)));
      if (out.slide > SLIDE_MAX) problems.push(`a planted foot slides ${(out.slide * 100).toFixed(1)} cm a step (${SLIDE_MAX * 100} cm at most)`);
    }
  }
  return out;
}
