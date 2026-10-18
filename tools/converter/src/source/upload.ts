// SPDX-License-Identifier: MPL-2.0
// An upload as the GLB a converter reads (S5.08, Q-M2, Q-M11). A VRM or a GLB is read as it is; a
// DAE is turned into one here, by assimp (dae.ts); an FBX, an OBJ or a .blend only the core's
// headless Blender reads (tools/blender/convert/to-glb.py): the core hands the converter the GLB
// Blender wrote with the upload's own SHA-256, size and format, and those go in the manifest.
import { createHash } from 'node:crypto';
import { BLENDER_FORMATS, MODEL_FORMAT_NAMES, type ModelFrom, uploadFormat } from '@flatchat/content';
import { DaeError, daeToGlb } from './dae.ts';

/** The upload a GLB was made from. */
export interface UploadSource {
  sha256: string;
  bytes: number;
  from: ModelFrom;
}

export class UploadError extends Error {}

/** The GLB to convert, and the source its manifest names. `given` says `bytes` is the GLB the
 *  core's Blender made from that upload. */
export async function uploadGlb(bytes: Uint8Array, given?: UploadSource): Promise<{ glb: Uint8Array; source: { sha256: string; bytes: number; from?: ModelFrom } }> {
  const format = uploadFormat(bytes);
  if (given) {
    if (format !== 'gltf') throw new UploadError(`what Blender wrote from the ${MODEL_FORMAT_NAMES[given.from]} file is not a GLB`);
    return { glb: bytes, source: given };
  }
  const own = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  if (format === 'dae') {
    try {
      return { glb: await daeToGlb(bytes), source: { ...own, from: 'dae' } };
    } catch (err) {
      throw new UploadError(err instanceof DaeError ? err.message : `assimp failed on the Collada file: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, { cause: err });
    }
  }
  if (format === 'fbx' || format === 'obj' || format === 'blend') throw new UploadError(`the ${MODEL_FORMAT_NAMES[format]} file is read by headless Blender on the core first (tools/blender/convert/to-glb.py)`);
  return { glb: bytes, source: own };
}

/** `--from` and `--source SHA256:BYTES` as the core passes them to a converter program: undefined
 *  when neither is given, false when they do not read. */
export function sourceArgs(from: string | undefined, source: string | undefined): UploadSource | undefined | false {
  if (from === undefined && source === undefined) return undefined;
  const m = /^([0-9a-f]{64}):(\d{1,12})$/.exec(source ?? '');
  if (!m || !BLENDER_FORMATS.includes(from as ModelFrom)) return false;
  return { sha256: m[1]!, bytes: Number(m[2]), from: from as ModelFrom };
}
