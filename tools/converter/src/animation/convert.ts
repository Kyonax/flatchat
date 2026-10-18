// SPDX-License-Identifier: MPL-2.0
// Emotes and dances into VRMA (S5.07, ad-009, rr-013): a VRMA, a GLB clip on a humanoid rig (bones
// recognised by their names: Mixamo's, Unity's, Blender's, VRoid's), BVH motion capture, or FBX
// (read by headless Blender into a GLB first, tools/blender/animation/fbx2glb.py; the core runs it
// before this). Each becomes one VRMA on VRM 1.0's normalized humanoid (retarget.ts), checked with
// the client's own check and the Khronos glTF-Validator, and a manifest; both named by SHA-256.
import { createHash } from 'node:crypto';
import { ANIMATION_FORMAT, ANIMATION_MAX_SECONDS, ANIMATION_SOURCE_LIMIT, type AnimationManifest, type AnimationSource, type AnimationUse, checkAnimationFile, readGltf, VRMC_VRM_ANIMATION } from '@flatchat/content';
import type { Node } from '@gltf-transform/core';
import { avatarIO, validateGltf } from '../avatar/convert.ts';
import { HUMAN_BONE_NAMES, humanBoneOf, mapByNames, REQUIRED_BONES } from '../avatar/humanoid.ts';
import { readBvh } from './bvh.ts';
import { readGltfMotion } from './gltf-motion.ts';
import { type Joint, type Motion, MotionError } from './motion.ts';
import { loops, retarget } from './retarget.ts';
import { writeVrma } from './vrma-write.ts';

export const ANIMATION_CONVERTER_VERSION = '1.0.0';

export class AnimationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

export interface AnimationResult {
  manifest: AnimationManifest;
  manifestBytes: Uint8Array;
  id: string;
  files: Map<string, Uint8Array>;
}

