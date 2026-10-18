// SPDX-License-Identifier: MPL-2.0
// The platform's default clips (Track P's P.05, kits/animations/): VRMA files the converter wrote
// from two CC0 libraries, carried inside the client and read here, each into its bones' rotation
// keys and the hips' height, so a body's pose at any moment is a lookup and a blend. A VRMA's
// rotations are VRM 1.0's normalized bone rotations, the same space the avatar layer poses (and the
// impostors' rule turns into their own bones). Only the converter's own VRMA is read: one
// animation, rotations as normalized shorts or floats, the hips' place as floats.
import clips from '../../../../../../kits/animations/clips.json';
import dance from '../../../../../../kits/animations/dance.vrma?url&inline';
import fall from '../../../../../../kits/animations/fall.vrma?url&inline';
import greeting from '../../../../../../kits/animations/greeting.vrma?url&inline';
import idle from '../../../../../../kits/animations/idle.vrma?url&inline';
import jog from '../../../../../../kits/animations/jog.vrma?url&inline';
import jumpAir from '../../../../../../kits/animations/jump-air.vrma?url&inline';
import jumpStart from '../../../../../../kits/animations/jump-start.vrma?url&inline';
import land from '../../../../../../kits/animations/land.vrma?url&inline';
import sitEnter from '../../../../../../kits/animations/sit-enter.vrma?url&inline';
import sitExit from '../../../../../../kits/animations/sit-exit.vrma?url&inline';
import sitIdle from '../../../../../../kits/animations/sit-idle.vrma?url&inline';
import sprint from '../../../../../../kits/animations/sprint.vrma?url&inline';
import walk from '../../../../../../kits/animations/walk.vrma?url&inline';

export type Quat = [number, number, number, number];
export type BoneAngles = Record<string, [number, number, number]>;

export interface ClipData {
  name: string;
  fps: number;
  frames: number;
  duration: number;
  loop: boolean;
  /** Each bone's rotation keys, four numbers a frame (one key for a bone that never turns). */
  rotations: Map<string, Float32Array>;
  /** The hips' height at each frame, and at rest. */
  hipsY: Float32Array;
  restHipsY: number;
  /** A walking clip's ground speed for a metre of leg (clips.json), else 0. */
  speedPerLeg: number;
}

interface Gltf {
  nodes: Array<{ name?: string; translation?: number[] }>;
  accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }>;
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  animations: Array<{ channels: Array<{ sampler: number; target: { node: number; path: string } }>; samplers: Array<{ input: number; output: number }> }>;
  extensions?: { VRMC_vrm_animation?: { humanoid?: { humanBones?: Record<string, { node: number }> } } };
}

const SIZE: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

