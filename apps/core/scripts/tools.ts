// SPDX-License-Identifier: AGPL-3.0-or-later
// The native programs the core converts animations with (S5.07, DR-15), at pinned versions: headless
// Blender 5.2.2 LTS (it reads FBX) and Rhubarb Lip Sync 1.14.0 (MIT; a dance's mouth track). Each
// archive is downloaded once (or taken from --downloads), checked against its SHA-256, and unpacked
// into --out; then the two lines the core's environment needs are printed. Linux x64 only, like
// the core's server; it needs tar and unzip.
//
//   node apps/core/scripts/tools.ts [--out ~/.local/opt/flatchat-core-tools] [--downloads DIR]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export const TOOLS = {
  blender: {
    url: 'https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz',
    file: 'blender-5.2.2-linux-x64.tar.xz',
    sha256: '84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168',
    folder: 'blender-5.2.2-linux-x64',
    program: 'blender',
    env: 'FLATCHAT_CORE_BLENDER',
  },
  rhubarb: {
    url: 'https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.14.0/Rhubarb-Lip-Sync-1.14.0-Linux.zip',
    file: 'Rhubarb-Lip-Sync-1.14.0-Linux.zip',
    sha256: 'a9a9074862cff47b2d59b8bf399a678a3b0b74f9452ad6ad94cb292913dd8667',
    folder: 'Rhubarb-Lip-Sync-1.14.0-Linux',
    program: 'rhubarb',
    env: 'FLATCHAT_CORE_RHUBARB',
  },
} as const;

const { values } = parseArgs({ options: { out: { type: 'string', default: join(homedir(), '.local', 'opt', 'flatchat-core-tools') }, downloads: { type: 'string' } } });
const out = values.out;
const downloads = values.downloads ?? join(out, 'downloads');
mkdirSync(out, { recursive: true });
mkdirSync(downloads, { recursive: true });
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const lines: string[] = [];
for (const tool of Object.values(TOOLS)) {
  const archive = join(downloads, tool.file);
  if (!existsSync(archive)) {
    process.stdout.write(`fetching ${tool.url}\n`);
    const r = await fetch(tool.url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${tool.url} answered ${r.status}`);
    writeFileSync(`${archive}.part`, new Uint8Array(await r.arrayBuffer()));
    renameSync(`${archive}.part`, archive);
  }
  const got = sha(archive);
  if (got !== tool.sha256) {
    rmSync(archive);
    throw new Error(`${tool.file}: SHA-256 ${got}, not the pinned ${tool.sha256}; removed it`);
  }
  const home = join(out, tool.folder);
  if (!existsSync(join(home, tool.program))) {
    const unpacked = tool.file.endsWith('.zip') ? spawnSync('unzip', ['-q', '-o', archive, '-d', out]) : spawnSync('tar', ['-xJf', archive, '-C', out]);
    if (unpacked.status !== 0) throw new Error(`unpacking ${tool.file}: ${unpacked.stderr.toString().slice(0, 200)}`);
  }
  if (!existsSync(join(home, tool.program))) throw new Error(`${tool.file} has no ${tool.program} in ${tool.folder}`);
  lines.push(`${tool.env}=${join(home, tool.program)}`);
}
process.stdout.write(`${lines.join('\n')}\n`);
