// SPDX-License-Identifier: MPL-2.0
// The world browser with every real program (S2.09): a private PostgreSQL, the core, an account
// signed in over the API, a world registered and approved through the admin command line, its world
// server reporting to the core over its host channel (not relayed: the bots reach it over UDP), and
// bots filling it one at a time. At every count the public list must show the world while it is
// below its recommended count and drop it at that count; once it is full the core refuses connect
// tokens and the world refuses one more bot; as the bots leave, it comes back. Needs PostgreSQL's
// programs, like the end-to-end test.
//
//   node tools/bots/src/browse.ts [--recommended 4] [--capacity 6] [--keep]
//
// One JSON line: { event: 'browse', ok, steps } ; exit 0 when every check passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const EMAIL = 'browse@example.org';
const PASSWORD = 'a world browser password';

const { values } = parseArgs({ options: { recommended: { type: 'string', default: '4' }, capacity: { type: 'string', default: '6' }, keep: { type: 'boolean', default: false } } });
const recommended = Number(values.recommended);
const capacity = Number(values.capacity);
if (!Number.isInteger(recommended) || !Number.isInteger(capacity) || recommended < 1 || capacity < recommended || capacity > 50) {
  process.stderr.write('--recommended and --capacity: 1 <= recommended <= capacity <= 50\n');
  process.exit(2);
}

const steps: Record<string, unknown> = {};
const counts: Array<{ players: number; listed: boolean; expected: boolean }> = [];
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

const dir = mkdtempSync(join(tmpdir(), 'fcbrowse-'));
const bots: Bot[] = [];
let ticker: ReturnType<typeof setInterval> | undefined;
let ok = false;
try {
  // 1. The database, the core, an account signed in the way the client signs in.
  const db = (await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'start', '--dir', join(dir, 'pg')])).match(/FLATCHAT_CORE_DB=(\S+)/)?.[1];
  if (!db) throw new Error('no database');
  const corePort = await freePort();
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const coreEnv = { FLATCHAT_CORE_DB: db, FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'), FLATCHAT_CORE_URL: coreUrl, FLATCHAT_CORE_STUN: 'none' };
  const core = await start([process.execPath, join(CORE, 'src', 'main.ts'), '--port', String(corePort), '--stop-on-stdin'], coreEnv, 'ready');
  const admin = (...args: string[]): Promise<string> => run([process.execPath, join(CORE, 'src', 'admin.ts'), ...args], coreEnv);
  const invite = (await admin('invite', '--email', EMAIL, '--note', 'browse')).match(/invite=(\S+)/)?.[1];
  const access = await signUpAndIn(coreUrl, invite ?? '', EMAIL, PASSWORD, 'Browser');
  const bearer = { authorization: `Bearer ${access}` };
  steps['signedIn'] = true;

  // 2. A world, approved for `capacity` players, reporting to the core over its host channel.
  const worldId = (await admin('world', 'register', '--name', 'Browse Plaza', '--owner', EMAIL, '--address', 'relay', '--capacity', String(capacity))).match(/registered (\S+)/)?.[1];
  const keyHex = (await admin('world', 'approve', worldId ?? '')).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1];
  if (!worldId || !keyHex) throw new Error('no approved world');
  const world = await start(
    [
      process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--capacity', String(capacity), '--recommended', String(recommended),
      '--world-size', '48', '--metrics-every', '0', '--world-id', worldId, '--core', coreUrl, '--stop-on-stdin',
    ],
    { FLATCHAT_WORLD_KEY: keyHex },
    'ready',
  );
  await waitFor('the world to reach the core', 15_000, async () => (world.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
  const udpPort = Number(world.lines.find((l) => l['event'] === 'ready')?.['port']);

  const view = async (): Promise<{ players: number; online: boolean }> => (await fetch(`${coreUrl}/api/v1/worlds/${worldId}`)).json() as Promise<{ players: number; online: boolean }>;
  const listed = async (): Promise<boolean> => ((await (await fetch(`${coreUrl}/api/v1/worlds`)).json()) as { worlds: Array<{ id: string }> }).worlds.some((w) => w.id === worldId);
  const settle = async (players: number): Promise<void> => {
    await waitFor(`the core to count ${players}`, 10_000, async () => ((await view()).players === players ? true : undefined));
    counts.push({ players, listed: await listed(), expected: players < recommended });
  };

  // 3. Bots fill it, one at a time.
  const key = fromHex(keyHex);
  let slot = 0;
  ticker = setInterval(() => {
    slot += 1;
    const now = performance.now();
    for (const b of bots) b.tick(slot, now);
  }, 10);
  const bot = async (index: number): Promise<Bot> => {
    const b = new Bot({ index, seed: 7000 + index, target: { transport: 'udp', host: '127.0.0.1', udpPort, signalUrl: '', worldId, worldKey: key }, brain: { ...DEFAULT_BRAIN, size: 48 }, voice: false, chat: false });
    bots.push(b);
    await b.join();
    return b;
  };
  await settle(0);
  for (let n = 1; n <= capacity; n++) {
    const b = await bot(n);
    if (b.state !== 'joined') throw new Error(`bot ${n} did not join: ${b.refuseReason || b.lostReason}`);
    await settle(n);
  }
  // 4. Full: no connect token from the core, and the world itself refuses one more.
  const token = await fetch(`${coreUrl}/api/v1/worlds/${worldId}/join`, { method: 'POST', headers: bearer });
  steps['coreWhenFull'] = { status: token.status, error: ((await token.json()) as { error?: string }).error };
  const extra = await bot(capacity + 1);
  steps['worldWhenFull'] = extra.state === 'refused' ? extra.refuseReason : extra.state;

  // 5. They leave: back on the list below the recommended count.
  for (let n = capacity - 1; n >= 0; n--) {
    bots[n]!.stop();
    await settle(n);
  }
  steps['counts'] = counts.map((c) => `${c.players}:${c.listed ? 'listed' : 'off'}`).join(' ');
  ok = counts.every((c) => c.listed === c.expected) && steps['worldWhenFull'] === 'full' && (steps['coreWhenFull'] as { error?: string }).error === 'full';

  await stop(world.proc);
  await stop(core.proc);
} catch (err) {
  steps['error'] = err instanceof Error ? err.message : String(err);
} finally {
  if (ticker) clearInterval(ticker);
  for (const b of bots) if (b.state === 'joined') b.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('browse', { ok, recommended, capacity, steps });
process.exit(ok ? 0 : 1);
