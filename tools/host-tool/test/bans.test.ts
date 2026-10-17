// SPDX-License-Identifier: MPL-2.0
// host bans and host unban (S3.07): the world's bans and record, read and lifted in its own
// database on the host's machine.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldStore } from '@flatchat/world-server/store';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const dir = mkdtempSync(join(tmpdir(), 'fc-bans-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a world’s bans from the host tool', () => {
  it('lists the bans in force with the record, and lifts one', () => {
    const file = join(dir, 'world.db');
    const world = randomUUID();
    const account = randomUUID();
    const store = WorldStore.open(file, 'reset');
    store.ban(account, undefined, 'Harassment');
    store.logModeration({ actor: randomUUID(), target: account, action: 'ban', minutes: 0, reason: 'Harassment' });
    store.close();
    const run = (...args: string[]): string => execFileSync(process.execPath, [CLI, ...args, '--data', file], { encoding: 'utf8' });
    const listed = run('bans', world);
    expect(listed).toContain(`${account}  until lifted  Harassment`);
    expect(listed).toMatch(/ban {2}[0-9a-f-]{36} {2}by [0-9a-f-]{36}: Harassment/);
    expect(run('unban', world, account)).toContain(`lifted the ban on ${account}`);
    expect(run('bans', world)).toContain('no bans in force');
    const after = WorldStore.open(file, 'reset');
    expect(after.banned(account)).toBeUndefined();
    expect(after.moderationLog()[0]).toMatchObject({ actor: 'host tool', action: 'unban', target: account });
    after.close();
  });
});
