// SPDX-License-Identifier: MPL-2.0
// glTF clips and VRMA as motions (S5.07): the longest animation of a GLB, sampled at the platform's
// rate, on the skeleton below the hips (the bone `map` names: by names for a plain rig, by
// VRMC_vrm_animation for a VRMA). Whatever stands above the hips (an armature's root turned from
// Z-up, scaled from centimetres) is baked in: the hips become the root, their world rotation and
// position per frame; every offset below is in world units (uniform scale assumed).
import { ANIMATION_FPS, ANIMATION_MAX_SECONDS } from '@flatchat/content';
import type { Accessor, AnimationChannel, Document, Node } from '@gltf-transform/core';
import { type Joint, type Motion, MotionError } from './motion.ts';
import { type Quat, qinv, qmul, qnorm, qrot, qslerp, type Vec3, vlen, vsub } from './quat.ts';

const MAX_JOINTS = 256;

interface Track {
  times: Float32Array;
  values: Float32Array;
  interpolation: string;
}

/** A sampler's value at time t: STEP, LINEAR (rotations slerped) or CUBICSPLINE (Hermite). */
function sample(track: Track, t: number, size: number, rotation: boolean): number[] {
  const { times, values, interpolation } = track;
  const cubic = interpolation === 'CUBICSPLINE';
  const at = (k: number): number[] => {
    const base = cubic ? (k * 3 + 1) * size : k * size;
    return Array.from(values.subarray(base, base + size));
  };
  if (t <= times[0]!) return at(0);
  const last = times.length - 1;
  if (t >= times[last]!) return at(last);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo]!;
  const t1 = times[hi]!;
  const u = (t - t0) / (t1 - t0 || 1);
  if (interpolation === 'STEP') return at(lo);
  if (cubic) {
    const d = t1 - t0;
    const v0 = at(lo);
    const v1 = at(hi);
    const out0 = Array.from(values.subarray((lo * 3 + 2) * size, (lo * 3 + 3) * size));
    const in1 = Array.from(values.subarray(hi * 3 * size, (hi * 3 + 1) * size));
    const u2 = u * u;
    const u3 = u2 * u;
    const r = v0.map((p0, i) => (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * d * out0[i]! + (-2 * u3 + 3 * u2) * v1[i]! + (u3 - u2) * d * in1[i]!);
    return rotation ? qnorm(r as Quat) : r;
  }
  const a = at(lo);
  const b = at(hi);
  if (rotation) return qslerp(a as Quat, b as Quat, u);
  return a.map((x, i) => x + (b[i]! - x) * u);
}

const floats = (a: Accessor): Float32Array => {
  const arr = a.getArray();
  if (!arr) return new Float32Array(0);
  if (arr instanceof Float32Array) return arr;
  // Normalized integers (glTF allows them for rotations): back to -1..1 or 0..1.
  const max = arr instanceof Int8Array ? 127 : arr instanceof Uint8Array ? 255 : arr instanceof Int16Array ? 32767 : arr instanceof Uint16Array ? 65535 : 1;
  return Float32Array.from(arr as ArrayLike<number>, (v) => (a.getNormalized() ? Math.max(v / max, -1) : v));
};

/** A node's local transform at time t: its channels where animated, its rest elsewhere. */
function localAt(node: Node, tracks: Map<Node, Partial<Record<'translation' | 'rotation' | 'scale', Track>>>, t: number): { t: Vec3; r: Quat; s: Vec3 } {
  const tr = tracks.get(node);
  return {
    t: (tr?.translation ? sample(tr.translation, t, 3, false) : node.getTranslation()) as Vec3,
    r: (tr?.rotation ? sample(tr.rotation, t, 4, true) : node.getRotation()) as Quat,
    s: (tr?.scale ? sample(tr.scale, t, 3, false) : node.getScale()) as Vec3,
  };
}