/** A converter-written VRMA, read. */
export function readVrma(bytes: Uint8Array, meta: { name: string; loop: boolean; speedPerLeg?: number }): ClipData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${meta.name}: not a GLB`);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
  const binAt = 20 + jsonLength + 8;
  const read = (index: number): Float32Array => {
    const a = json.accessors[index]!;
    const v = json.bufferViews[a.bufferView]!;
    const n = SIZE[a.type];
    if (!n) throw new Error(`${meta.name}: an accessor of ${a.type}`);
    const out = new Float32Array(a.count * n);
    const at = binAt + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (a.componentType === 5126) {
      const stride = v.byteStride ?? n * 4;
      for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = view.getFloat32(at + i * stride + c * 4, true);
    } else if (a.componentType === 5122 && a.normalized) {
      const stride = v.byteStride ?? n * 2;
      for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = Math.max(-1, view.getInt16(at + i * stride + c * 2, true) / 32767);
    } else throw new Error(`${meta.name}: components of type ${a.componentType}`);
    return out;
  };
  const human = json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones ?? {};
  const boneOf = new Map(Object.entries(human).map(([bone, ref]) => [ref.node, bone]));
  const anim = json.animations[0];
  if (!anim) throw new Error(`${meta.name}: no animation`);
  const rotations = new Map<string, Float32Array>();
  let hipsY = new Float32Array(0);
  let frames = 1;
  for (const ch of anim.channels) {
    const bone = boneOf.get(ch.target.node);
    if (!bone) continue;
    const sampler = anim.samplers[ch.sampler]!;
    const keys = read(sampler.output);
    if (ch.target.path === 'rotation') rotations.set(bone, keys);
    else if (ch.target.path === 'translation' && bone === 'hips') hipsY = keys.filter((_, i) => i % 3 === 1);
    frames = Math.max(frames, json.accessors[sampler.input]!.count);
  }
  const hipsNode = json.nodes[human['hips']?.node ?? -1];
  const fps = 30;
  return { name: meta.name, fps, frames, duration: (frames - 1) / fps, loop: meta.loop, rotations, hipsY, restHipsY: hipsNode?.translation?.[1] ?? 1, speedPerLeg: meta.speedPerLeg ?? 0 };
}

function slerp(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, t: number, out: Quat): Quat {
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let p = 1 - t;
  let q = t;
  if (d < 0.9995) {
    const th = Math.acos(d);
    const s = Math.sin(th);
    p = Math.sin((1 - t) * th) / s;
    q = Math.sin(t * th) / s;
  }
  out[0] = ax * p + bx * q;
  out[1] = ay * p + by * q;
  out[2] = az * p + bz * q;
  out[3] = aw * p + bw * q;
  return out;
}

/** A bone's rotation at a time in seconds (a loop goes round, a one-shot holds its last pose). */
export function rotationAt(clip: ClipData, bone: string, t: number, out: Quat): Quat | undefined {
  const keys = clip.rotations.get(bone);
  if (!keys) return undefined;
  const count = keys.length / 4;
  if (count === 1) {
    out[0] = keys[0]!;
    out[1] = keys[1]!;
    out[2] = keys[2]!;
    out[3] = keys[3]!;
    return out;
  }
  const f = Math.max(0, clip.loop ? (t * clip.fps) % (count - 1) : Math.min(t * clip.fps, count - 1));
  const f0 = Math.min(count - 1, Math.floor(f));
  const f1 = Math.min(count - 1, f0 + 1);
  const w = f - f0;
  const a = f0 * 4;
  const b = f1 * 4;
  return slerp(keys[a]!, keys[a + 1]!, keys[a + 2]!, keys[a + 3]!, keys[b]!, keys[b + 1]!, keys[b + 2]!, keys[b + 3]!, w, out);
}

/** The hips' rise or fall at a time, as a share of their height at rest. */
export function bobAt(clip: ClipData, t: number): number {
  const n = clip.hipsY.length;
  if (n === 0) return 0;
  const f = Math.max(0, clip.loop ? (t * clip.fps) % Math.max(1, n - 1) : Math.min(t * clip.fps, n - 1));
  const f0 = Math.min(n - 1, Math.floor(f));
  const f1 = Math.min(n - 1, f0 + 1);
  const y = clip.hipsY[f0]! + (clip.hipsY[f1]! - clip.hipsY[f0]!) * (f - f0);
  return (y - clip.restHipsY) / clip.restHipsY;
}

/** A quaternion as the Euler angles (XYZ) three.js sets: the avatar layer's bone angles. */
export function eulerXYZ(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), ey, 0];
}

/** Blends two quaternions (a's weight 1 - t), for a cross-fade. */
export function blend(a: Quat, b: Quat, t: number, out: Quat): Quat {
  return slerp(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], t, out);
}

const FILES: Record<string, string> = { idle, walk, jog, sprint, 'jump-start': jumpStart, 'jump-air': jumpAir, land, fall, 'sit-enter': sitEnter, 'sit-idle': sitIdle, 'sit-exit': sitExit, greeting, dance };

/** The bytes of an inlined file (a data URL). */
function bytesOf(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let library: Map<string, ClipData> | undefined;

/** Every default clip, read once. */
export function defaultClips(): Map<string, ClipData> {
  if (!library) {
    library = new Map();
    for (const c of clips.clips) {
      const url = FILES[c.name];
      if (!url) continue;
      library.set(c.name, readVrma(bytesOf(url), { name: c.name, loop: c.loop, ...('speedPerLeg' in c && typeof c.speedPerLeg === 'number' ? { speedPerLeg: c.speedPerLeg } : {}) }));
    }
  }
  return library;
}
