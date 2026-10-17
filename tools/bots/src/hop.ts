// SPDX-License-Identifier: MPL-2.0
// Travel between worlds (S2.11): two world servers on two built plazas whose portals lead to each
// other (tools/converter/scripts/make-travel.ts), and bots that walk into one world's portal, leave
// with `travel`, join the other world at the spawn group the portal named, and walk into that
// world's portal: round and round. The bots stand in for the core, sealing their own connect tokens
// with each world's key; the client's path through the core is the end-to-end test's.
//
//   node tools/bots/src/hop.ts [--bots 20] [--loops 5] [--keep]
//
// One JSON line: { event: 'hop', ok, bots, loops, hops, seconds, worlds } ; exit 0 when every bot
// made every hop, arrived at the arrival spawn each time, and each world counted the portals it
// sent and the `travel` leaves it saw.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newWorldKey, toHex } from '@flatchat/protocol';
import { PLAZA } from '@flatchat/sim';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, run, start, stop } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');

const { values } = parseArgs({ options: { bots: { type: 'string', default: '20' }, loops: { type: 'string', default: '5' }, keep: { type: 'boolean', default: false } } });
const bots = Number(values.bots);
const loops = Number(values.loops);
if (!Number.isInteger(bots) || bots < 1 || bots > 200 || !Number.isInteger(loops) || loops < 1 || loops > 100) {
  process.stderr.write('--bots 1 to 200, --loops 1 to 100\n');
  process.exit(2);
}

const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Journey {
  hops: number;
  arrivals: Array<{ x: number; z: number }>;
  error: string;
}

const dir = mkdtempSync(join(tmpdir(), 'fchop-'));
const ids = [randomUUID(), randomUUID()] as const;
const keys = [newWorldKey(), newWorldKey()] as const;
const active = new Set<Bot>();
let ticker: ReturnType<typeof setInterval> | undefined;
let ok = false;
const result: Record<string, unknown> = { bots, loops };
try {
  // 1. Two worlds whose portals lead to each other, each on its own world server.
  const made = JSON.parse((await run([process.execPath, MAKE_TRAVEL, dir, '--worlds', ids.join(','), '--names', 'Hop A,Hop B'])).trim().split('\n').at(-1)!) as {
    portal: [number, number, number];
    arrival: [number, number, number];
  };
  const servers = await Promise.all(
    [0, 1].map((k) =>
      start(
        [
          process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--world', join(dir, k === 0 ? 'a.built' : 'b.built'),
          '--world-id', ids[k]!, '--capacity', String(bots + 4), '--metrics-every', '0', '--data', join(dir, `${k}.db`), '--stop-on-stdin',
        ],
        { FLATCHAT_WORLD_KEY: toHex(keys[k]!) },
        'ready',
      ),
    ),
  );
  const ports = servers.map((s) => Number(s.lines.find((l) => l['event'] === 'ready')?.['port']));

  // 2. The bots: join, walk into the portal, leave with `travel`, join the other world, again.
  let slot = 0;
  ticker = setInterval(() => {
    slot += 1;
    const now = performance.now();
    for (const b of active) b.tick(slot, now);
  }, 10);
  const portal = { x: made.portal[0], z: made.portal[2] };
  const journey = async (i: number): Promise<Journey> => {
    const j: Journey = { hops: 0, arrivals: [], error: '' };
    let at = i % 2;
    let spawn = '';
    while (j.hops < loops * 2) {
      let through!: (to: { world: string; spawn: string }) => void;
      const went = new Promise<{ world: string; spawn: string }>((resolve) => (through = resolve));
      const bot = new Bot({
        index: i,
        seed: 9000 + i * 131 + j.hops,
        target: { transport: 'udp', host: '127.0.0.1', udpPort: ports[at]!, signalUrl: '', worldId: ids[at]!, worldKey: keys[at]! },
        brain: { ...DEFAULT_BRAIN, size: PLAZA.size, scenario: 'plaza' },
        voice: false,
        chat: false,
        spawn,
        goal: portal,
        onPortal: (to) => through(to),
      });
      active.add(bot);
      await bot.join();
      if (bot.state !== 'joined') {
        active.delete(bot);
        j.error = `hop ${j.hops}: ${bot.refuseReason || bot.lostReason || bot.state}`;
        return j;
      }
      const to = await Promise.race([went, sleep(40_000).then(() => undefined)]);
      // Every join after the first came through a portal: it must land on the arrival spawn.
      if (spawn && bot.spawnAt) j.arrivals.push(bot.spawnAt);
      if (!to || to.world !== ids[1 - at]) {
        bot.stop();
        active.delete(bot);
        j.error = `hop ${j.hops}: ${to ? `a portal to ${to.world}` : 'no portal within 40 s'}`;
        return j;
      }
      bot.stop('travel');
      active.delete(bot);
      j.hops += 1;
      at = 1 - at;
      spawn = to.spawn;
    }
    return j;
  };
  const started = performance.now();
  const journeys = await Promise.all(Array.from({ length: bots }, (_, i) => journey(i)));
  result['seconds'] = Math.round((performance.now() - started) / 100) / 10;
  await sleep(500);

  // 3. What each world saw: the portals it sent, the travellers who left and arrived.
  const worlds: Array<Record<string, number>> = [];
  for (const s of servers) {
    await stop(s.proc);
    const summary = s.lines.find((l) => l['event'] === 'stopped')?.['summary'] as { events?: Record<string, { messages: number }> } | undefined;
    const e = summary?.events ?? {};
    worlds.push({ joins: e['join']?.messages ?? 0, portals: e['portal']?.messages ?? 0, travelled: e['leave:travel']?.messages ?? 0 });
  }
  const hops = journeys.reduce((n, j) => n + j.hops, 0);
  const arrivals = journeys.flatMap((j) => j.arrivals);
  const misplaced = arrivals.filter((a) => Math.hypot(a.x - made.arrival[0], a.z - made.arrival[2]) > 0.05).length;
  const errors = [...new Set(journeys.map((j) => j.error).filter(Boolean))].slice(0, 5);
  Object.assign(result, { hops, arrivals: arrivals.length, misplaced, errors, worlds });
  const portals = worlds.reduce((n, w) => n + (w['portals'] ?? 0), 0);
  const travelled = worlds.reduce((n, w) => n + (w['travelled'] ?? 0), 0);
  ok = hops === bots * loops * 2 && errors.length === 0 && misplaced === 0 && arrivals.length === hops - bots && portals === hops && travelled === hops;
} catch (err) {
  result['error'] = err instanceof Error ? err.message : String(err);
} finally {
  if (ticker) clearInterval(ticker);
  for (const b of active) b.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('hop', { ok, ...result });
process.exit(ok ? 0 : 1);
