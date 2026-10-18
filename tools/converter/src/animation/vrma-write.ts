// SPDX-License-Identifier: MPL-2.0
// Writes a humanoid motion as VRMA (VRMC_vrm_animation 1.0, S5.07): one node per human bone,
// unrotated and placed where VRM's T-pose puts it, named by the bone; one animation with each
// bone's rotation (normalized 16-bit integers, as glTF allows for rotations: 8 bytes a key) and
// the hips' position. A track that never moves keeps one key. Written by hand rather than through
// glTF-Transform, which would drop the extension; deterministic, so golden files compare bytes.
import { qangle, type Quat } from './quat.ts';
import type { Humanoid } from './retarget.ts';

/** A bone that never turns more than this from its first pose keeps one key (degrees). */
const STILL = 0.05;

export function writeVrma(h: Humanoid, generator: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const add = (bytes: Uint8Array): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    length += bytes.length;
    return bufferViews.length - 1;
  };
  const accessor = (a: Record<string, unknown>): number => {
    accessors.push(a);
    return accessors.length - 1;
  };

  const times = new Float32Array(h.frames).map((_, f) => f / h.fps);
  const allTimes = accessor({ bufferView: add(new Uint8Array(times.buffer)), componentType: 5126, count: h.frames, type: 'SCALAR', min: [0], max: [times[h.frames - 1]!] });
  let oneTime: number | undefined;
  const firstOnly = (): number => (oneTime ??= accessor({ bufferView: add(new Uint8Array(new Float32Array([0]).buffer)), componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] }));

  // Nodes: the bones in parent-first order, each a child of its humanoid parent.
  const nodes: Array<Record<string, unknown>> = h.bones.map((b, i) => ({ name: b, translation: h.offsets[i] }));
  h.bones.forEach((_, i) => {
    const p = h.parent[i];
    if (!p) return;
    const parent = nodes[h.bones.indexOf(p)]!;
    parent['children'] = [...((parent['children'] as number[] | undefined) ?? []), i];
  });

  const samplers: Array<Record<string, unknown>> = [];
  const channels: Array<Record<string, unknown>> = [];
  h.bones.forEach((_, i) => {
    const r = h.rotations[i]!;
    const first: Quat = [r[0]!, r[1]!, r[2]!, r[3]!];
    let still = true;
    for (let f = 1; f < h.frames && still; f++) still = (qangle(first, [r[f * 4]!, r[f * 4 + 1]!, r[f * 4 + 2]!, r[f * 4 + 3]!]) * 180) / Math.PI <= STILL;
    const keys = still ? 1 : h.frames;
    const out = new Int16Array(keys * 4);
    for (let k = 0; k < keys * 4; k++) out[k] = Math.round(Math.max(-1, Math.min(1, r[k]!)) * 32767);
    const output = accessor({ bufferView: add(new Uint8Array(out.buffer)), componentType: 5122, normalized: true, count: keys, type: 'VEC4' });
    samplers.push({ input: still ? firstOnly() : allTimes, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: i, path: 'rotation' } });
  });
  // The hips' place.
  const hipsOut = new Float32Array(h.hips);
  const min = [0, 1, 2].map((c) => Math.min(...Array.from({ length: h.frames }, (_, f) => hipsOut[f * 3 + c]!)));
  const max = [0, 1, 2].map((c) => Math.max(...Array.from({ length: h.frames }, (_, f) => hipsOut[f * 3 + c]!)));
  const hipsAccessor = accessor({ bufferView: add(new Uint8Array(hipsOut.buffer)), componentType: 5126, count: h.frames, type: 'VEC3', min, max });
  samplers.push({ input: allTimes, output: hipsAccessor, interpolation: 'LINEAR' });
  channels.push({ sampler: samplers.length - 1, target: { node: h.bones.indexOf('hips'), path: 'translation' } });

  const bin = new Uint8Array(length + ((4 - (length % 4)) % 4));
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(h.bones.map((b, i) => [b, { node: i }])) } } },
    scene: 0,
    scenes: [{ nodes: [h.bones.indexOf('hips')] }],
    nodes,
    animations: [{ name: 'flatchat', samplers, channels }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  return glb(json, bin);
}

/** A GLB container: the JSON chunk (padded with spaces) and the binary chunk. */
function glb(json: unknown, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = text.length + ((4 - (text.length % 4)) % 4);
  const total = 12 + 8 + jsonLength + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, bin.length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}
