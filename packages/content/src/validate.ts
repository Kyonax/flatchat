// SPDX-License-Identifier: Apache-2.0
// The world validator (S2.01): a world folder's files in, its manifest, its scenes' markers and
// every problem out. It reads only what the folder holds, decodes no image (sizes come from the
// headers) and runs no code from the world (an effect is read, never played: the converter's dry
// run plays it).
import { editorVersion, EFFECT_RUNTIME, type EffectFile, effectFiles, EffectFormatError, effectPath, readEffectFile } from './effect.ts';
import { parseManifest, type Problem, type Severity, type WorldManifest } from './manifest.ts';
import { inspectScene, LIMITS, readGltf, type SceneInfo } from './scene.ts';

export const FOLDER_LIMIT = 512 * 1024 * 1024;
export const FILE_LIMIT = 256 * 1024 * 1024;

export interface WorldReport {
  ok: boolean;
  manifest?: WorldManifest;
  scenes: SceneInfo[];
  problems: Problem[];
  bytes: number;
}

/** Width and height from a PNG, JPEG or WebP file's header, if it is one. */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === 'VP8L') {
      const bits = v.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const length = v.getUint16(i + 2);
      // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      i += 2 + length;
    }
  }
  return undefined;
}

export function validateWorld(files: ReadonlyMap<string, Uint8Array>): WorldReport {
  const problems: Problem[] = [];
  const scenes: SceneInfo[] = [];
  let bytes = 0;
  for (const [path, data] of files) {
    bytes += data.length;
    if (data.length > FILE_LIMIT) problems.push({ code: 'too-big', severity: 'error', file: path, at: '', message: `a file is at most ${FILE_LIMIT / 1048576} MB` });
  }
  if (bytes > FOLDER_LIMIT) problems.push({ code: 'too-big', severity: 'error', file: '', at: '', message: `a world is at most ${FOLDER_LIMIT / 1048576} MB` });
  const toml = files.get('world.toml');
  if (!toml) {
    problems.push({ code: 'manifest-missing', severity: 'error', file: 'world.toml', at: '', message: 'a world folder has a world.toml' });
    return { ok: false, scenes, problems, bytes };
  }
  const { manifest, problems: mp } = parseManifest(new TextDecoder().decode(toml));
  problems.push(...mp);
  if (!manifest) return { ok: false, scenes, problems, bytes };

  for (const entry of manifest.scenes) {
    const data = files.get(entry.file);
    if (!data) {
      problems.push({ code: 'scene-missing', severity: 'error', file: entry.file, at: '', message: `scene ${entry.id}'s file is not in the folder` });
      continue;
    }
    let read: ReturnType<typeof readGltf>;
    try {
      read = readGltf(data, entry.file);
    } catch (err) {
      problems.push({ code: 'gltf-syntax', severity: 'error', file: entry.file, at: '', message: err instanceof Error ? err.message : 'not glTF' });
      continue;
    }
    const { scene, problems: sp } = inspectScene(read.json, entry.file);
    problems.push(...sp);
    if (!scene) continue;
    const base = entry.file.includes('/') ? entry.file.slice(0, entry.file.lastIndexOf('/') + 1) : '';
    for (const need of scene.needs) {
      if (!files.has(base + need)) problems.push({ code: 'file-missing', severity: 'error', file: entry.file, at: need, message: `${need} is not in the folder` });
    }
    // Image sizes: files beside the scene, and images inside a GLB's binary chunk.
    const sizes: Array<{ at: string; size: { width: number; height: number } | undefined }> = [];
    (read.json.images ?? []).forEach((im, i) => {
      if (typeof im.uri === 'string' && !im.uri.startsWith('data:')) {
        const f = files.get(base + decodeURIComponent(im.uri));
        if (f) sizes.push({ at: `images[${i}]`, size: imageSize(f) });
      } else if (typeof (im as { bufferView?: unknown }).bufferView === 'number' && read.bin) {
        const bv = (read.json['bufferViews'] as Array<{ byteOffset?: number; byteLength?: number }> | undefined)?.[(im as { bufferView: number }).bufferView];
        if (bv) sizes.push({ at: `images[${i}]`, size: imageSize(read.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + (bv.byteLength ?? 0))) });
      }
    });
    // Effects (S6.01): each a file the pinned runtime reads, with every file it names beside it.
    for (const e of scene.effects) {
      const data = files.get(e.path);
      if (!data) continue;
      const problem = (code: string, message: string, severity: Severity = 'error'): void => void problems.push({ code, severity, file: e.path, at: `nodes[${e.node}]`, message });
      let fx: EffectFile;
      try {
        fx = readEffectFile(data);
      } catch (err) {
        problem('effect-invalid', err instanceof EffectFormatError ? err.problems.join('; ') : 'not an Effekseer effect');
        continue;
      }
      if (fx.version > EFFECT_RUNTIME.bodyVersion) {
        problem('effect-too-new', `saved by Effekseer ${editorVersion(fx.version)}, newer than the platform's runtime (Effekseer ${EFFECT_RUNTIME.effekseer}): save it with Effekseer 1.8 or older`);
        continue;
      }
      if (fx.resources.materials.length) problem('effect-materials', `uses material files (${fx.resources.materials.join(', ')}): creator shaders, which worlds cannot use yet`);
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : '';
      for (const { path, kind } of effectFiles(fx)) {
        if (kind === 'materials') continue;
        const f = files.get(effectPath(dir + path));
        if (!f) problem('effect-file-missing', `the effect needs ${path}, which is not beside it`, kind === 'sounds' ? 'warning' : 'error');
        else if ((kind === 'colorImages' || kind === 'normalImages' || kind === 'distortionImages') && !(f[0] === 0x89 && f[1] === 0x50 && f[2] === 0x4e && f[3] === 0x47)) problem('effect-texture', `${path}: the platform's runtime takes PNG textures`);
      }
    }
    for (const { at, size } of sizes) {
      if (!size) continue;
      const side = Math.max(size.width, size.height);
      if (side > LIMITS.textureSide) problems.push({ code: 'texture-too-large', severity: 'error', file: entry.file, at, message: `${size.width}×${size.height}: a texture is at most ${LIMITS.textureSide} px a side` });
      else if (side > LIMITS.textureSideWarning) problems.push({ code: 'texture-large', severity: 'warning', file: entry.file, at, message: `${size.width}×${size.height}: above ${LIMITS.textureSideWarning} px, weak laptops run short of memory` });
    }
    scenes.push(scene);
  }
  if (scenes[0] && scenes[0].spawns.length === 0 && manifest.scenes[0]?.file === scenes[0].file) {
    problems.push({ code: 'no-spawn', severity: 'error', file: scenes[0].file, at: 'nodes', message: 'the first scene needs at least one OMI_spawn_point' });
  }
  // Several scenes may each pass and still be too much together.
  const total = scenes.reduce((n, s) => n + s.triangles, 0);
  if (scenes.length > 1 && total > LIMITS.triangles) problems.push({ code: 'too-many-triangles', severity: 'error', file: '', at: '', message: `${total} triangles in all scenes: at most ${LIMITS.triangles}` });
  return { ok: !problems.some((p) => p.severity === 'error'), manifest, scenes, problems, bytes };
}
