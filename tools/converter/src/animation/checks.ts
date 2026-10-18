// SPDX-License-Identifier: MPL-2.0
// The checks Track P's default clips must pass (P.05, rr-014), on the standard bodies: no scale
// tracks and translation only on the hips; a loop's last pose within 1° of its first; no hand
// inside the torso in idle; and feet that hold still where they stand (at most 2 cm of sliding a
// step on walk and jog, at both ends of the legs slider). A clip is posed on a body the way
// three-vrm plays VRMA: each bone's normalized rotation along the body's own humanoid chain, the
// hips' place scaled by the body's hips height over the clip's.
import { PROPORTION_JOINTS } from '@flatchat/content';
import type { Document, Node } from '@gltf-transform/core';
import { avatarIO } from '../avatar/convert.ts';
import type { VRMData } from '../avatar/vrm.ts';
import { qangle, qmul, type Quat, qrot, type Vec3 } from './quat.ts';

/** A VRMA clip as the converter writes it, read back: per bone, a rotation a frame. */
export interface Clip {
  fps: number;
  frames: number;
  bones: string[];
  /** Each bone's normalized rotation at each frame. */
  rotation(bone: string, frame: number): Quat;
  /** The hips' place at each frame, and where it stands at rest. */
  hips(frame: number): Vec3;
  restHips: Vec3;
  /** What the file animates: each channel's bone and path. */
  channels: Array<{ bone: string; path: string }>;
}

export async function readClip(vrma: Uint8Array): Promise<Clip> {
  const doc = await avatarIO().readBinary(vrma);
  const anim = doc.getRoot().listAnimations()[0];
  if (!anim) throw new Error('no animation');
  const tracks = new Map<string, { times: Float32Array; values: number[][] }>();
  const channels: Clip['channels'] = [];
  let times = new Float32Array(1);
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    const sampler = ch.getSampler();
    if (!node || !sampler) continue;
    const input = sampler.getInput()!;
    const output = sampler.getOutput()!;
    const t = Float32Array.from({ length: input.getCount() }, (_, i) => input.getScalar(i));
    if (t.length > times.length) times = t;
    const values = Array.from({ length: output.getCount() }, (_, i) => output.getElement(i, []));
    channels.push({ bone: node.getName(), path: ch.getTargetPath() ?? '' });
    tracks.set(`${node.getName()}:${ch.getTargetPath()}`, { times: t, values });
  }
  const fps = times.length > 1 ? Math.round(1 / (times[1]! - times[0]!)) : 30;
  const at = (key: string, frame: number): number[] | undefined => {
    const tr = tracks.get(key);
    if (!tr) return undefined;
    return tr.values[Math.min(frame, tr.values.length - 1)];
  };
  const hipsNode = doc.getRoot().listNodes().find((n) => n.getName() === 'hips')!;
  const restHips = hipsNode.getWorldTranslation() as Vec3;
  return {
    fps,
    frames: times.length,
    bones: doc.getRoot().listNodes().map((n) => n.getName()),
    rotation: (bone, frame) => (at(`${bone}:rotation`, frame) as Quat | undefined) ?? [0, 0, 0, 1],
    hips: (frame) => (at('hips:translation', frame) as Vec3 | undefined) ?? restHips,
    restHips,
    channels,
  };
}

/** A body's normalized humanoid at rest: each bone's place, its humanoid parent and its offset. */
export interface Body {
  bones: string[];
  parent: Map<string, string | undefined>;
  offset: Map<string, Vec3>;
  rest: Map<string, Vec3>;
}

export function bodyOf(doc: Document, data: VRMData): Body {
  const human = data.humanBones();
  const byNode = new Map<Node, string>([...human].map(([bone, node]) => [node, bone]));
  const parent = new Map<string, string | undefined>();
  const rest = new Map<string, Vec3>();
  for (const [bone, node] of human) {
    rest.set(bone, node.getWorldTranslation() as Vec3);
    let p = node.getParentNode();
    while (p && !byNode.has(p)) p = p.getParentNode();
    parent.set(bone, p ? byNode.get(p) : undefined);
  }
  // Parents before children.
  const depth = (b: string): number => (parent.get(b) ? depth(parent.get(b)!) + 1 : 0);
  const bones = [...human.keys()].sort((a, b) => depth(a) - depth(b));
  const offset = new Map<string, Vec3>();
  for (const b of bones) {
    const p = parent.get(b);
    const r = rest.get(b)!;
    offset.set(b, p ? [r[0] - rest.get(p)![0], r[1] - rest.get(p)![1], r[2] - rest.get(p)![2]] : r);
  }
  void doc;
  return { bones, parent, offset, rest };
}

/** The joints the legs slider moves out, as the client's avatar layer does (S4.10): the knees and
 *  the ankles, so the thighs and shins grow and the feet keep their size. */
const LENGTHENED: ReadonlySet<string> = new Set(PROPORTION_JOINTS.legs);

/** Every bone's place at a frame, the legs' lengths scaled by `legs` (the slider's share) and the
 *  body lifted by what they grew, as the client does. */
