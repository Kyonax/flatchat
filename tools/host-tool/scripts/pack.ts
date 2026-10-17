// SPDX-License-Identifier: MPL-2.0
// Packages the host tool for Linux (S2.02, DR-15): the tool, the world server, the converter, the
// shared packages and the world templates, with their production dependencies and, unless
// --no-node, Node.js itself, in one folder and one .tar.gz:
//
//   node tools/host-tool/scripts/pack.ts [--no-node] [--out release/host]
//
//   flatchat-host-VERSION-linux-x64/bin/flatchat-host    the command (runs app/tools/host-tool/src/cli.ts)
//   flatchat-host-VERSION-linux-x64/app/                 the code, as TypeScript Node.js runs directly
//   flatchat-host-VERSION-linux-x64/node/                Node.js (the version in .tool-versions)
//
// The container image (tools/host-tool/Dockerfile) is built from the folder made with --no-node.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({ options: { 'no-node': { type: 'boolean', default: false }, out: { type: 'string', default: join(ROOT, 'release', 'host') } } });

const VERSION = (JSON.parse(readFileSync(join(ROOT, 'tools', 'host-tool', 'package.json'), 'utf8')) as { version: string }).version;
const NODE = readFileSync(join(ROOT, '.tool-versions'), 'utf8').match(/^nodejs\s+(\S+)/m)?.[1] ?? '24.22.0';
const NAME = `flatchat-host-${VERSION}-linux-x64`;
const out = join(values.out, NAME);
const app = join(out, 'app');

const WORKSPACES = ['packages/protocol', 'packages/sim', 'packages/content', 'apps/world-server', 'tools/converter', 'tools/host-tool'];

rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
for (const ws of WORKSPACES) {
  for (const part of ['package.json', 'LICENSE', 'README.md', 'src']) {
    const from = join(ROOT, ws, part);
    if (existsSync(from)) cpSync(from, join(app, ws, part), { recursive: true });
  }
}
cpSync(join(ROOT, 'kits', 'worlds'), join(app, 'kits', 'worlds'), { recursive: true });
for (const f of ['LICENSE', 'LICENSING.md', 'CREDITS.md', '.tool-versions']) cpSync(join(ROOT, f), join(app, f));
writeFileSync(
  join(app, 'package.json'),
  `${JSON.stringify({ name: 'flatchat-host', version: VERSION, private: true, license: 'SEE LICENSE IN LICENSING.md', type: 'module', workspaces: WORKSPACES, engines: { node: '>=24' } }, null, 2)}\n`,
);
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app, stdio: 'inherit' });
// node-datachannel's native binary comes from its install script, run only for that package.
execFileSync('npm', ['rebuild', 'node-datachannel'], { cwd: app, stdio: 'inherit' });

mkdirSync(join(out, 'bin'));
writeFileSync(
  join(out, 'bin', 'flatchat-host'),
  `#!/bin/sh
# FlatChat's host tool: see app/tools/host-tool/src/cli.ts for its commands.
HERE=$(dirname "$(readlink -f "$0")")
NODE="$HERE/../node/bin/node"
[ -x "$NODE" ] || NODE=node
exec "$NODE" "$HERE/../app/tools/host-tool/src/cli.ts" "$@"
`,
);
chmodSync(join(out, 'bin', 'flatchat-host'), 0o755);

if (!values['no-node']) {
  const tarball = join(values.out, `node-v${NODE}-linux-x64.tar.xz`);
  if (!existsSync(tarball)) execFileSync('curl', ['-fsSL', '-o', tarball, `https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz`], { stdio: 'inherit' });
  mkdirSync(join(out, 'node'));
  execFileSync('tar', ['-xJf', tarball, '-C', join(out, 'node'), '--strip-components=1'], { stdio: 'inherit' });
  execFileSync('tar', ['-czf', join(values.out, `${NAME}.tar.gz`), '-C', values.out, NAME], { stdio: 'inherit' });
  process.stdout.write(`${JSON.stringify({ event: 'packed', folder: out, tarball: join(values.out, `${NAME}.tar.gz`), node: NODE })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ event: 'packed', folder: out, node: 'none' })}\n`);
}
