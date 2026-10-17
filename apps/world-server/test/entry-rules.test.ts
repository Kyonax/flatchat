// SPDX-License-Identifier: MPL-2.0
// The entry rules that ship as plugins (S3.05): each admits the right accounts and refuses the rest
// with a clear reason.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type JoinRequest, Plugins, type PluginWorld } from '../src/plugins.ts';

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');

const world: PluginWorld = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Rules',
  pluginPlayers: () => [],
  pluginSay: () => undefined,
  pluginKick: () => undefined,
  pluginBan: () => undefined,
  pluginUnban: () => undefined,
  pluginForceMute: () => undefined,
  pluginStore: () => ({ get: () => undefined, set: () => true, delete: () => undefined, keys: () => [] }),
};

const person = (over: Partial<JoinRequest> = {}): JoinRequest => ({ account: 'a', name: 'Ana', trust: 0, tester: false, emailVerified: false, ageDays: 0, under18: false, role: 'visitor', players: 0, capacity: 10, ...over });

async function rule(name: string): Promise<Plugins> {
  const plugins = new Plugins(world, () => undefined);
  // Load just this plugin: a folder holding only it.
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'fcrules-'));
  symlinkSync(join(PLUGINS, name), join(dir, name));
  await plugins.load([dir]);
  expect(plugins.names).toEqual([name]);
  return plugins;
}

describe('the entry rules', () => {
  it('open lets everyone in', async () => {
    const r = await rule('entry-open');
    expect(r.joinRequest(person())).toEqual({ admit: true });
  });

  it('verified asks for a verified email and a week-old account', async () => {
    const r = await rule('entry-verified');
    expect(r.joinRequest(person({ emailVerified: false, ageDays: 30 }))).toEqual({ admit: false, reason: 'This world asks for a verified email.' });
    expect(r.joinRequest(person({ emailVerified: true, ageDays: 6 }))).toEqual({ admit: false, reason: 'This world asks for an account at least 7 days old.' });
    expect(r.joinRequest(person({ emailVerified: true, ageDays: 7 }))).toEqual({ admit: true });
  });

  it('trust asks for a level, and lets a tester in', async () => {
    const r = await rule('entry-trust');
    expect(r.joinRequest(person({ trust: 0 }))).toEqual({ admit: false, reason: 'This world asks for trust level 1 or more.' });
    expect(r.joinRequest(person({ trust: 1 }))).toEqual({ admit: true });
    expect(r.joinRequest(person({ trust: 0, tester: true }))).toEqual({ admit: true });
  });
});
