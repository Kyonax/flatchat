// SPDX-License-Identifier: MPL-2.0
// Writes the default sounds (Track P's P.06) into kits/sounds/: recorded footsteps and interface
// sounds from two of Kenney's CC0 packs, which the client carries and plays in place of the noise
// and tones S2.14 made on the spot. Each pack is fetched once (or taken from --downloads) and
// checked against its pinned SHA-256; the sounds are copied out byte for byte, listed in
// kits/sounds/sounds.json with where each came from, and the packs' licence files are saved beside
// the provenance records.
//
//   node tools/converter/scripts/default-sounds.ts [--downloads DIR]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'kits', 'sounds');
const ARCHIVE = join(ROOT, 'kits', 'provenance', 'archive');

/** The packs, pinned (checked 2026-10-18), and their licence files inside. */
export const SOUND_PACKS = {
  rpg: {
    what: "Kenney's 50 RPG sound effects (RPG sounds)",
    page: 'https://opengameart.org/content/50-rpg-sound-effects',
    url: 'https://opengameart.org/sites/default/files/RPGsounds_Kenney.zip',
    sha256: '3ae398ad63e293f9c450bda22d5d81c3af69c74df66fc1400f33c012c0bbc231',
    licence: { entry: 'license.txt', file: 'kenney-rpg-sounds-license.txt' },
  },
  interface: {
    what: "Kenney's Interface Sounds 1.0",
    page: 'https://opengameart.org/content/interface-sounds',
    url: 'https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip',
    sha256: 'f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232',
    licence: { entry: 'License.txt', file: 'kenney-interface-sounds-License.txt' },
  },
} as const;
type Pack = keyof typeof SOUND_PACKS;

/** What the client plays: a button's click, someone arriving, a chat line, and ten footsteps. */
export const DEFAULT_SOUNDS: ReadonlyArray<{ name: string; kind: 'ui' | 'footstep'; from: Pack; entry: string }> = [
  { name: 'click', kind: 'ui', from: 'interface', entry: 'Audio/click_001.ogg' },
  { name: 'chime', kind: 'ui', from: 'interface', entry: 'Audio/confirmation_001.ogg' },
  { name: 'blip', kind: 'ui', from: 'interface', entry: 'Audio/pluck_001.ogg' },
  ...Array.from({ length: 10 }, (_, k) => ({ name: `footstep${k}`, kind: 'footstep' as const, from: 'rpg' as const, entry: `OGG/footstep0${k}.ogg` })),
];

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { downloads: { type: 'string', default: join(homedir(), '.cache', 'flatchat', 'sounds') } } });
  const downloads = values.downloads;
  mkdirSync(downloads, { recursive: true });
  const zips = new Map<Pack, string>();
  for (const [pack, p] of Object.entries(SOUND_PACKS) as Array<[Pack, (typeof SOUND_PACKS)[Pack]]>) {
    const file = join(downloads, p.url.split('/').pop()!);
    if (!existsSync(file)) {
      process.stdout.write(`fetching ${p.url}\n`);
      const r = await fetch(p.url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`${p.url} answered ${r.status}`);
      writeFileSync(`${file}.part`, new Uint8Array(await r.arrayBuffer()));
      renameSync(`${file}.part`, file);
    }
    const got = sha(new Uint8Array(readFileSync(file)));
    if (got !== p.sha256) throw new Error(`${file}: SHA-256 ${got}, not the pinned ${p.sha256}`);
    zips.set(pack, file);
  }
  const unzipped = (pack: Pack, entry: string): Uint8Array => {
    const r = spawnSync('unzip', ['-p', zips.get(pack)!, entry], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || r.stdout.length === 0) throw new Error(`unzip ${entry}: ${r.stderr.toString().slice(0, 200)}`);
    return new Uint8Array(r.stdout);
  };
  rmSync(OUT, { recursive: true, force: true });
  const listed = DEFAULT_SOUNDS.map((s) => {
    const bytes = unzipped(s.from, s.entry);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'OggS') throw new Error(`${s.entry} is not an Ogg file`);
    const file = `${s.kind === 'ui' ? 'ui' : 'footsteps'}/${s.name}.ogg`;
    mkdirSync(join(OUT, dirname(file)), { recursive: true });
    writeFileSync(join(OUT, file), bytes);
    return { name: s.name, kind: s.kind, file, from: s.from, entry: s.entry, sha256: sha(bytes), bytes: bytes.length };
  });
  mkdirSync(ARCHIVE, { recursive: true });
  for (const [pack, p] of Object.entries(SOUND_PACKS) as Array<[Pack, (typeof SOUND_PACKS)[Pack]]>) writeFileSync(join(ARCHIVE, p.licence.file), unzipped(pack, p.licence.entry));
  const packs = Object.fromEntries(Object.entries(SOUND_PACKS).map(([k, p]) => [k, { what: p.what, page: p.page, url: p.url, sha256: p.sha256 }]));
  writeFileSync(join(OUT, 'sounds.json'), `${JSON.stringify({ made: 'node tools/converter/scripts/default-sounds.ts', packs, sounds: listed }, null, 1)}\n`);
  process.stdout.write(`sounds: ${listed.length} in kits/sounds/ (${listed.reduce((n, s) => n + s.bytes, 0)} bytes)\n`);
}

await main();