export function pose(body: Body, clip: Clip, frame: number, legs = 1): Map<string, Vec3> {
  const at = new Map<string, Vec3>();
  const turn = new Map<string, Quat>();
  const hipsRest = body.rest.get('hips')!;
  const legScale = (b: string): number => (LENGTHENED.has(b) ? legs : 1);
  const length = (b: string): number => Math.hypot(...body.offset.get(b)!);
  const lift = ((length('leftLowerLeg') + length('leftFoot') + length('rightLowerLeg') + length('rightFoot')) / 2) * (legs - 1);
  // The hips' motion scaled as three-vrm scales it: by the body's hips height over the clip's.
  const k = hipsRest[1] / Math.max(1e-6, clip.restHips[1]);
  for (const b of body.bones) {
    const p = body.parent.get(b);
    const q = clip.rotation(b, frame);
    if (!p) {
      const h = clip.hips(frame);
      at.set(b, [h[0] * k, h[1] * k + lift, h[2] * k]);
      turn.set(b, q);
      continue;
    }
    const s = legScale(b);
    const o = body.offset.get(b)!;
    const r = qrot(turn.get(p)!, [o[0] * s, o[1] * s, o[2] * s]);
    const pp = at.get(p)!;
    at.set(b, [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]]);
    turn.set(b, qmul(turn.get(p)!, q));
  }
  return at;
}

/** What a clip may animate: rotations, and the hips' place; nothing else. */
export function channelProblems(clip: Clip): string[] {
  const out: string[] = [];
  for (const c of clip.channels) {
    if (c.path === 'scale') out.push(`${c.bone} has a scale track`);
    else if (c.path === 'translation' && c.bone !== 'hips' && !c.bone.startsWith('expression.')) out.push(`${c.bone} moves (only the hips may)`);
  }
  return out;
}

/** A loop's seam: the largest turn between its last pose and its first, over every bone (degrees). */
export function loopSeam(clip: Clip): number {
  let worst = 0;
  for (const b of clip.bones) worst = Math.max(worst, (qangle(clip.rotation(b, 0), clip.rotation(b, clip.frames - 1)) * 180) / Math.PI);
  return worst;
}

/** How near a hand comes to the torso's axis (hips to neck), less the torso's half-depth: below 0,
 *  inside it. Metres. */
export function handClearance(body: Body, clip: Clip): number {
  const shoulders = Math.hypot(...([0, 1, 2] as const).map((c) => body.rest.get('leftUpperArm')![c] - body.rest.get('rightUpperArm')![c]));
  const radius = 0.33 * shoulders;
  let worst = Infinity;
  for (let f = 0; f < clip.frames; f++) {
    const at = pose(body, clip, f);
    const a = at.get('hips')!;
    const b = at.get('neck') ?? at.get('head')!;
    for (const hand of ['leftHand', 'rightHand']) {
      const p = at.get(hand)!;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const t = Math.max(0, Math.min(1, (ab[0]! * ap[0]! + ab[1]! * ap[1]! + ab[2]! * ap[2]!) / (ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2)));
      const d = Math.hypot(ap[0]! - ab[0]! * t, ap[1]! - ab[1]! * t, ap[2]! - ab[2]! * t);
      worst = Math.min(worst, d - radius);
    }
  }
  return worst;
}

/** A walking clip's feet: its ground speed (metres a second at the clip's own pace, for these legs)
 *  and the most a planted foot slides in one step (metres), the body carried forward at that speed.
 *  A foot is planted while it bears weight as its gait does: in a walk, flat (the ball of the foot,
 *  the toes bone's root, within 2 cm of its ground and the ankle within 3 cm of its own, for three
 *  frames or more); in a run, whose heel never comes down while the ball is down, on the ball alone.
 *  A ground is the height a joint keeps for a tenth of the cycle, so one frame's dip moves none. The roll onto the toes
 *  that ends a walk's step turns about the toe tips, which no humanoid bone marks: it is no slide,
 *  and is not counted as one. The ground speed is the median of how fast a planted foot goes back. */
export function footSlide(body: Body, clip: Clip, legs = 1): { speed: number; slide: number; steps: number } {
  const frames = Array.from({ length: clip.frames }, (_, f) => pose(body, clip, f, legs));
  const ball = (f: number, side: 'left' | 'right'): Vec3 => frames[f]!.get(`${side}Toes`) ?? frames[f]!.get(`${side}Foot`)!;
  const planted = (side: 'left' | 'right'): boolean[] => {
    const b = frames.map((_, f) => ball(f, side)[1]);
    const a = frames.map((at) => at.get(`${side}Foot`)![1]);
    // Each one's ground: the height it keeps for a tenth of the cycle, not a frame's dip.
    const ground = (h: number[]): number => [...h].sort((x, y) => x - y)[Math.floor(h.length * 0.1)]!;
    const lowBall = ground(b);
    const lowAnkle = ground(a);
    const onBall = b.map((y) => y <= lowBall + 0.02);
    const flat = onBall.map((on, f) => on && a[f]! <= lowAnkle + 0.03);
    // A walk stands flat for a while; a run's chance frame or two near its lowest heel is no stance.
    let run = 0;
    let longest = 0;
    for (const on of flat) longest = Math.max(longest, (run = on ? run + 1 : 0));
    return longest >= 3 ? flat : onBall;
  };
  const back: number[] = [];
  for (const side of ['left', 'right'] as const) {
    const on = planted(side);
    for (let f = 1; f < clip.frames; f++) if (on[f] && on[f - 1]) back.push((ball(f - 1, side)[2] - ball(f, side)[2]) * clip.fps);
  }
  back.sort((x, y) => x - y);
  const speed = back.length > 0 ? back[back.length >> 1]! : 0;
  let slide = 0;
  let steps = 0;
  for (const side of ['left', 'right'] as const) {
    const on = planted(side);
    let start = -1;
    for (let f = 0; f <= clip.frames; f++) {
      if (f < clip.frames && on[f]) {
        if (start < 0) start = f;
        const a = ball(start, side);
        const b = ball(f, side);
        slide = Math.max(slide, Math.hypot(b[0] - a[0], b[2] + (speed * (f - start)) / clip.fps - a[2]));
      } else if (start >= 0) {
        if (f - start >= 2) steps += 1;
        start = -1;
      }
    }
  }
  return { speed, slide, steps };
}
