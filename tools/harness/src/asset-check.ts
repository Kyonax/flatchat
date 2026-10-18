// SPDX-License-Identifier: MPL-2.0
// Provenance and the licence gate (Track P's P.07, rr-014). Every asset in the repository (a
// model, an image, a sound, a font, an animation) has a provenance record in kits/provenance/,
// and the record says where it came from under a licence the project accepts: CC0, CC BY, or the
// owner's own. An asset made by others also names the archived copy of its licence page, and a
// CC BY one has its credit line in CREDITS.md. Anything else fails, so an unlicensed or
// uncredited file never ships.
//
// A record is a JSON file (one per asset or per set of files made together):
//   files        repository paths, * and ** allowed: the files it covers
//   title        what they are
//   creator      the person or group who made them (never the platform they were found on)
//   licence      CC0-1.0, CC-BY-4.0, CC-BY-3.0 or LicenseRef-Owner (the owner's own)
//   made         for the project's own work: the script or the act that made it, or
//   source       for others' work: the URL it came from, with
//   retrieved    the date it was fetched (YYYY-MM-DD),
//   licencePage  { url, archived }: the licence page and its saved copy in the repository,
//   changes      what was changed, and
//   credit       for CC BY: the credit line, which CREDITS.md must carry word for word
//   ai           (optional) { tool, terms, termsDate }: an AI tool used, and its terms then
//   depicts      (optional) others' works an image shows, with their terms
//
//   node tools/harness/src/asset-check.ts [--root DIR]     exit 0 = every asset covered, 1 = problems
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PROVENANCE_DIR = 'kits/provenance';
export const LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0', 'LicenseRef-Owner'] as const;
/** What counts as an asset: models, animations, images, textures, sounds, fonts and video. */
export const ASSET_EXTENSIONS = new Set([
  'glb', 'gltf', 'vrm', 'vrma', 'bin', 'blend', 'fbx', 'obj', 'mtl', 'dae', 'bvh', 'usd', 'usda', 'usdz',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'icns', 'ktx2', 'basis', 'dds', 'hdr', 'exr', 'tga',
  'ogg', 'oga', 'wav', 'mp3', 'flac', 'opus', 'm4a',
  'ttf', 'otf', 'woff', 'woff2',
  'mp4', 'webm',
]);
const SKIP_DIRS = new Set(['node_modules', 'out', 'release', 'dist', 'build', 'coverage', '.cache', '.git']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https:\/\/\S+$/;

export function isAsset(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') && ASSET_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** A files pattern as a regular expression: ** any folders, * anything within one name. */
export function patternToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += pattern[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The repository's files a publication would carry: tracked, and new ones git does not ignore. */
export function repositoryFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter((f) => f && existsSync(join(root, f)));
  } catch {
    // No git (an unpacked download): walk the folders instead.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
        } else files.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    };
    walk(root);
    return files;
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every problem with the assets in `files` (repository paths) and the records under `root`. */
export function checkAssets(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const assets = files.filter(isAsset).sort();
  const dir = join(root, PROVENANCE_DIR);
  const records: Array<{ name: string; r: Json }> = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      try {
        records.push({ name, r: JSON.parse(readFileSync(join(dir, name), 'utf8')) as Json });
      } catch (err) {
        problems.push(`${PROVENANCE_DIR}/${name}: not JSON (${(err as Error).message})`);
      }
    }
  }
  const credits = existsSync(join(root, 'CREDITS.md')) ? readFileSync(join(root, 'CREDITS.md'), 'utf8') : '';
  const covered = new Map<string, string>();
  for (const { name, r } of records) {
    const at = `${PROVENANCE_DIR}/${name}`;
    const patterns = Array.isArray(r['files']) ? r['files'].filter(str) : [];
    if (patterns.length === 0) problems.push(`${at}: no files`);
    for (const p of patterns) {
      const re = patternToRegExp(p);
      const hits = assets.filter((a) => re.test(a));
      if (hits.length === 0) problems.push(`${at}: "${p}" matches no asset`);
      for (const h of hits) {
        const before = covered.get(h);
        if (before && before !== name) problems.push(`${h}: covered by both ${PROVENANCE_DIR}/${before} and ${at}`);
        covered.set(h, name);
      }
    }
    for (const field of ['title', 'creator']) if (!str(r[field])) problems.push(`${at}: no ${field}`);
    const licence = r['licence'];
    if (!(LICENCES as readonly unknown[]).includes(licence)) problems.push(`${at}: licence ${JSON.stringify(licence)} is not one the project accepts (${LICENCES.join(', ')})`);
    const own = str(r['made']);
    const theirs = str(r['source']);
    if (own === theirs) problems.push(`${at}: give either "made" (the project's own work) or "source" (others' work), not ${own ? 'both' : 'neither'}`);
    if (theirs) {
      if (!URL_RE.test(r['source'] as string)) problems.push(`${at}: source is not an https URL`);
      if (!(typeof r['retrieved'] === 'string' && DATE.test(r['retrieved']))) problems.push(`${at}: no retrieved date (YYYY-MM-DD)`);
      if (!str(r['changes'])) problems.push(`${at}: no changes (write "none" if there were none)`);
      const page = (r['licencePage'] ?? {}) as Json;
      if (!(typeof page['url'] === 'string' && URL_RE.test(page['url']))) problems.push(`${at}: no licencePage.url`);
      const archived = page['archived'];
      if (!str(archived)) problems.push(`${at}: no licencePage.archived (a saved copy of the licence page in the repository)`);
      else if (!existsSync(join(root, archived)) || !statSync(join(root, archived)).isFile()) problems.push(`${at}: licencePage.archived ${archived} is not a file in the repository`);
      if (typeof licence === 'string' && licence.startsWith('CC-BY')) {
        if (!str(r['credit'])) problems.push(`${at}: a CC BY asset needs its credit line`);
        else if (!credits.includes(r['credit'])) problems.push(`${at}: its credit line is not in CREDITS.md: "${r['credit']}"`);
      }
    }
    if (r['ai'] !== undefined) {
      const ai = (r['ai'] ?? {}) as Json;
      if (!str(ai['tool']) || !(typeof ai['terms'] === 'string' && URL_RE.test(ai['terms'])) || !(typeof ai['termsDate'] === 'string' && DATE.test(ai['termsDate']))) {
        problems.push(`${at}: ai needs tool, terms (an https URL) and termsDate (YYYY-MM-DD)`);
      }
    }
  }
  for (const a of assets) if (!covered.has(a)) problems.push(`${a}: no provenance record in ${PROVENANCE_DIR}/`);
  return problems;
}

function main(): number {
  let root: string | undefined;
  try {
    ({ values: { root } } = parseArgs({ options: { root: { type: 'string' } } }));
  } catch (err) {
    console.error(`asset-check: ${(err as Error).message}`);
    return 2;
  }
  const repo = root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files = repositoryFiles(repo);
  const problems = checkAssets(repo, files);
  if (problems.length === 0) {
    console.log(`asset-check: OK · ${files.filter(isAsset).length} asset(s), each with its provenance record`);
    return 0;
  }
  console.log(`asset-check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
