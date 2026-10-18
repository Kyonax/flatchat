// SPDX-License-Identifier: MPL-2.0
// Sample animations for the golden tests (S5.07), made in code: the same motion in each format a
// creator brings. Over two seconds the right arm rises from the T-pose to 80° above level and
// back, the head nods 15° and the hips bob 2 cm, so every format must give the same VRMA motion.
//   - BVH: a CMU-style skeleton in centimetres, facing +Z, resting in the T-pose (BVH's rule).
//   - GLB clip: Mixamo's names under an armature scaled from centimetres, facing -Z, resting in an
//     A-pose (arms 45° down), its first frame the A-pose: the converter must turn it round,
//     straighten its rest into the T-pose and undo the scale.
// And a sound for it: two seconds of sung vowels (a, i, u, o between short silences), synthesised
// from a 120 Hz voice through two formant resonators, so the mouth track has something to follow.
import { Document, NodeIO } from '@gltf-transform/core';
import { invert } from '../avatar/matrix.ts';
import { IDENTITY, type Quat, qaxis, type Vec3 } from './quat.ts';

/** The sample's motion at time t (seconds): the right arm's raise in degrees, the head's nod, the bob. */
export function sampleMotion(t: number): { raise: number; nod: number; bob: number } {
  return { raise: 80 * Math.sin((Math.PI * t) / 2), nod: 15 * Math.sin(Math.PI * t), bob: 2 * Math.sin(Math.PI * t) };
}
export const SAMPLE_SECONDS = 2;
const FPS = 30;

/** Joints of the sample skeleton: name, parent, offset in centimetres (T-pose, facing +Z, left at +X). */
const SKELETON: ReadonlyArray<readonly [string, string | null, Vec3]> = [
  ['Hips', null, [0, 95, 0]],
  ['Spine', 'Hips', [0, 10, 0]],
  ['Spine1', 'Spine', [0, 15, 0]],
  ['Neck', 'Spine1', [0, 20, 0]],
  ['Head', 'Neck', [0, 10, 0]],
  ['LeftShoulder', 'Spine1', [5, 17, 0]],
  ['LeftArm', 'LeftShoulder', [12, 0, 0]],
  ['LeftForeArm', 'LeftArm', [27, 0, 0]],
  ['LeftHand', 'LeftForeArm', [25, 0, 0]],
  ['RightShoulder', 'Spine1', [-5, 17, 0]],
  ['RightArm', 'RightShoulder', [-12, 0, 0]],
  ['RightForeArm', 'RightArm', [-27, 0, 0]],
  ['RightHand', 'RightForeArm', [-25, 0, 0]],
  ['LeftUpLeg', 'Hips', [9, -5, 0]],
  ['LeftLeg', 'LeftUpLeg', [0, -42, 0]],
  ['LeftFoot', 'LeftLeg', [0, -42, 0]],
  ['LeftToeBase', 'LeftFoot', [0, -6, 12]],
  ['RightUpLeg', 'Hips', [-9, -5, 0]],
  ['RightLeg', 'RightUpLeg', [0, -42, 0]],
  ['RightFoot', 'RightLeg', [0, -42, 0]],
  ['RightToeBase', 'RightFoot', [0, -6, 12]],
];

