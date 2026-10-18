// SPDX-License-Identifier: MPL-2.0
// Effect uploads into the platform's bundle (S6.01, Q-M8, Q-M9): one effect made in Effekseer's
// editor, read without running it (packages/content's readEffectFile), its files checked, bundled
// with exactly what it names (FCFX), then played in the pinned runtime by the dry run and held to
// the limits for where it plays. Everything a client will ever load of it is in the bundle, so
// nothing it names can be left out or swapped later.
//
// An upload is one of these:
//   - an Effekseer file (.efkefc, or an older .efk) that names no other files;
//   - an Effekseer package (.efkpkg: a zip with metafile.json, the editor's export);
//   - a zip with one effect in it and its files at the paths the effect names, relative to it;
//   - the platform's own bundle (FCFX), which may carry the item's declaration (the starters).
import { unzipSync } from 'fflate';
import {
  EFFECT_LIMITS,
  EFFECT_RUNTIME,
  EFFECT_SOURCE_LIMIT,
  type EffectBundle,
  editorVersion,
  type EffectFit,
  effectFiles,
  effectFitProblems,
  EffectFormatError,
  effectPath,
  imageSize,
  readBundle,
  readEffectFile,
  writeBundle,
  bundlePathOf,
} from '@flatchat/content';
import { DryRunFailed } from '@flatchat/effects';
import { createHash } from 'node:crypto';
import { dryRun, type DryRunner } from './dry-run.ts';

export class EffectError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const EFFECT_FILE = /\.(efkefc|efk)$/i;
const PNG = (b: Uint8Array): boolean => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
/** A zip's entries at most, and the most any one may unpack to. */
const ZIP_ENTRIES = 256;
const ZIP_ENTRY_BYTES = EFFECT_SOURCE_LIMIT;

/** What an upload holds: its effect, every file beside it by path relative to the effect, and the
 *  declaration a bundle carries. Throws EffectError when it is none of the four. */
export function effectUpload(bytes: Uint8Array): EffectBundle {
  if (bytes.length > EFFECT_SOURCE_LIMIT) throw new EffectError([`an effect upload is ${EFFECT_SOURCE_LIMIT / 1048576} MB at most`]);
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head === 'FCFX') {
    try {
      return readBundle(bytes);
    } catch (err) {
      throw new EffectError(err instanceof EffectFormatError ? err.problems : [String(err)]);
    }
  }
  if (head === 'EFKE') return { main: 'effect.efkefc', files: new Map([['effect.efkefc', bytes]]) };
  if (head === 'SKFE') return { main: 'effect.efk', files: new Map([['effect.efk', bytes]]) };
  if (head !== 'PK\x03\x04') throw new EffectError(['not an effect: give an Effekseer file (.efkefc or .efk), an Effekseer package (.efkpkg) or a zip with one effect in it']);
  let entries: Record<string, Uint8Array>;
  let seen = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        seen += 1;
        if (seen > ZIP_ENTRIES || f.originalSize > ZIP_ENTRY_BYTES) throw new EffectError([`the zip holds more than ${ZIP_ENTRIES} files or a file over ${ZIP_ENTRY_BYTES / 1048576} MB`]);
        return !f.name.endsWith('/') && !f.name.startsWith('__MACOSX/');
      },
    });
  } catch (err) {
    if (err instanceof EffectError) throw err;
    throw new EffectError([`the zip does not read: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`]);
  }
  let total = 0;
  for (const b of Object.values(entries)) total += b.length;
  if (total > EFFECT_SOURCE_LIMIT) throw new EffectError([`the zip unpacks to more than ${EFFECT_SOURCE_LIMIT / 1048576} MB`]);
  const meta = entries['metafile.json'];
  if (meta) return packageUpload(entries, meta);
  const effects = Object.keys(entries).filter((n) => EFFECT_FILE.test(n));
  if (effects.length !== 1) throw new EffectError([effects.length ? `the zip holds ${effects.length} effects: upload one effect at a time` : 'the zip holds no effect (.efkefc or .efk)']);
  return relativeTo(effects[0]!, entries);
}

/** The zip's files by path relative to the effect's folder. */
function relativeTo(effect: string, entries: Record<string, Uint8Array>): EffectBundle {
  const dir = effectPath(effect).split('/').slice(0, -1);
  const files = new Map<string, Uint8Array>();
  for (const [name, b] of Object.entries(entries)) {
    const parts = effectPath(name).split('/');
    let common = 0;
    while (common < dir.length && common < parts.length - 1 && parts[common] === dir[common]) common++;
    const rel = [...Array<string>(dir.length - common).fill('..'), ...parts.slice(common)].join('/');
    files.set(effectPath(rel), b);
  }
  return { main: effectPath(effect).split('/').pop()!, files };
}

/** An Effekseer package: metafile.json names each file and its type; a model's or a curve's data
 *  is its first dependency (as EffekseerForWeb's own loader reads packages). */
