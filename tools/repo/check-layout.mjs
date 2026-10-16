#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Checks the repository against tools/repo/layout.json: the required files and folders, each
// licensed folder's LICENSE text and LICENSING.md row, and the SPDX header of every source file.
// Usage: node tools/repo/check-layout.mjs [--root DIR]   (exit 0 = pass, 1 = problems found)
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const at = argv.indexOf('--root');
const root = at >= 0 ? argv[at + 1] : join(here, '..', '..');
const layout = JSON.parse(readFileSync(join(here, 'layout.json'), 'utf8'));

// The opening lines that identify each licence text.
const FINGERPRINTS = {
  'MPL-2.0': ['Mozilla Public License Version 2.0'],
  'AGPL-3.0-or-later': ['GNU AFFERO GENERAL PUBLIC LICENSE', 'Version 3, 19 November 2007'],
  'GPL-3.0-or-later': ['GNU GENERAL PUBLIC LICENSE', 'Version 3, 29 June 2007'],
  'Apache-2.0': ['Apache License', 'Version 2.0, January 2004'],
  'CC-BY-4.0': ['Attribution 4.0 International'],
};
const HEADER_LINES = 5;

const problems = [];
const kind = (p) => { try { return lstatSync(p); } catch { return null; } };
const isFile = (p) => kind(p)?.isFile() ?? false;
const isDir = (p) => kind(p)?.isDirectory() ?? false;
const posix = (p) => p.split(sep).join('/');

function isLicence(text, id) {
  const opening = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5);
  const want = FINGERPRINTS[id];
  if (!want) return false;
  return want.every((w) => opening.some((l) => l === w));
}

function licenceFor(rel) {
  let best = null;
  for (const folder of Object.keys(layout.folders)) {
    if ((rel === folder || rel.startsWith(`${folder}/`)) && (!best || folder.length > best.length)) best = folder;
  }
  return best ? layout.folders[best] : layout.defaultLicence;
}

function walk(dir, visit) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = kind(p);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!layout.skipFolders.includes(name)) walk(p, visit);
    } else if (st.isFile()) {
      visit(p);
    }
  }
}

// 1. Required files, required folders, and no stray top-level folders.
if (!existsSync(root)) {
  console.error(`check-layout: no such folder: ${root}`);
  process.exit(1);
}
for (const f of layout.requiredFiles) if (!isFile(join(root, f))) problems.push(`missing file: ${f}`);
for (const d of [...layout.topLevelFolders, ...layout.requiredFolders]) {
  if (!isDir(join(root, d))) problems.push(`missing folder: ${d}/`);
}
for (const name of readdirSync(root)) {
  if (name.startsWith('.') || name === 'node_modules') continue;
  if (isDir(join(root, name)) && !layout.topLevelFolders.includes(name)) {
    problems.push(`unexpected top-level folder: ${name}/ (add it to tools/repo/layout.json if it belongs)`);
  }
}

// 2. Licences: the root LICENSE, each licensed folder's LICENSE and README, and LICENSING.md's table.
if (isFile(join(root, 'LICENSE')) && !isLicence(readFileSync(join(root, 'LICENSE'), 'utf8'), layout.defaultLicence)) {
  problems.push(`LICENSE is not the ${layout.defaultLicence} text`);
}
const licensing = isFile(join(root, 'LICENSING.md')) ? readFileSync(join(root, 'LICENSING.md'), 'utf8').split('\n') : [];
for (const [folder, id] of Object.entries(layout.folders)) {
  const lic = join(root, folder, 'LICENSE');
  if (!isFile(lic)) problems.push(`missing ${folder}/LICENSE (${id})`);
  else if (!isLicence(readFileSync(lic, 'utf8'), id)) problems.push(`${folder}/LICENSE is not the ${id} text`);
  if (!isFile(join(root, folder, 'README.md'))) problems.push(`missing ${folder}/README.md`);
  if (licensing.length && !licensing.some((l) => l.includes(`\`${folder}\``) && l.includes(`\`${id}\``))) {
    problems.push(`LICENSING.md has no row for ${folder} with ${id}`);
  }
}

// 3. SPDX headers: every source file names its folder's licence in its first lines.
let sources = 0;
if (isDir(root)) {
  walk(root, (file) => {
    if (!layout.sourceExtensions.includes(extname(file))) return;
    sources += 1;
    const rel = posix(relative(root, file));
    const want = licenceFor(rel);
    const lines = readFileSync(file, 'utf8').split('\n');
    const head = lines.slice(0, lines[0]?.startsWith('#!') ? HEADER_LINES + 1 : HEADER_LINES);
    const found = head.map((l) => l.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/)).find(Boolean);
    if (!found) problems.push(`no SPDX header: ${rel} (wants ${want})`);
    else if (found[1] !== want) problems.push(`wrong SPDX header: ${rel} says ${found[1]}, its folder is ${want}`);
  });
}

if (problems.length) {
  console.error(`check-layout: ${problems.length} problem(s) in ${root}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const folders = Object.keys(layout.folders).length;
console.log(`check-layout: OK (${layout.codename}) · ${folders} licensed folders · ${sources} source file(s) with matching SPDX headers`);