/** The BVH sample. */
export function sampleBvh(): string {
  const lines: string[] = ['HIERARCHY'];
  const write = (name: string, depth: number): void => {
    const [, parent, offset] = SKELETON.find(([n]) => n === name)!;
    const pad = '  '.repeat(depth);
    lines.push(`${pad}${parent ? 'JOINT' : 'ROOT'} ${name}`, `${pad}{`, `${pad}  OFFSET ${offset.join(' ')}`);
    lines.push(`${pad}  CHANNELS ${parent ? '3 Zrotation Xrotation Yrotation' : '6 Xposition Yposition Zposition Zrotation Xrotation Yrotation'}`);
    const kids = SKELETON.filter(([, p]) => p === name);
    if (kids.length === 0) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET 0 5 0`, `${pad}  }`);
    for (const [k] of kids) write(k, depth + 1);
    lines.push(`${pad}}`);
  };
  write('Hips', 0);
  const frames = SAMPLE_SECONDS * FPS + 1;
  lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${(1 / FPS).toFixed(8)}`);
  for (let f = 0; f < frames; f++) {
    const { raise, nod, bob } = sampleMotion(f / FPS);
    const row: number[] = [];
    for (const [name, parent] of SKELETON) {
      if (!parent) row.push(0, 95 + bob, 0);
      // Z, X, Y: the right arm turns about -Z to rise (it points to -X); the head nods about X.
      row.push(name === 'RightArm' ? -raise : 0, name === 'Head' ? nod : 0, 0);
    }
    lines.push(row.map((v) => (Math.round(v * 1e5) / 1e5).toString()).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

/** The GLB clip sample: Mixamo names, an armature scaled from centimetres, facing -Z, resting in an
 *  A-pose, its motion starting there. */
export async function sampleClip(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const turn = (v: Vec3): Vec3 => [-v[0], v[1], -v[2]];
  const armature = doc.createNode('Armature').setScale([0.01, 0.01, 0.01]);
  const nodes = new Map<string, ReturnType<typeof doc.createNode>>();
  // A-pose: each upper arm 45° down. Facing -Z: the left side at -X, so the left arm turns about +Z
  // to go down (it points to -X), the right about -Z.
  const aPose = (name: string): Quat => (name === 'LeftArm' ? qaxis([0, 0, 1], Math.PI / 4) : name === 'RightArm' ? qaxis([0, 0, 1], -Math.PI / 4) : IDENTITY);
  for (const [name, parent, offset] of SKELETON) {
    const node = doc.createNode(`mixamorig:${name}`).setTranslation(turn(offset)).setRotation(aPose(name));
    nodes.set(name, node);
    (parent ? nodes.get(parent)! : armature).addChild(node);
  }
  const frames = SAMPLE_SECONDS * FPS + 1;
  const times = new Float32Array(frames).map((_, f) => f / FPS);
  const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  const anim = doc.createAnimation('Wave');
  const track = (node: ReturnType<typeof doc.createNode>, path: 'rotation' | 'translation', values: number[]): void => {
    const output = doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  };
  const arm: number[] = [];
  const head: number[] = [];
  const hips: number[] = [];
  for (let f = 0; f < frames; f++) {
    const { raise, nod, bob } = sampleMotion(f / FPS);
    // The right arm (at +X here) from its rest, 45° down, to 80° up and back: about +Z.
    arm.push(...qaxis([0, 0, 1], ((-45 + (raise / 80) * 125) * Math.PI) / 180));
    // Facing -Z, a nod forward turns about -X.
    head.push(...qaxis([1, 0, 0], (-nod * Math.PI) / 180));
    hips.push(...turn([0, 95 + bob, 0]));
  }
  track(nodes.get('RightArm')!, 'rotation', arm);
  track(nodes.get('Head')!, 'rotation', head);
  track(nodes.get('Hips')!, 'translation', hips);
  // A skin over every joint (with a triangle on the hips), so tools read the joints as a skeleton.
  const joints = [...nodes.values()];
  const inverse = new Float32Array(joints.flatMap((j) => invert(j.getWorldMatrix() as unknown as number[])));
  const skin = doc.createSkin('Armature').setSkeleton(nodes.get('Hips')!).setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(inverse).setBuffer(buffer));
  for (const j of joints) skin.addJoint(j);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0.9, 0, 0.1, 0.9, 0, 0, 1, 0])).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(12)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer));
  armature.addChild(doc.createNode('Body').setMesh(doc.createMesh('Body').addPrimitive(prim)).setSkin(skin));
  doc.createScene('Scene').addChild(armature);
  return new NodeIO().writeBinary(doc);
}

/** The sample's sound: a 16 kHz mono WAV of sung vowels (a, i, u, o) between short silences. */
export function sampleSong(): Uint8Array {
  const RATE = 16_000;
  const VOWELS: Record<string, [number, number]> = { a: [800, 1200], i: [300, 2300], u: [320, 800], o: [500, 900] };
  const PLAN: Array<[number, number, string]> = [
    [0.2, 0.5, 'a'],
    [0.6, 0.9, 'i'],
    [1.0, 1.3, 'u'],
    [1.4, 1.7, 'o'],
  ];
  const n = RATE * SAMPLE_SECONDS;
  const out = new Float64Array(n);
  // A two-pole resonator per formant over a 120 Hz pulse train.
  const resonate = (x: Float64Array, f: number, bw: number): Float64Array => {
    const r = Math.exp((-Math.PI * bw) / RATE);
    const a1 = 2 * r * Math.cos((2 * Math.PI * f) / RATE);
    const a2 = -r * r;
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = (1 - r) * x[i]! + a1 * (y[i - 1] ?? 0) + a2 * (y[i - 2] ?? 0);
    return y;
  };
  for (const [from, to, v] of PLAN) {
    const a = Math.round(from * RATE);
    const pulses = new Float64Array(Math.round(to * RATE) - a).map((_, i) => (i % Math.round(RATE / 120) === 0 ? 1 : 0));
    const [f1, f2] = VOWELS[v]!;
    const s1 = resonate(pulses, f1, 80);
    const s2 = resonate(pulses, f2, 120);
    for (let i = 0; i < pulses.length; i++) out[a + i] = (s1[i]! + 0.6 * s2[i]!) * Math.min(1, i / 400, (pulses.length - i) / 400);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const pcm = new Int16Array(n).map((_, i) => Math.round((out[i]! / (peak || 1)) * 0.8 * 32767));
  const wav = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(wav.buffer);
  const ascii = (at: number, t: string): void => [...t].forEach((c, k) => wav.set([c.charCodeAt(0)], at + k));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  wav.set(new Uint8Array(pcm.buffer), 44);
  return wav;
}
