// SPDX-License-Identifier: MPL-2.0
// Checks that package-lock.json is in step with every package.json, which `npm ci` (CI's first
// step) requires: each workspace (a folder matched by the root's workspaces globs that holds a
// package.json) has its lock entry and its node_modules link, every manifest's dependency lists
// equal the lock's copies, and the lock lists no workspace that is gone. Offline and quick, so a
// workspace or dependency added without `npm install` fails here instead of in CI.
//
//   node tools/harness/src/lock-check.ts [--root DIR]     exit 0 = in step, 1 = problems
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type Manifest = Record<string, unknown> & { name?: string; version?: string; workspaces?: string[] };
type LockEntry = Record<string, unknown>;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Workspace folders, relative to the root, for globs like "apps/*" or plain paths. */
export function workspaceDirs(root: string, globs: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      const full = join(root, base);
      if (!existsSync(full)) continue;
      for (const name of readdirSync(full, { withFileTypes: true })) {
        if (name.isDirectory() && existsSync(join(full, name.name, 'package.json'))) dirs.push(`${base}/${name.name}`);
      }
    } else if (existsSync(join(root, g, 'package.json'))) {
      dirs.push(g);
    }
  }
  return dirs.sort();
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

function compareDeps(label: string, manifest: Manifest, entry: LockEntry, problems: string[]): void {
  for (const field of DEP_FIELDS) {
    const want = manifest[field] as Record<string, string> | undefined;
    const have = entry[field] as Record<string, string> | undefined;
    if (same(want, have)) continue;
    const names = new Set([...Object.keys(want ?? {}), ...Object.keys(have ?? {})]);
    const differ = [...names].filter((n) => want?.[n] !== have?.[n]).map((n) => `${n} (package.json ${want?.[n] ?? 'none'}, lock ${have?.[n] ?? 'none'})`);
    problems.push(`${label}: ${field} differ from the lock file: ${differ.join(', ')}`);
  }
}

export function checkLock(root: string): string[] {
  const problems: string[] = [];
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return ['no package-lock.json: run npm install'];
  const lock = readJson(lockPath);
  const packages = lock['packages'] as Record<string, LockEntry> | undefined;
  if (!packages) return ['package-lock.json has no "packages" map (lockfileVersion 2 or later expected): run npm install'];
  const rootManifest = readJson(join(root, 'package.json')) as Manifest;
  const rootEntry = packages[''];
  if (!rootEntry) problems.push('the lock file has no entry for the root package');
  else compareDeps('the root package.json', rootManifest, rootEntry, problems);

  const dirs = workspaceDirs(root, rootManifest.workspaces ?? []);
  for (const dir of dirs) {
    const manifest = readJson(join(root, dir, 'package.json')) as Manifest;
    const name = manifest.name ?? dir;
    const entry = packages[dir];
    if (!entry) {
      problems.push(`${name} (${dir}) is missing from the lock file`);
      continue;
    }
    if (entry['name'] !== manifest.name || entry['version'] !== manifest.version) {
      problems.push(`${dir}: the lock file has ${String(entry['name'])}@${String(entry['version'])}, package.json says ${String(manifest.name)}@${String(manifest.version)}`);
    }
    compareDeps(`${dir}/package.json`, manifest, entry, problems);
    const link = packages[`node_modules/${String(manifest.name)}`];
    if (!link || link['link'] !== true || link['resolved'] !== dir) problems.push(`the lock file has no node_modules link for ${name} → ${dir}`);
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (entry['link'] === true && typeof entry['resolved'] === 'string' && key.startsWith('node_modules/') && !dirs.includes(entry['resolved'])) {
      problems.push(`the lock file links ${key.slice('node_modules/'.length)} to ${entry['resolved']}, which is no longer a workspace`);
    }
  }
  return problems.map((p) => `${p}; fix: run npm install and commit package-lock.json`);
}

function main(): number {
  let root: string | undefined;
  try {
    ({ values: { root } } = parseArgs({ options: { root: { type: 'string' } } }));
  } catch (err) {
    console.error(`lock-check: ${(err as Error).message}`);
    return 2;
  }
  const repo = root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const problems = checkLock(repo);
  if (problems.length === 0) {
    const n = workspaceDirs(repo, (readJson(join(repo, 'package.json')) as Manifest).workspaces ?? []).length;
    console.log(`lock-check: OK · package-lock.json matches the root and ${n} workspace(s)`);
    return 0;
  }
  console.log(`lock-check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
