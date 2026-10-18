// SPDX-License-Identifier: Apache-2.0
// An effect's bundle checked without playing it (S6.01): the rules every effect meets before its
// dry run. The converter checks an upload with it; the client checks each of a world's effects with
// it before measuring them, because a world comes from its host and a host is not trusted (one
// could slip in a newer editor's file, material files, which are creator shaders, or a texture
// bigger than any client should decode). Reading only: no runtime, no Node.
import { bundlePathOf, editorVersion, EFFECT_LIMITS, EFFECT_RUNTIME, type EffectBundle, type EffectFile, effectFiles, EffectFormatError, readEffectFile } from './effect.ts';
import { imageSize } from './image-size.ts';

const PNG = (b: Uint8Array): boolean => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export interface EffectCheck {
  file: EffectFile;
  /** Exactly what the runtime will ask for: the effect and each file it names, by the path it
   *  names (sounds only for a world). */
  bundle: EffectBundle;
  /** Any problem refuses the effect. */
  problems: string[];
  warnings: string[];
  textures: number;
  texturePixels: number;
  models: number;
  sounds: number;
}

/** Reads and checks an effect's bundle for where it plays. Throws EffectFormatError when the effect
 *  does not read; a newer editor's file comes back with that one problem. */
export function checkEffectBundle(given: EffectBundle, where: 'avatar' | 'world'): EffectCheck {
  const main = given.files.get(given.main);
  if (!main) throw new EffectFormatError(['the bundle does not hold its effect']);
  const file = readEffectFile(main);
  const files = new Map<string, Uint8Array>([[given.main, main]]);
  const check: EffectCheck = { file, bundle: { main: given.main, files }, problems: [], warnings: [], textures: 0, texturePixels: 0, models: 0, sounds: 0 };
  if (file.version > EFFECT_RUNTIME.bodyVersion) {
    check.problems.push(`the effect was saved by Effekseer ${editorVersion(file.version)}, newer than the platform's runtime (Effekseer ${EFFECT_RUNTIME.effekseer}): save it with Effekseer 1.8 or older`);
    return check;
  }
  if (file.resources.materials.length) check.problems.push(`the effect uses material files (${file.resources.materials.join(', ')}): those are creator shaders, which the platform does not take yet; use Effekseer's built-in materials`);
  for (const { path, kind } of effectFiles(file)) {
    if (kind === 'materials') continue;
    const found = bundlePathOf(given.files.keys(), path);
    if (kind === 'sounds') {
      check.sounds += 1;
      if (where === 'avatar') continue;
      if (found === undefined) {
        check.warnings.push(`the effect's sound ${path} is not in the upload: it plays without it`);
        continue;
      }
      files.set(path, given.files.get(found)!);
      continue;
    }
    if (found === undefined) {
      check.problems.push(`the effect needs ${path}, which the upload does not have`);
      continue;
    }
    const bytes = given.files.get(found)!;
    if (kind === 'colorImages' || kind === 'normalImages' || kind === 'distortionImages') {
      const size = imageSize(bytes);
      if (!PNG(bytes) || !size) {
        check.problems.push(`${path}: the platform's runtime takes PNG textures; save it as a PNG`);
        continue;
      }
      if (Math.max(size.width, size.height) > EFFECT_LIMITS.textureSide) check.problems.push(`${path} is ${size.width}×${size.height}: ${EFFECT_LIMITS.textureSide} px a side at most`);
      check.textures += 1;
      check.texturePixels += size.width * size.height;
    } else if (kind === 'models') check.models += 1;
    files.set(path, bytes);
  }
  if (files.size > EFFECT_LIMITS.files) check.problems.push(`the effect uses ${files.size} files; ${EFFECT_LIMITS.files} at most`);
  if (check.sounds && where === 'avatar') check.warnings.push("its sounds do not play: an avatar's effects make no sound");
  if (file.resources.distortionImages.length) check.warnings.push('its distortion parts do not draw: no client draws distortion');
  return check;
}