export interface AnimationOptions {
  name?: string;
  use?: AnimationUse;
  /** The upload's own format when it was converted on the way (an FBX read by Blender into a GLB). */
  from?: AnimationSource;
  /** The upload's own SHA-256 and size, when `bytes` is that conversion. */
  source?: { sha256: string; bytes: number };
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** What a file is, by its first bytes. */
export function animationFormat(bytes: Uint8Array): AnimationSource | 'unknown' {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
  if (head.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX/.test(head)) return 'fbx';
  if (/^\uFEFF?\s*HIERARCHY/i.test(head)) return 'bvh';
  if (bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 0x46546c67) {
    try {
      const json = readGltf(bytes, 'animation.glb').json as Record<string, unknown>;
      return ((json['extensionsUsed'] ?? []) as unknown[]).includes(VRMC_VRM_ANIMATION) ? 'vrma' : 'gltf';
    } catch {
      return 'gltf';
    }
  }
  return 'unknown';
}

/** A motion's joints mapped onto the humanoid by their names, as mapByNames maps a GLB's nodes:
 *  sides and fingers by name, the spine's links by depth below the hips. */
export function mapJoints(joints: readonly Joint[]): Map<string, number> {
  const found = new Map<string, number>();
  const fingers = new Map<string, Array<{ joint: number; at: number }>>();
  const spine: number[] = [];
  joints.forEach((j, i) => {
    if (HUMAN_BONE_NAMES.has(j.name)) {
      if (!found.has(j.name)) found.set(j.name, i);
      return;
    }
    const r = humanBoneOf(j.name);
    if (r === undefined) return;
    if (r === 'spine-link') spine.push(i);
    else if (typeof r === 'string') {
      if (!found.has(r)) found.set(r, i);
    } else fingers.set(`${r.side}${r.finger}`, [...(fingers.get(`${r.side}${r.finger}`) ?? []), { joint: r.joint, at: i }]);
  });
  for (const [key, list] of fingers) {
    const parts = key.includes('Thumb') ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    list.sort((a, b) => a.joint - b.joint);
    list.slice(0, 3).forEach((j, n) => {
      if (!found.has(`${key}${parts[n]}`)) found.set(`${key}${parts[n]}`, j.at);
    });
  }
  const hips = found.get('hips');
  const depth = (i: number): number => {
    let d = 0;
    for (let p = joints[i]!.parent; p >= 0; p = joints[p]!.parent) d += 1;
    return d;
  };
  const below = (i: number): boolean => {
    for (let p = joints[i]!.parent; p >= 0; p = joints[p]!.parent) if (p === hips) return true;
    return false;
  };
  const links = spine.filter((i) => hips === undefined || below(i)).sort((a, b) => depth(a) - depth(b));
  (['spine', 'chest', 'upperChest'] as const).forEach((bone, n) => {
    if (links[n] !== undefined && !found.has(bone)) found.set(bone, links[n]!);
  });
  return found;
}

/** Reads any source into a motion and its human bones. */
async function readMotion(bytes: Uint8Array, format: AnimationSource): Promise<{ motion: Motion; map: Map<string, number> }> {
  if (format === 'bvh') {
    const motion = readBvh(new TextDecoder().decode(bytes));
    return { motion, map: mapJoints(motion.joints) };
  }
  const doc = await avatarIO().readBinary(bytes);
  const nodes = doc.getRoot().listNodes();
  let byBone: Map<string, Node>;
  if (format === 'vrma') {
    const ext = ((readGltf(bytes, 'animation.glb').json as Record<string, unknown>)['extensions'] as Record<string, unknown> | undefined)?.[VRMC_VRM_ANIMATION] as { humanoid?: { humanBones?: Record<string, { node?: number }> } } | undefined;
    byBone = new Map();
    for (const [bone, ref] of Object.entries(ext?.humanoid?.humanBones ?? {})) {
      const n = typeof ref?.node === 'number' ? nodes[ref.node] : undefined;
      if (n && HUMAN_BONE_NAMES.has(bone)) byBone.set(bone, n);
    }
  } else byBone = mapByNames(doc);
  const hips = byBone.get('hips');
  if (!hips) throw new MotionError('no hips: the file is not an animation of a humanoid skeleton');
  const { motion, jointOf } = readGltfMotion(doc, hips);
  const map = new Map<string, number>();
  for (const [bone, node] of byBone) {
    const j = jointOf.get(node);
    if (j !== undefined) map.set(bone, j);
  }
  return { motion, map };
}

export async function convertAnimation(bytes: Uint8Array, o: AnimationOptions = {}): Promise<AnimationResult> {
  if (bytes.length > ANIMATION_SOURCE_LIMIT) throw new AnimationError([`the file is ${(bytes.length / 1048576).toFixed(1)} MB: ${ANIMATION_SOURCE_LIMIT / 1048576} MB at most`]);
  const format = animationFormat(bytes);
  if (format === 'unknown') throw new AnimationError(['not an animation FlatChat reads: a VRMA, a GLB clip, a BVH or an FBX']);
  if (format === 'fbx') throw new AnimationError(['an FBX is read by headless Blender into a GLB first (the core does it)']);
  if (format !== 'bvh') {
    const { problems } = await validateGltf(bytes, false);
    if (problems.length > 0) throw new AnimationError(problems.map((e) => `glTF-Validator: ${e}`));
  }
  let read: Awaited<ReturnType<typeof readMotion>>;
  try {
    read = await readMotion(bytes, format);
  } catch (err) {
    throw new AnimationError([err instanceof Error ? err.message : String(err)]);
  }
  const missing = REQUIRED_BONES.filter((b) => !read.map.has(b));
  if (missing.length > 0) throw new AnimationError([`not a humanoid animation FlatChat can retarget: no ${missing.join(', ')}`]);
  let humanoid;
  try {
    humanoid = retarget(read.motion, read.map);
  } catch (err) {
    throw new AnimationError([err instanceof Error ? err.message : String(err)]);
  }
  const duration = Math.max(1 / humanoid.fps, (humanoid.frames - 1) / humanoid.fps);
  if (duration > ANIMATION_MAX_SECONDS + 0.5) throw new AnimationError([`${duration.toFixed(1)} s long: ${ANIMATION_MAX_SECONDS} s at most`]);
  const file = writeVrma(humanoid, `FlatChat animation converter ${ANIMATION_CONVERTER_VERSION}`);
  checkAnimationFile(readGltf(file, 'animation.glb').json as Record<string, unknown>);
  const written = await validateGltf(file, false);
  if (written.problems.length > 0) throw new Error(`the converter wrote an invalid VRMA: ${written.problems.slice(0, 3).join('; ')}`);
  const fileHash = sha256(file);
  const manifest: AnimationManifest = {
    format: ANIMATION_FORMAT,
    kind: 'animation',
    converter: ANIMATION_CONVERTER_VERSION,
    source: { sha256: o.source?.sha256 ?? sha256(bytes), bytes: o.source?.bytes ?? bytes.length, format: o.from ?? format },
    name: (o.name ?? '').trim().slice(0, 64),
    use: o.use ?? 'emote',
    loop: loops(humanoid),
    duration: Math.round(duration * 1000) / 1000,
    bones: humanoid.bones,
    file: fileHash,
    bytes: file.length,
    warnings: humanoid.warnings,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  return { manifest, manifestBytes, id: sha256(manifestBytes), files: new Map([[fileHash, file]]) };
}
