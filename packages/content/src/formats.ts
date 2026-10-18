// SPDX-License-Identifier: Apache-2.0
// What an uploaded model is (S5.08, Q-M2, Q-M11), known by its first bytes, never by its name. VRM
// and GLB the converters read as they are; DAE (Collada) the converter turns into a GLB itself, by
// assimp in WebAssembly; FBX, OBJ and .blend the core's headless Blender turns into a GLB first
// (tools/blender/convert/to-glb.py, DR-15), since Blender is what reads them. An effect (S6.01) is
// an Effekseer file (.efkefc, .efk), the platform's own bundle, or a zip (an Effekseer package,
// .efkpkg, or any zip) with an effect in it. Shared by the converter, the core and the client, so
// all three agree on what a file is.
import type { ModelFrom } from './avatar.ts';

/** The file names a model upload may have, for the upload dialogs. */
export const MODEL_EXTENSIONS = ['vrm', 'glb', 'fbx', 'obj', 'dae', 'blend'] as const;
/** The file names an effect upload may have. */
export const EFFECT_EXTENSIONS = ['efkefc', 'efk', 'efkpkg', 'zip'] as const;
/** The formats only headless Blender reads. */
export const BLENDER_FORMATS: readonly ModelFrom[] = ['fbx', 'obj', 'blend'];
/** Each format as a sentence names it ("the FBX file"). */
export const MODEL_FORMAT_NAMES: Record<ModelFrom, string> = { fbx: 'FBX', obj: 'OBJ', dae: 'DAE', blend: '.blend' };

export type UploadFormat = 'gltf' | ModelFrom | 'effect' | 'unknown';

/** The names in a zip's central directory, read from its end (nothing is inflated); empty when it
 *  does not read as a zip. */
export function zipNames(bytes: Uint8Array): string[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record: within the last 64 KiB plus its own 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const names: string[] = [];
  for (let n = 0; n < count && n < 4096; n++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50) return names;
    const len = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    if (at + 46 + len > bytes.length) return names;
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + len)));
    at += 46 + len + extra + comment;
  }
  return names;
}

export function uploadFormat(bytes: Uint8Array): UploadFormat {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512));
  if (bytes.length >= 12 && head.startsWith('glTF')) return 'gltf';
  if (head.startsWith('EFKE') || head.startsWith('SKFE') || head.startsWith('FCFX')) return 'effect';
  if (head.startsWith('PK\x03\x04') && zipNames(bytes).some((n) => /\.(efkefc|efk)$/i.test(n) || n === 'metafile.json')) return 'effect';
  if (head.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX/.test(head)) return 'fbx';
  // .blend: "BLENDER", or compressed (zstd since Blender 3.0, gzip before).
  if (head.startsWith('BLENDER') || (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) return 'blend';
  if (/^(ï»¿)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<COLLADA[\s>]/.test(head)) return 'dae';
  // OBJ: text whose first statement is one of OBJ's own.
  const first = head
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (first !== undefined && /^(v|vt|vn|vp|f|o|g|s|mtllib|usemtl|l)\s/.test(first)) return 'obj';
  return 'unknown';
}
