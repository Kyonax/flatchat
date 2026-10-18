// SPDX-License-Identifier: MPL-2.0
// The default clips (Track P's P.05): every clip kits/animations/clips.json lists is the file it
// names, a VRMA the client takes, and, posed on each of the three standard bodies, passes P.05's
// lines again: no scale tracks and translation only on the hips; a loop's seam within 1°; no hand
// inside the torso in idle; a planted foot sliding at most 2 cm a step on walk and jog at both ends
// of the legs slider; and what clips.json says it measured, it measures. The libraries' rigs read:
// Unreal's names (lowerarm_r, ring_01_l, which start with a letter that is no side) and Rigify's
// (DEF-forearm.L); a library's clip is taken by its name, and a name it lacks is refused.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_KITS, checkAnimationFile, readGltf } from '@flatchat/content';
import { beforeAll, describe, expect, it } from 'vitest';
import { readAvatarLevel } from '../src/avatar/convert.ts';
import { humanBoneOf } from '../src/avatar/humanoid.ts';
import { type Body, bodyOf, footSlide, readClip } from '../src/animation/checks.ts';
import { AnimationError, convertAnimation } from '../src/animation/convert.ts';
import { clipReport, DEFAULT_CLIPS, LEG_EXTREMES, SLIDE_MAX } from '../src/animation/defaults.ts';
import { sampleClip } from '../src/animation/samples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(ROOT, 'kits', 'animations');
interface Listed {
  name: string;
  file: string;
  sha256: string;
  bytes: number;
  loop: boolean;
  seam: number;
  slide?: number;
  speedPerLeg?: number;
  clearance?: number;
}
const LISTED = (JSON.parse(readFileSync(join(DIR, 'clips.json'), 'utf8')) as { clips: Listed[] }).clips;
const bodies: Array<readonly [string, Body]> = [];
beforeAll(async () => {
  for (const b of BODY_KITS) {
    const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', b, `${b}.vrm`))));
    bodies.push([b, bodyOf(doc, data)]);
  }
}, 60_000);

describe('the default clips', () => {
  it('are the files clips.json names, each a VRMA the client takes', () => {
    expect(LISTED.map((c) => c.name)).toEqual(DEFAULT_CLIPS.map((c) => c.name));
    for (const c of LISTED) {
      const bytes = new Uint8Array(readFileSync(join(DIR, c.file)));
      expect(createHash('sha256').update(bytes).digest('hex'), c.name).toBe(c.sha256);
      expect(bytes.length).toBe(c.bytes);
      expect(() => checkAnimationFile(readGltf(bytes, 'animation.glb').json as Record<string, unknown>)).not.toThrow();
    }
  });

  it('pass P.05’s lines on all three bodies, measuring what clips.json says', async () => {
    for (const c of DEFAULT_CLIPS) {
      const listed = LISTED.find((l) => l.name === c.name)!;
      const report = clipReport(c, await readClip(new Uint8Array(readFileSync(join(DIR, listed.file)))), bodies);
      expect(report.problems, c.name).toEqual([]);
      expect(Number(report.seam.toFixed(2)), c.name).toBe(listed.seam);
      if (report.slide !== undefined) expect(Number(report.slide.toFixed(4)), c.name).toBe(listed.slide);
      if (report.speedPerLeg !== undefined) expect(Number(report.speedPerLeg.toFixed(4)), c.name).toBe(listed.speedPerLeg);
      if (report.clearance !== undefined) expect(Number(report.clearance.toFixed(4)), c.name).toBe(listed.clearance);
    }
  }, 120_000);

  it('walk and jog with feet that hold, at both ends of the legs slider, on every body', async () => {
    for (const name of ['walk', 'jog']) {
      const clip = await readClip(new Uint8Array(readFileSync(join(DIR, `${name}.vrma`))));
      for (const [b, body] of bodies) {
        for (const legs of LEG_EXTREMES) {
          const f = footSlide(body, clip, legs);
          expect(f.slide, `${name} on ${b} at ${legs}`).toBeLessThanOrEqual(SLIDE_MAX);
          expect(f.steps, `${name} on ${b} at ${legs}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  }, 60_000);
});

describe('a library', () => {
  it('rig reads with Unreal’s names and Rigify’s', () => {
    expect(humanBoneOf('lowerarm_r')).toBe('rightLowerArm');
    expect(humanBoneOf('lowerarm_l')).toBe('leftLowerArm');
    expect(humanBoneOf('ring_01_l')).toEqual({ side: 'left', finger: 'Ring', joint: 1 });
    expect(humanBoneOf('DEF-forearm.L')).toBe('leftLowerArm');
    expect(humanBoneOf('mixamorig:LeftForeArm')).toBe('leftLowerArm');
    expect(humanBoneOf('head_leaf')).toBeUndefined();
  });

  it('gives the clip named, and refuses a name it lacks', async () => {
    const bytes = await sampleClip();
    expect((await convertAnimation(bytes, { clip: 'Wave' })).manifest.duration).toBe(2);
    await expect(convertAnimation(bytes, { clip: 'Bow' })).rejects.toThrow(AnimationError);
    await expect(convertAnimation(bytes, { clip: 'Bow' })).rejects.toMatchObject({ problems: ['no clip named “Bow” among 1'] });
  });
});