/** World rotation, position and (uniform) scale of a node at time t. */
function worldAt(node: Node, tracks: Map<Node, Partial<Record<'translation' | 'rotation' | 'scale', Track>>>, t: number): { r: Quat; p: Vec3; s: number } {
  const chain: Node[] = [];
  for (let n: Node | null = node; n; n = n.getParentNode()) chain.unshift(n);
  let r: Quat = [0, 0, 0, 1];
  let p: Vec3 = [0, 0, 0];
  let s = 1;
  for (const n of chain) {
    const l = localAt(n, tracks, t);
    const scaled: Vec3 = [l.t[0] * s, l.t[1] * s, l.t[2] * s];
    const moved = qrot(r, scaled);
    p = [p[0] + moved[0], p[1] + moved[1], p[2] + moved[2]];
    r = qmul(r, qnorm(l.r));
    s *= (Math.abs(l.s[0]) + Math.abs(l.s[1]) + Math.abs(l.s[2])) / 3;
  }
  return { r, p, s };
}

/** Reads a document's longest animation as a motion on the skeleton below `hips`. Returns the
 *  joints' indices by node so the caller's bone map can follow them. */
export function readGltfMotion(doc: Document, hips: Node): { motion: Motion; jointOf: Map<Node, number> } {
  const animations = doc.getRoot().listAnimations();
  if (animations.length === 0) throw new MotionError('the file has no animation');
  // The longest one.
  const span = (a: (typeof animations)[number]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of a.listSamplers()) {
      const times = s.getInput()?.getArray();
      if (!times || times.length === 0) continue;
      lo = Math.min(lo, times[0]!);
      hi = Math.max(hi, times[times.length - 1]!);
    }
    return [lo, hi];
  };
  const anim = animations.map((a) => ({ a, s: span(a) })).sort((x, y) => y.s[1] - y.s[0] - (x.s[1] - x.s[0]))[0]!;
  const [start, end] = Number.isFinite(anim.s[0]) ? anim.s : [0, 0];
  if (end - start > ANIMATION_MAX_SECONDS) throw new MotionError(`${(end - start).toFixed(1)} s long: ${ANIMATION_MAX_SECONDS} s at most`);
  const tracks = new Map<Node, Partial<Record<'translation' | 'rotation' | 'scale', Track>>>();
  for (const ch of anim.a.listChannels() as AnimationChannel[]) {
    const node = ch.getTargetNode();
    const path = ch.getTargetPath();
    const sampler = ch.getSampler();
    if (!node || !sampler || (path !== 'translation' && path !== 'rotation' && path !== 'scale')) continue;
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (!input || !output) continue;
    tracks.set(node, { ...tracks.get(node), [path]: { times: floats(input), values: floats(output), interpolation: sampler.getInterpolation() } });
  }

  // The joints: the hips and every node below them that holds no mesh or camera, parents first.
  const nodes: Node[] = [];
  const walk = (n: Node): void => {
    if (nodes.length >= MAX_JOINTS) throw new MotionError(`more than ${MAX_JOINTS} joints below the hips`);
    nodes.push(n);
    for (const c of n.listChildren()) if (!c.getMesh() && !c.getCamera()) walk(c);
  };
  walk(hips);
  const jointOf = new Map(nodes.map((n, i) => [n, i]));
  const rest = (n: Node): { r: Quat; p: Vec3; s: number } => worldAt(n, new Map(), 0);
  const joints: Joint[] = nodes.map((n, i) => {
    if (i === 0) return { name: n.getName(), parent: -1, offset: rest(n).p, rest: rest(n).r };
    const parent = n.getParentNode()!;
    const pr = rest(parent);
    const me = rest(n);
    // The offset in the parent's frame, scale baked in; the rotation from the parent's.
    return { name: n.getName(), parent: jointOf.get(parent)!, offset: qrot(qinv(pr.r), vsub(me.p, pr.p)), rest: qnorm(qmul(qinv(pr.r), me.r)) };
  });

  const frames = Math.max(1, Math.round((end - start) * ANIMATION_FPS) + 1);
  const rotations = nodes.map(() => new Float64Array(frames * 4));
  const translations = new Float64Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const t = start + f / ANIMATION_FPS;
    const h = worldAt(hips, tracks, t);
    rotations[0]!.set(h.r, f * 4);
    translations.set(h.p, f * 3);
    for (let i = 1; i < nodes.length; i++) rotations[i]!.set(qnorm(localAt(nodes[i]!, tracks, t).r), f * 4);
  }
  if (vlen(joints[0]!.offset) > 1e6) throw new MotionError('the skeleton is placed absurdly far away');
  return { motion: { joints, fps: ANIMATION_FPS, frames, rotations, root: 0, translations }, jointOf };
}
