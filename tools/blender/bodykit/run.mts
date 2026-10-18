// SPDX-License-Identifier: GPL-3.0-or-later
// The body kits from start to finish (Track P's P.03, rr-014): pinned tools, the generator run
// twice, the VRMs finished and checked, then kits/bodies/.
//
//   node tools/blender/bodykit/run.mts --setup     download and check the pinned tools and CC0 assets (once)
//   node tools/blender/bodykit/run.mts             generate twice and compare, finish, check, write kits/bodies/
//
// Everything lives under ~/.local/opt/flatchat-blender (FLATCHAT_BLENDER_HOME): Blender 5.2.2 LTS,
// and a Blender profile of FlatChat's own (BLENDER_USER_RESOURCES) holding MPFB 2.0.18, the VRM
// Add-on 4.10.2 and MakeHuman's CC0 packs, so the owner's own Blender is never touched. Each
// download is checked against its SHA-256 before it is used.
//
// P.03's checks, all here: two runs give the same summary (vertex counts, bones, expressions,
// measurements); every kit passes the avatar converter (Khronos glTF-Validator, vrm-validator, the
// platform's rules) as the humanoid it is, with LOD0 at most 30,000 triangles and 70 bones and all
// 18 expressions. three-vrm drawing the kits is the client's (its converted crowd); UniVRM and the
// owner's look at the five emotions are his.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sparse } from '@gltf-transform/functions';
import { AvatarError, avatarIO, convertAvatar, dropForeignExtensions } from '../../converter/src/avatar/convert.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const HOME = process.env['FLATCHAT_BLENDER_HOME'] ?? join(homedir(), '.local', 'opt', 'flatchat-blender');
const BLENDER = join(HOME, 'blender-5.2.2-linux-x64', 'blender');
const PROFILE = join(HOME, 'user');
const MPFB_DATA = join(PROFILE, 'extensions', '.user', 'user_default', 'mpfb', 'data');
const KITS = join(ROOT, 'kits', 'bodies');

/** What the kits are made with, each pinned by its SHA-256 (checked 2026-10-17). */
export const PINS = {
  blender: { url: 'https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz', sha256: '84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168' },
  mpfb: { url: 'https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip', sha256: 'c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad' },
  vrm: { url: 'https://extensions.blender.org/download/sha256:228e622d158fbbf070b1b49547708f360a223873f00fa81a42170794492e6db9/add-on-vrm-v4.10.2.zip', sha256: '228e622d158fbbf070b1b49547708f360a223873f00fa81a42170794492e6db9' },
  systemAssets: { url: 'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip', sha256: 'b542127a8e25547c7c29c19f2d1d2adb9a664c80396ecd694095dbc8028a0107' },
  faceunits01: { url: 'https://files.makehumancommunity.org/functional/faceunits01.zip', sha256: 'd113107bd7eb59f3af4df6fc0ec29bfcc593f496d0b336aec14f086a80ce7146' },
  visemes02: { url: 'https://files.makehumancommunity.org/functional/visemes02.zip', sha256: 'a69ab6fb95ddd5f56f70acc7e859f5f9c6ae613c527d577ea1571eff2183d29e' },
} as const;

/** P.03's limits for LOD0 (rr-014). */
export const LIMITS = { triangles: 30_000, bones: 70, expressions: 18 };

const say = (line: string): void => void process.stdout.write(`bodykit: ${line}\n`);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, BLENDER_USER_RESOURCES: PROFILE };

async function download(name: keyof typeof PINS): Promise<string> {
  const pin = PINS[name];
  const dir = join(HOME, 'downloads');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, pin.url.split('/').pop()!);
  if (!existsSync(file) || sha(readFileSync(file)) !== pin.sha256) {
    say(`downloading ${pin.url}`);
    const r = await fetch(pin.url);
    if (!r.ok) throw new Error(`${pin.url}: ${r.status}`);
    writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
  }
  const got = sha(readFileSync(file));
  if (got !== pin.sha256) throw new Error(`${file}: SHA-256 ${got}, expected ${pin.sha256}`);
  return file;
}

