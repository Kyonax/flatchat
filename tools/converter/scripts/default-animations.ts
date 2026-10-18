// SPDX-License-Identifier: MPL-2.0
// Writes the default clips (Track P's P.05) into kits/animations/. Each library is fetched once (or
// taken from --downloads) and checked against its pinned SHA-256. Each clip is converted to VRMA by
// the animation converter, measured on the three standard bodies against P.05's lines, and listed in
// kits/animations/clips.json with what it measured (a walking clip's ground speed for a metre of
// leg, which the client matches its pace to). The libraries' licences are saved beside the
// provenance records. If any clip fails a line, it says which and writes nothing.
//
//   node tools/converter/scripts/default-animations.ts [--downloads DIR]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BODY_KITS } from '@flatchat/content';
import { readAvatarLevel } from '../src/avatar/convert.ts';
import { bodyOf, readClip } from '../src/animation/checks.ts';
import { ANIMATION_CONVERTER_VERSION, convertAnimation } from '../src/animation/convert.ts';
import { CLIP_SOURCES, type ClipSource, clipReport, DEFAULT_CLIPS } from '../src/animation/defaults.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'kits', 'animations');
const ARCHIVE = join(ROOT, 'kits', 'provenance', 'archive');
/** The libraries' licences, as they read at the pinned versions. */
const LICENCES = {
  mesh2motion: { url: 'https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/653a9698f5f315523072f1c3ff3496100401317b/LICENSE-CC0.MD', sha256: '52fec1c484df708c16b4c27b2bf0d7f0d3994105c57adc4b9e6f95bcfd9de65f', file: 'mesh2motion-LICENSE-CC0.md' },
  quaternius: { entry: 'Animation Library[Standard]/License.txt', file: 'quaternius-ual-License.txt' },
} as const;

const { values } = parseArgs({ options: { downloads: { type: 'string', default: join(homedir(), '.cache', 'flatchat', 'animations') } } });
const downloads = values.downloads;
mkdirSync(downloads, { recursive: true });
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function fetched(url: string, sha256: string, name: string): Promise<Uint8Array> {
  const file = join(downloads, name);
  if (!existsSync(file)) {
    process.stdout.write(`fetching ${url}\n`);
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    writeFileSync(`${file}.part`, new Uint8Array(await r.arrayBuffer()));
    renameSync(`${file}.part`, file);
  }
  const bytes = new Uint8Array(readFileSync(file));
  if (sha(bytes) !== sha256) throw new Error(`${name}: SHA-256 ${sha(bytes)}, not the pinned ${sha256}`);
  return bytes;
}

const unzipped = (zip: string, entry: string): Uint8Array => {
  // unzip reads its names as patterns: the pack's brackets are no character class.
  const r = spawnSync('unzip', ['-p', zip, entry.replace(/[[\]*?]/g, (c) => `\\${c}`)], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`unzip ${entry}: ${r.stderr.toString().slice(0, 200)}`);
  return new Uint8Array(r.stdout);
};

const libraries = new Map<ClipSource, Uint8Array>();
libraries.set('mesh2motion', await fetched(CLIP_SOURCES.mesh2motion.url, CLIP_SOURCES.mesh2motion.sha256, 'mesh2motion-human-base-animations.glb'));
libraries.set('mesh2motion-addon', await fetched(CLIP_SOURCES['mesh2motion-addon'].url, CLIP_SOURCES['mesh2motion-addon'].sha256, 'mesh2motion-human-addon-animations.glb'));
await fetched(CLIP_SOURCES.quaternius.url, CLIP_SOURCES.quaternius.sha256, 'quaternius-ual-standard.zip');
libraries.set('quaternius', unzipped(join(downloads, 'quaternius-ual-standard.zip'), CLIP_SOURCES.quaternius.entry));

const bodies = [];
for (const b of BODY_KITS) {
  const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(ROOT, 'kits', 'bodies', b, `${b}.vrm`))));
  bodies.push([b, bodyOf(doc, data)] as const);
}

const round = (x: number, places: number): number => Number(x.toFixed(places));
const files = new Map<string, Uint8Array>();
const listed = [];
const failed: string[] = [];
for (const c of DEFAULT_CLIPS) {
  const r = await convertAnimation(libraries.get(c.from)!, { clip: c.clip, name: c.name, use: c.kind === 'gesture' && c.loop ? 'dance' : 'emote' });
  const vrma = r.files.get(r.manifest.file)!;
  const report = clipReport(c, await readClip(vrma), bodies);
  for (const p of report.problems) failed.push(`${c.name}: ${p}`);
  files.set(`${c.name}.vrma`, vrma);
  listed.push({
    name: c.name,
    file: `${c.name}.vrma`,
    sha256: sha(vrma),
    bytes: vrma.length,
    from: c.from,
    clip: c.clip,
    kind: c.kind,
    loop: c.loop,
    seconds: round(r.manifest.duration, 3),
    seam: round(report.seam, 2),
    ...(report.slide !== undefined ? { slide: round(report.slide, 4) } : {}),
    ...(report.speedPerLeg !== undefined ? { speedPerLeg: round(report.speedPerLeg, 4) } : {}),
    ...(report.clearance !== undefined ? { clearance: round(report.clearance, 4) } : {}),
  });
}
if (failed.length > 0) {
  process.stderr.write(`${failed.join('\n')}\n`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const [name, bytes] of files) writeFileSync(join(OUT, name), bytes);
writeFileSync(join(OUT, 'clips.json'), `${JSON.stringify({ made: 'node tools/converter/scripts/default-animations.ts', converter: ANIMATION_CONVERTER_VERSION, sources: CLIP_SOURCES, clips: listed }, null, 1)}\n`);
writeFileSync(join(ARCHIVE, LICENCES.mesh2motion.file), await fetched(LICENCES.mesh2motion.url, LICENCES.mesh2motion.sha256, 'mesh2motion-LICENSE-CC0.MD'));
writeFileSync(join(ARCHIVE, LICENCES.quaternius.file), unzipped(join(downloads, 'quaternius-ual-standard.zip'), LICENCES.quaternius.entry));
process.stdout.write(`${listed.length} clips in ${OUT}\n`);
