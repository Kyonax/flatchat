// SPDX-License-Identifier: MPL-2.0
// BVH motion capture (S5.07): the text format CMU's library, Rokoko, MotionBuilder and Blender
// write. A HIERARCHY of joints, each with its OFFSET from the parent and its CHANNELS (the root's
// three positions and every joint's three Euler rotations, in the order listed), then MOTION:
// frames of numbers. Read in TypeScript, not through Blender: a text format needs no other program.
// Every joint rests unrotated (BVH's rule), so the rest pose is the offsets alone.
import { ANIMATION_FPS, ANIMATION_MAX_SECONDS } from '@flatchat/content';
import type { Joint, Motion } from './motion.ts';
import { MotionError } from './motion.ts';
import { IDENTITY, type Quat, qeuler, qslerp } from './quat.ts';

const MAX_JOINTS = 256;

interface BvhJoint extends Joint {
  channels: string[];
  /** Where its channels start in a frame's numbers. */
  first: number;
}

/** Reads a BVH file into a motion, resampled at ANIMATION_FPS. */
export function readBvh(text: string): Motion {
  const tokens = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const next = (): string => {
    const t = tokens[i++];
    if (t === undefined) throw new MotionError('the BVH file ends early');
    return t;
  };
  const number = (): number => {
    const v = Number(next());
    if (!Number.isFinite(v)) throw new MotionError('a BVH number is not a number');
    return v;
  };
  if (next().toUpperCase() !== 'HIERARCHY') throw new MotionError('not a BVH file (no HIERARCHY)');
  const joints: BvhJoint[] = [];
  let width = 0;
  const readJoint = (parent: number, end: boolean): void => {
    const name = end ? `${joints[parent]?.name ?? 'end'}_end` : next();
    if (next() !== '{') throw new MotionError(`BVH joint ${name}: "{" expected`);
    if (next().toUpperCase() !== 'OFFSET') throw new MotionError(`BVH joint ${name}: OFFSET expected`);
    const offset: [number, number, number] = [number(), number(), number()];
    if (end) {
      if (next() !== '}') throw new MotionError('an End Site holds only its OFFSET');
      return;
    }
    if (next().toUpperCase() !== 'CHANNELS') throw new MotionError(`BVH joint ${name}: CHANNELS expected`);
    const n = number();
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new MotionError(`BVH joint ${name}: ${n} channels`);
    const channels: string[] = [];
    for (let c = 0; c < n; c++) {
      const ch = next();
      if (!/^[XYZ](position|rotation)$/i.test(ch)) throw new MotionError(`BVH joint ${name}: channel ${ch}`);
      channels.push(ch[0]!.toUpperCase() + ch.slice(1).toLowerCase());
    }
    if (joints.length >= MAX_JOINTS) throw new MotionError(`more than ${MAX_JOINTS} joints`);
    const index = joints.length;
    joints.push({ name, parent, offset, rest: IDENTITY, channels, first: width });
    width += n;
    for (;;) {
      const t = next();
      if (t === '}') return;
      const kind = t.toUpperCase();
      if (kind === 'JOINT') readJoint(index, false);
      else if (kind === 'END') {
        next(); // "Site"
        readJoint(index, true);
      } else throw new MotionError(`BVH joint ${name}: ${t}`);
    }
  };
  if (next().toUpperCase() !== 'ROOT') throw new MotionError('a BVH hierarchy starts at its ROOT');
  readJoint(-1, false);
  if (next().toUpperCase() !== 'MOTION') throw new MotionError('MOTION expected after the hierarchy');
  if (next().toUpperCase() !== 'FRAMES:') throw new MotionError('Frames: expected');
  const frames = number();
  if (next().toUpperCase() !== 'FRAME' || next().toUpperCase() !== 'TIME:') throw new MotionError('Frame Time: expected');
  const frameTime = number();
  if (!Number.isInteger(frames) || frames < 1 || !(frameTime > 0)) throw new MotionError('a BVH file has frames and a frame time');
  const seconds = (frames - 1) * frameTime;
  if (seconds > ANIMATION_MAX_SECONDS) throw new MotionError(`${seconds.toFixed(1)} s long: ${ANIMATION_MAX_SECONDS} s at most`);
  if (tokens.length - i < frames * width) throw new MotionError(`the BVH file has fewer numbers than its ${frames} frames need`);
  const data = new Float64Array(frames * width);
  for (let k = 0; k < data.length; k++) data[k] = number();

  // Each joint's rotation and the root's position in a source frame.
  const rotationAt = (j: BvhJoint, f: number): Quat => {
    const order = j.channels.filter((c) => c.endsWith('rotation')).map((c) => c[0]!).join('');
    const angles = j.channels.flatMap((c, k) => (c.endsWith('rotation') ? [data[f * width + j.first + k]!] : []));
    return qeuler(order, angles);
  };
  const root = joints[0]!;
  const positionAt = (f: number): [number, number, number] => {
    const p: [number, number, number] = [...root.offset];
    root.channels.forEach((c, k) => {
      if (c.endsWith('position')) p['XYZ'.indexOf(c[0]!)] = data[f * width + root.first + k]!;
    });
    return p;
  };

  // Resampled at the platform's rate.
  const out = Math.max(1, Math.round(seconds * ANIMATION_FPS) + 1);
  const rotations = joints.map(() => new Float64Array(out * 4));
  const translations = new Float64Array(out * 3);
  for (let f = 0; f < out; f++) {
    const at = Math.min(frames - 1, (f / ANIMATION_FPS) / frameTime);
    const a = Math.floor(at);
    const b = Math.min(frames - 1, a + 1);
    const t = at - a;
    joints.forEach((j, n) => rotations[n]!.set(qslerp(rotationAt(j, a), rotationAt(j, b), t), f * 4));
    const pa = positionAt(a);
    const pb = positionAt(b);
    translations.set([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t], f * 3);
  }
  return { joints: joints.map(({ name, parent, offset, rest }) => ({ name, parent, offset, rest })), fps: ANIMATION_FPS, frames: out, rotations, root: 0, translations };
}