async function setup(): Promise<void> {
  const blender = await download('blender');
  if (!existsSync(BLENDER)) execFileSync('tar', ['-xf', blender, '-C', HOME]);
  for (const addon of ['vrm', 'mpfb'] as const) {
    execFileSync(BLENDER, ['--background', '--factory-startup', '--command', 'extension', 'install-file', '-r', 'user_default', '--enable', await download(addon)], { env, stdio: 'ignore' });
  }
  mkdirSync(MPFB_DATA, { recursive: true });
  for (const pack of ['systemAssets', 'faceunits01', 'visemes02'] as const) execFileSync('unzip', ['-oq', await download(pack), '-d', MPFB_DATA]);
  say(`ready: Blender 5.2.2 LTS, MPFB 2.0.18, the VRM Add-on 4.10.2 and MakeHuman's CC0 packs in ${HOME}`);
}

function generate(out: string): Record<string, Record<string, unknown>> {
  execFileSync(BLENDER, ['--background', '--python', join(HERE, 'generate.py'), '--', '--out', out], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Record<string, Record<string, unknown>>;
}

/** The exporter writes every face shape for every vertex; sparse accessors keep only the
 *  vertices a shape moves (the face's), which takes a kit from about 15 MB to a third. And only
 *  the extensions the platform's avatars carry stay, as the converter would leave them. */
async function finish(vrm: string): Promise<Uint8Array> {
  const io = avatarIO();
  const doc = await io.read(vrm);
  dropForeignExtensions(doc);
  await doc.transform(sparse({ ratio: 1 / 3 }));
  return io.writeBinary(doc);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { setup: { type: 'boolean', default: false } } });
  if (values.setup) {
    await setup();
    return 0;
  }
  if (!existsSync(BLENDER) || !existsSync(join(MPFB_DATA, 'packs', 'faceunits01.json'))) {
    console.error('bodykit: the tools are not set up: node tools/blender/bodykit/run.mts --setup');
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), 'bodykit-'));
  try {
    const [a, b] = [join(work, 'a'), join(work, 'b')];
    const first = generate(a);
    const second = generate(b);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      console.error('bodykit: two runs differ; the generator is not deterministic');
      return 1;
    }
    say(`two runs agree on ${Object.keys(first).length} kits`);
    const report: Record<string, unknown> = {};
    let ok = true;
    rmSync(KITS, { recursive: true, force: true });
    for (const name of Object.keys(first).sort()) {
      const bytes = await finish(join(a, `${name}.vrm`));
      let converted: Record<string, unknown>;
      try {
        const r = await convertAvatar(bytes, { ktx2: false });
        const m = r.manifest;
        const checks = {
          humanoid: m.shape === 'humanoid',
          triangles: m.levels.lod0.triangles <= LIMITS.triangles,
          bones: m.levels.lod0.bones <= LIMITS.bones,
          expressions: m.expressions.length === LIMITS.expressions,
          warnings: m.warnings.length === 0,
        };
        ok &&= Object.values(checks).every(Boolean);
        converted = { rank: m.rank, limitedBy: m.limitedBy, height: m.height, levels: Object.fromEntries(Object.entries(m.levels).map(([k, l]) => [k, { triangles: l.triangles, bones: l.bones, materialSlots: l.materialSlots }])), checks };
      } catch (err) {
        ok = false;
        converted = { refused: err instanceof AvatarError ? err.problems : String(err) };
      }
      mkdirSync(join(KITS, name), { recursive: true });
      writeFileSync(join(KITS, name, `${name}.vrm`), bytes);
      cpSync(join(a, `${name}.blend`), join(KITS, name, `${name}.blend`));
      for (const picture of ['thumbnail', 'emotions', 'skin', 'underwear']) cpSync(join(a, `${name}-${picture}.png`), join(KITS, name, `${name}-${picture}.png`));
      report[name] = { ...first[name], vrmBytes: bytes.length, vrmSha256: sha(bytes), converter: converted };
      say(`${name}: ${(bytes.length / 1048576).toFixed(1)} MB, ${JSON.stringify(converted)}`);
    }
    const tools = Object.fromEntries(Object.entries(PINS).map(([k, p]) => [k, { url: p.url, sha256: p.sha256 }]));
    writeFileSync(join(KITS, 'kits.json'), `${JSON.stringify({ made: 'node tools/blender/bodykit/run.mts', tools, kits: report }, null, 2)}\n`);
    say(ok ? `every kit passed; written to ${KITS}` : 'a kit failed its checks (kits.json says which)');
    return ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
