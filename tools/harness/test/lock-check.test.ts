// SPDX-License-Identifier: MPL-2.0
// The lock check on throwaway folders: in step passes; a workspace or a dependency added without
// `npm install` fails, as `npm ci` would in CI.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLock, workspaceDirs } from '../src/lock-check.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Repo {
  rootDev?: Record<string, string>;
  lockRootDev?: Record<string, string>;
  workspaces?: Record<string, { name: string; dev?: Record<string, string> }>;
  lockWorkspaces?: string[];
}

function makeRepo(r: Repo): string {
  const root = mkdtempSync(join(tmpdir(), 'lock-check-'));
  roots.push(root);
  const ws = r.workspaces ?? { 'apps/a': { name: '@x/a' } };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', workspaces: ['apps/*', 'tools/*'], devDependencies: r.rootDev ?? { yaml: '^2.9.1' } }));
  const packages: Record<string, unknown> = { '': { name: 'x', version: '0.0.0', workspaces: ['apps/*', 'tools/*'], devDependencies: r.lockRootDev ?? r.rootDev ?? { yaml: '^2.9.1' } } };
  for (const [dir, w] of Object.entries(ws)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: w.name, version: '0.0.0', ...(w.dev ? { devDependencies: w.dev } : {}) }));
  }
  for (const dir of r.lockWorkspaces ?? Object.keys(ws)) {
    const w = ws[dir];
    if (!w) continue;
    packages[dir] = { name: w.name, version: '0.0.0', ...(w.dev ? { devDependencies: w.dev } : {}) };
    packages[`node_modules/${w.name}`] = { resolved: dir, link: true };
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, packages }));
  return root;
}

describe('checkLock', () => {
  it('passes a lock file in step with every manifest', () => {
    expect(checkLock(makeRepo({}))).toEqual([]);
  });

  it('finds a workspace added without npm install', () => {
    const root = makeRepo({ workspaces: { 'apps/a': { name: '@x/a' }, 'tools/h': { name: '@x/h' } }, lockWorkspaces: ['apps/a'] });
    expect(checkLock(root).join('\n')).toContain('@x/h (tools/h) is missing from the lock file');
  });

  it('finds a dependency changed without npm install', () => {
    const root = makeRepo({ rootDev: { yaml: '^2.9.1', vitest: '^5.0.5' }, lockRootDev: { yaml: '^2.9.1' } });
    expect(checkLock(root)[0]).toContain('devDependencies differ from the lock file: vitest (package.json ^5.0.5, lock none)');
  });

  it('lists workspaces from the globs, only folders with a package.json', () => {
    const root = makeRepo({});
    mkdirSync(join(root, 'tools', 'empty'), { recursive: true });
    expect(workspaceDirs(root, ['apps/*', 'tools/*'])).toEqual(['apps/a']);
  });
});
