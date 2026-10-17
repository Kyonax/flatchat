// SPDX-License-Identifier: MPL-2.0
// A world folder's plugins (S3.01, S3.05): installing a built-in entry rule or a plugin folder shows
// what it asks for; the list names a plugin the world server would refuse; the command works.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HostError } from '../src/account.ts';
import { addPlugin, describePlugin, listPlugins } from '../src/plugins.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT_IN = join(ROOT, 'apps', 'world-server', 'plugins');
const GREETER = join(ROOT, 'apps', 'world-server', 'test', 'fixtures', 'plugins', 'greeter');
const tmp = mkdtempSync(join(tmpdir(), 'fc-plugins-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function world(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'world.toml'), '');
  return dir;
}

describe('a world’s plugins', () => {
  it('installs a built-in entry rule and a plugin folder, saying what each asks for', () => {
    const dir = world('w1');
    const rule = addPlugin(dir, 'entry-trust', BUILT_IN);
    expect(describePlugin(rule)).toEqual([
      'entry-trust 1.0.0: Entry rule: a minimum trust level, or testers only (the closed test).',
      '  hooks: on_join_request',
      '  asks for no permissions',
      '  settings (in its plugin.toml): min_trust = 1, testers_only = false',
    ]);
    const greeter = describePlugin(addPlugin(dir, GREETER, BUILT_IN));
    expect(greeter[2]).toBe('  asks to: say things in the world’s chat, and change or stop players’ chat lines (chat); keep data in the world between runs (store)');
    expect(listPlugins(dir).map((p) => p.folder)).toEqual(['entry-trust', 'greeter']);
    expect(() => addPlugin(dir, 'entry-trust', BUILT_IN)).toThrow(/already in/);
    expect(() => addPlugin(dir, 'entry-nothing', BUILT_IN)).toThrow(HostError);
  });

  it('names a plugin the world server would refuse', () => {
    const dir = world('w2');
    mkdirSync(join(dir, 'plugins', 'loud'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'loud', 'plugin.toml'), 'name = "loud"\nversion = "1.0.0"\napi = 1\nhooks = ["on_chat"]\n');
    expect(listPlugins(dir)).toEqual([{ folder: 'loud', problem: expect.stringMatching(/on_chat needs the "chat" permission/) }]);
  });

  it('works from the command line', () => {
    const dir = world('w3');
    const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'host-tool', 'src', 'cli.ts'), 'plugins', dir, 'add', 'entry-verified'], { encoding: 'utf8' });
    expect(out).toMatch(/^entry-verified 1\.0\.0/);
    expect(out).toMatch(/runs with the world from the next host run/);
    expect(execFileSync(process.execPath, [join(ROOT, 'tools', 'host-tool', 'src', 'cli.ts'), 'plugins', dir], { encoding: 'utf8' })).toMatch(/min_account_days = 7/);
  });
});
