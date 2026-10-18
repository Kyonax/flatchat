// SPDX-License-Identifier: MPL-2.0
// The default clips in the client (Track P's P.05): every clip reads from the files the client
// carries, as long and as looping as clips.json says; the angles turn back into the same rotation
// in three.js; a pose stays finite and within a body's reach (no joint past a half turn, knees bent
// one way only); the gait comes from the speed and the stance; walk, jog and sprint keep pace with
// the ground for the legs that carry them, within their limits; sitting down sinks the body into
// the seat over sit-enter and holds it there, and getting up raises it; a landing plays once into
// idle; and a change of gait cross-fades.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import clips from '../../../kits/animations/clips.json';
import { defaultClips, eulerXYZ, type Quat, rotationAt } from '../src/renderer/src/world/clips';
import { FADE_S, gaitFor, JOG_FROM, Motion, paceOf, RATE_MAX, RATE_MIN, SPRINT_FROM, WALK_FROM } from '../src/renderer/src/world/motion';

const library = defaultClips();
const run = (m: Motion, seconds: number, speed: number, stance: string, legs = 0.9): ReturnType<Motion['update']> => {
  let p = m.update(0, speed, stance, legs);
  for (let t = 0; t < seconds; t += 1 / 60) p = m.update(1 / 60, speed, stance, legs);
  return p;
};

describe('the default clips', () => {
  it('read from the files the client carries, as clips.json lists them', () => {
    expect([...library.keys()]).toEqual(clips.clips.map((c) => c.name));
    for (const c of clips.clips) {
      const clip = library.get(c.name)!;
      expect(clip.duration, c.name).toBeCloseTo(c.seconds, 2);
      expect(clip.loop).toBe(c.loop);
      expect(clip.rotations.size, c.name).toBeGreaterThan(20);
      const q = rotationAt(clip, 'hips', clip.duration / 2, [0, 0, 0, 1])!;
      expect(Math.hypot(...q), c.name).toBeCloseTo(1, 3);
    }
    expect(library.get('walk')!.speedPerLeg).toBeGreaterThan(0);
  });

  it('turn into angles three.js turns back into the same rotation', () => {
    const q = new THREE.Quaternion();
    for (const name of ['walk', 'sit-idle', 'greeting']) {
      const clip = library.get(name)!;
      for (const bone of clip.rotations.keys()) {
        const r = rotationAt(clip, bone, 0.4, [0, 0, 0, 1]) as Quat;
        q.setFromEuler(new THREE.Euler(...eulerXYZ(r), 'XYZ'));
        // The keys are 16-bit: unit length to a hundred-thousandth.
        expect(Math.abs(q.x * r[0] + q.y * r[1] + q.z * r[2] + q.w * r[3]), `${name} ${bone}`).toBeCloseTo(1, 4);
      }
    }
  });

  it('keep every limb within reach, through each gait', () => {
    for (const [speed, stance] of [[0, 'standing'], [1.2, 'standing'], [4, 'standing'], [7, 'standing'], [0, 'jumping'], [0, 'falling'], [0, 'sitting']] as const) {
      const m = new Motion();
      for (let k = 0; k < 120; k++) {
        const p = m.update(1 / 30, speed, stance, 0.9);
        for (const [bone, angles] of Object.entries(p.bones)) {
          for (const a of angles) {
            expect(Number.isFinite(a), `${stance} ${speed} ${bone}`).toBe(true);
            expect(Math.abs(a), `${stance} ${speed} ${bone}`).toBeLessThanOrEqual(Math.PI + 1e-6);
          }
          // A knee bends one way only.
          if (bone.endsWith('LowerLeg')) expect(angles[0], `${stance} ${speed} ${bone}`).toBeGreaterThan(-0.15);
        }
        expect(Math.abs(p.bob)).toBeLessThan(0.5);
      }
    }
  });
});

describe('a body', () => {
  it('takes its gait from the speed and the stance', () => {
    expect(gaitFor(0, 'standing')).toBe('idle');
    expect(gaitFor(WALK_FROM, 'standing')).toBe('walk');
    expect(gaitFor(JOG_FROM, 'standing')).toBe('jog');
    expect(gaitFor(SPRINT_FROM, 'standing')).toBe('sprint');
    expect(gaitFor(3, 'sitting')).toBe('sit');
    expect(gaitFor(1, 'jumping')).toBe('air');
    expect(gaitFor(0, 'flying')).toBe('air');
    expect(gaitFor(0, 'falling')).toBe('fall');
  });

  it('keeps pace with the ground for its legs, within the limits', () => {
    const walk = library.get('walk')!;
    expect(paceOf(walk, 1.2, 0.9)).toBeCloseTo(1.2 / (walk.speedPerLeg * 0.9), 6);
    expect(paceOf(walk, 1.2, 1.1)).toBeLessThan(paceOf(walk, 1.2, 0.9));
    expect(paceOf(walk, 0.01, 0.9)).toBe(RATE_MIN);
    expect(paceOf(walk, 50, 0.9)).toBe(RATE_MAX);
    expect(paceOf(library.get('idle')!, 3, 0.9)).toBe(1);
  });

  it('sits down into the seat, stays, and gets up', () => {
    const m = new Motion();
    run(m, 0.5, 0, 'standing');
    const enter = library.get('sit-enter')!.duration;
    const half = run(m, enter / 2, 0, 'sitting');
    expect(half.gait).toBe('sit');
    expect(half.seated).toBeGreaterThan(0.3);
    expect(half.seated).toBeLessThan(0.7);
    expect(run(m, enter + 1, 0, 'sitting').seated).toBe(1);
    const exit = library.get('sit-exit')!.duration;
    const rising = run(m, exit / 2, 0, 'standing');
    expect(rising.seated).toBeGreaterThan(0.3);
    expect(rising.seated).toBeLessThan(0.7);
    expect(run(m, exit + 1, 0, 'standing').seated).toBe(0);
  });

  it('lands once into idle, and cross-fades a change of gait', () => {
    const m = new Motion();
    run(m, 1, 0, 'jumping');
    expect(run(m, 0.1, 0, 'standing').gait).toBe('idle');
    // Walking, then jogging: during the fade the pose lies between the two clips'.
    run(m, 2, 1.2, 'standing');
    const walking = run(m, 0, 1.2, 'standing').bones['leftUpperLeg']!;
    const fading = m.update(FADE_S / 2, 4, 'standing', 0.9);
    expect(fading.gait).toBe('jog');
    const jogging = run(m, FADE_S, 4, 'standing').bones['leftUpperLeg']!;
    expect(fading.bones['leftUpperLeg']).not.toEqual(walking);
    expect(fading.bones['leftUpperLeg']).not.toEqual(jogging);
  });
});