function packageUpload(entries: Record<string, Uint8Array>, meta: Uint8Array): EffectBundle {
  let listed: { files?: Record<string, { type?: unknown; dependencies?: unknown }> };
  try {
    listed = JSON.parse(new TextDecoder().decode(meta)) as typeof listed;
  } catch {
    throw new EffectError(["the package's metafile.json does not read"]);
  }
  const files = new Map<string, Uint8Array>();
  let main: string | undefined;
  for (const [path, info] of Object.entries(listed.files ?? {})) {
    const data = entries[path];
    if (!data) continue;
    const deps = Array.isArray(info.dependencies) ? info.dependencies.filter((d): d is string => typeof d === 'string') : [];
    if (info.type === 'Effect') {
      if (main !== undefined) throw new EffectError(['the package holds more than one effect: upload one effect at a time']);
      main = effectPath(path);
      files.set(main, data);
    } else if (info.type === 'Curve' && deps[0] && entries[deps[0]]) files.set(effectPath(`${path}.efkcurve`), entries[deps[0]]!);
    else if (info.type === 'Model' && deps[0] && entries[deps[0]]) files.set(effectPath(path), entries[deps[0]]!);
    else {
      files.set(effectPath(path), data);
      for (const d of deps) if (entries[d]) files.set(effectPath(d), entries[d]!);
    }
  }
  if (main === undefined) throw new EffectError(['the package holds no effect']);
  return relativeTo(main, Object.fromEntries(files));
}

export interface EffectOptions {
  where: 'avatar' | 'world';
  /** The scale it plays at (the declaration's). */
  scale: number;
  /** A dry runner with a deadline (a worker thread); without one the dry run runs in this thread
   *  (the core's sandbox, which allows no threads, bounds the whole conversion instead). */
  runner?: DryRunner;
}

export interface EffectResult {
  bundle: Uint8Array;
  fit: EffectFit;
  warnings: string[];
}

/** Checks, bundles and dry-runs the effect in an upload. Throws EffectError with every problem. */
export async function convertEffect(upload: Uint8Array | EffectBundle, o: EffectOptions): Promise<EffectResult> {
  const given = upload instanceof Uint8Array ? effectUpload(upload) : upload;
  const main = given.files.get(given.main)!;
  let file;
  try {
    file = readEffectFile(main);
  } catch (err) {
    throw new EffectError(err instanceof EffectFormatError ? err.problems : [String(err)]);
  }
  if (file.version > EFFECT_RUNTIME.bodyVersion) {
    throw new EffectError([`the effect was saved by Effekseer ${editorVersion(file.version)}, newer than the platform's runtime (Effekseer ${EFFECT_RUNTIME.effekseer}): save it with Effekseer 1.8 or older`]);
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  if (file.resources.materials.length) problems.push(`the effect uses material files (${file.resources.materials.join(', ')}): those are creator shaders, which the platform does not take yet; use Effekseer's built-in materials`);
  const files = new Map<string, Uint8Array>([[given.main, main]]);
  let textures = 0;
  let pixels = 0;
  let models = 0;
  let sounds = 0;
  for (const { path, kind } of effectFiles(file)) {
    if (kind === 'materials') continue;
    const found = bundlePathOf(given.files.keys(), path);
    if (kind === 'sounds') {
      sounds += 1;
      if (o.where === 'avatar') continue;
      if (found === undefined) {
        warnings.push(`the effect's sound ${path} is not in the upload: it plays without it`);
        continue;
      }
      files.set(path, given.files.get(found)!);
      continue;
    }
    if (found === undefined) {
      problems.push(`the effect needs ${path}, which the upload does not have`);
      continue;
    }
    const bytes = given.files.get(found)!;
    if (kind === 'colorImages' || kind === 'normalImages' || kind === 'distortionImages') {
      const size = imageSize(bytes);
      if (!PNG(bytes) || !size) {
        problems.push(`${path}: the platform's runtime takes PNG textures; save it as a PNG`);
        continue;
      }
      if (Math.max(size.width, size.height) > EFFECT_LIMITS.textureSide) problems.push(`${path} is ${size.width}×${size.height}: ${EFFECT_LIMITS.textureSide} px a side at most`);
      textures += 1;
      pixels += size.width * size.height;
    } else if (kind === 'models') models += 1;
    files.set(path, bytes);
  }
  if (files.size > EFFECT_LIMITS.files) problems.push(`the effect uses ${files.size} files; ${EFFECT_LIMITS.files} at most`);
  if (sounds && o.where === 'avatar') warnings.push("its sounds do not play: an avatar's effects make no sound");
  if (file.resources.distortionImages.length) warnings.push('its distortion parts do not draw: no client draws distortion');
  if (problems.length) throw new EffectError(problems);

  const bundle: EffectBundle = { main: given.main, files };
  let run;
  try {
    run = o.runner ? await o.runner.run(bundle, { scale: o.scale }) : await dryRun(bundle, { scale: o.scale });
  } catch (err) {
    throw new EffectError([err instanceof DryRunFailed ? `the effect does not play: ${err.message}` : `the dry run failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`]);
  }
  if (run.missing.length) throw new EffectError([`the effect asked for ${run.missing.join(', ')}, which the upload does not have`]);
  const bytes = writeBundle(bundle);
  const fit: EffectFit = {
    file: sha256(bytes),
    bytes: bytes.length,
    version: file.version,
    peak: run.peak,
    frames: run.frames,
    textures,
    texturePixels: pixels,
    models,
    distortion: file.resources.distortionImages.length > 0,
    sounds,
    scale: o.scale,
    updateUs: run.updateUs,
  };
  const over = effectFitProblems(fit, o.where);
  if (over.length) throw new EffectError(over);
  return { bundle: bytes, fit, warnings };
}
