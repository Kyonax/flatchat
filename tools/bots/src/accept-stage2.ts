// SPDX-License-Identifier: MPL-2.0
// Stage 2's acceptance run (S2.15), with every real program on this machine. The plan's lines:
//   1. A second world, hosted by someone else, is requested, approved and reached by a portal from
//      the owner's world: a second account asks the core for a world (the host tool's request),
//      the owner approves it on the core's admin page (its sign-in form and CSRF token), and the
//      host fetches its key; the owner's plaza and the host's park lead to each other.
//   2. A world reloads its persistent state after a restart: a player leaves the park somewhere,
//      the park's world server restarts, and the same account comes back to that place.
//   3. Offline mode opens a local world with no core: offline-check.ts, given a client.
//   4. 50 bots and players move between the two worlds: 50 bots make a round trip each through the
//      portals; with a client, the end-to-end test's player travels too.
// "Another machine" is the owner's own run (his second PC); here the second world runs as a second
// program with its own account, key and database.
//
//   node tools/bots/src/accept-stage2.ts [--bots 50] [--client CLIENT] [--keep]
//
// One JSON line: { event: 'accept-stage2', ok, lines } ; exit 0 when every line passed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromHex } from '@flatchat/protocol';
import { PLAZA } from '@flatchat/sim';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';
import { type TravelWorld, Travellers } from './travel.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const OWNER = 'owner@example.org';
const HOST = 'host@example.org';
const PASSWORD = 'an acceptance password';

const { values } = parseArgs({ options: { bots: { type: 'string', default: '50' }, client: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const bots = Number(values.bots);
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const lines: Record<string, Record<string, unknown>> = {};
const dir = mkdtempSync(join(tmpdir(), 'fcaccept-'));
const travellers = new Travellers();
let ok = false;

try {
  // The core and two accounts: the owner (an admin) and a second host.
  const db = (await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'start', '--dir', join(dir, 'pg')])).match(/FLATCHAT_CORE_DB=(\S+)/)?.[1];
  if (!db) throw new Error('no database');
  const corePort = await freePort();
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const coreEnv = { FLATCHAT_CORE_DB: db, FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'), FLATCHAT_CORE_URL: coreUrl, FLATCHAT_CORE_STUN: 'none' };
  const core = await start([process.execPath, join(CORE, 'src', 'main.ts'), '--port', String(corePort), '--stop-on-stdin'], coreEnv, 'ready');
  const admin = (...args: string[]): Promise<string> => run([process.execPath, join(CORE, 'src', 'admin.ts'), ...args], coreEnv);
  const account = async (email: string, name: string): Promise<string> => signUpAndIn(coreUrl, (await admin('invite', '--email', email, '--note', 'acceptance')).match(/invite=(\S+)/)?.[1] ?? '', email, PASSWORD, name);
  await account(OWNER, 'Owner');
  await admin('account', OWNER, '--admin', 'on');
  const hostAccess = await account(HOST, 'Second Host');
  const hostAuth = { authorization: `Bearer ${hostAccess}`, 'content-type': 'application/json' };

  // 1. The owner's world, approved in the admin command line; the host's, asked for and approved.
  const ownerWorld = (await admin('world', 'register', '--name', 'Owner Plaza', '--owner', OWNER, '--address', 'relay', '--capacity', '120')).match(/registered (\S+)/)?.[1];
  const ownerKey = (await admin('world', 'approve', ownerWorld ?? '')).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1];
  if (!ownerWorld || !ownerKey) throw new Error('no owner world');
  const asked = (await (await fetch(`${coreUrl}/api/v1/worlds`, { method: 'POST', headers: hostAuth, body: JSON.stringify({ name: 'Second Park', address: 'relay', capacity: 120, agreement: 1 }) })).json()) as { id?: string; status?: string };
  const hostWorld = asked.id ?? '';
  const pendingKey = await fetch(`${coreUrl}/api/v1/worlds/${hostWorld}/key`, { headers: hostAuth });
  // The owner's admin page: its own sign-in, then the world's approve form with the session's token.
  const signin = await fetch(`${coreUrl}/admin/signin`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: OWNER, password: PASSWORD }), redirect: 'manual' });
  const cookie = (signin.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await (await fetch(`${coreUrl}/admin`, { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
  const approve = await fetch(`${coreUrl}/admin/worlds/${hostWorld}/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }), redirect: 'manual' });
  const keyed = (await (await fetch(`${coreUrl}/api/v1/worlds/${hostWorld}/key`, { headers: hostAuth })).json()) as { key?: string };
  const hostKey = keyed.key ?? '';
  lines['1-approval'] = { asked: asked.status, keyBeforeApproval: pendingKey.status, adminSignin: signin.status, approved: approve.status, key: hostKey.length === 64 };

  // The two worlds: the owner's plaza and the host's park, each with a portal to the other; the
  // park keeps its state (persistent).
  const made = JSON.parse(
    (await run([process.execPath, MAKE_TRAVEL, join(dir, 'travel'), '--worlds', `${ownerWorld},${hostWorld}`, '--names', 'Owner Plaza,Second Park', '--kits', 'plaza,park', '--modes', 'reset,persistent'])).trim().split('\n').at(-1)!,
  ) as Record<'a' | 'b', { portal: [number, number, number]; arrival: [number, number, number] }>;
  const serve = async (id: string, key: string, built: string, data: string): Promise<{ proc: Awaited<ReturnType<typeof start>>; udpPort: number }> => {
    const [rtcPort, signalPort] = [await freePort(), await freePort()];
    const s = await start(
      [
        process.execPath, SERVER_MAIN, '--transport', 'both', '--port', '0', '--rtc-port', String(rtcPort), '--signal-port', String(signalPort), '--bind', '127.0.0.1',
        '--rtc-bind', '127.0.0.1', '--world', built, '--world-id', id, '--data', data, '--capacity', '120', '--metrics-every', '0', '--core', coreUrl, '--relay', '--stop-on-stdin',
      ],
      { FLATCHAT_WORLD_KEY: key },
      'ready',
    );
    await waitFor('the world to reach the core', 15_000, async () => (s.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
    return { proc: s, udpPort: Number(s.lines.find((l) => l['event'] === 'ready')?.['port']) };
  };
  const plaza = await serve(ownerWorld, ownerKey, join(dir, 'travel', 'a.built'), join(dir, 'plaza.db'));
  let park = await serve(hostWorld, hostKey, join(dir, 'travel', 'b.built'), join(dir, 'park.db'));
  const listed = ((await (await fetch(`${coreUrl}/api/v1/worlds`)).json()) as { worlds: Array<{ id: string }> }).worlds.map((w) => w.id);
  lines['1-approval']['bothListed'] = listed.includes(ownerWorld) && listed.includes(hostWorld);

  // 4. 50 bots, each a round trip through the portals (half start in each world).
  travellers.start();
  const parkBrain = { ...DEFAULT_BRAIN, size: 32, scenario: 'hubs' as const };
  const pair: [TravelWorld, TravelWorld] = [
    { id: ownerWorld, key: fromHex(ownerKey), udpPort: plaza.udpPort, portal: { x: made.a.portal[0], z: made.a.portal[2] }, brain: { ...DEFAULT_BRAIN, size: PLAZA.size, scenario: 'plaza' } },
    { id: hostWorld, key: fromHex(hostKey), udpPort: park.udpPort, portal: { x: made.b.portal[0], z: made.b.portal[2] }, brain: parkBrain },
  ];
  const started = performance.now();
  const journeys = await Promise.all(Array.from({ length: bots }, (_, i) => travellers.journey(i, pair, 2)));
  const hops = journeys.reduce((n, j) => n + j.hops, 0);
  const arrivals = journeys.flatMap((j) => j.arrivals);
  const misplaced = arrivals.filter((a) => {
    const at = a.world === ownerWorld ? made.a.arrival : made.b.arrival;
    return Math.hypot(a.x - at[0], a.z - at[2]) > 0.05;
  }).length;
  lines['4-travel'] = { bots, hops, arrivals: arrivals.length, misplaced, seconds: Math.round((performance.now() - started) / 100) / 10, errors: [...new Set(journeys.map((j) => j.error).filter(Boolean))].slice(0, 3) };

  // 2. Persistence: a player leaves the park at a spot; the park restarts; the same account returns there.
  const returning = 'a1e0c0de-0000-4000-8000-00000000c0de';
  let current: Bot | undefined;
  let slot = 0;
  const ticking = setInterval(() => current?.tick((slot += 1), performance.now()), 10);
  const visit = async (goal?: { x: number; z: number }): Promise<Bot> => {
    const b = new Bot({ index: 999, seed: 4242, account: returning, target: { transport: 'udp', host: '127.0.0.1', udpPort: park.udpPort, signalUrl: '', worldId: hostWorld, worldKey: fromHex(hostKey) }, brain: parkBrain, voice: false, chat: false, ...(goal ? { goal } : {}) });
    current = b;
    await b.join();
    return b;
  };
  const spot = { x: 11, z: 26 };
  const first = await visit(spot);
  const joinedAt = first.spawnAt;
  await new Promise((r) => setTimeout(r, 6000));
  first.stop();
  await new Promise((r) => setTimeout(r, 500));
  await stop(park.proc.proc);
  park = await serve(hostWorld, hostKey, join(dir, 'travel', 'b.built'), join(dir, 'park.db'));
  const again = await visit();
  await waitFor('the returning spawn', 5_000, async () => again.spawnAt);
  const back = again.spawnAt;
  again.stop();
  clearInterval(ticking);
  lines['2-persistence'] = { firstSpawn: joinedAt, leftNear: spot, cameBackTo: back, restarted: true };
  const persisted = back !== undefined && Math.hypot(back.x - spot.x, back.z - spot.z) < 1.5;

  // 3 and the players of 4: the real client, if given (offline mode, then the end-to-end path).
  let clientOk = true;
  if (values.client) {
    const offline = JSON.parse((await run([process.execPath, join(ROOT, 'tools', 'bots', 'src', 'offline-check.ts'), values.client]).catch((e: Error) => e.message)).trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; steps?: unknown };
    const e2e = JSON.parse((await run([process.execPath, join(ROOT, 'tools', 'bots', 'src', 'e2e.ts'), values.client]).catch((e: Error) => e.message)).trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; steps?: Record<string, unknown> };
    lines['3-offline'] = { ok: offline.ok === true, steps: offline.steps };
    lines['4-players'] = { ok: e2e.ok === true, travelled: e2e.steps?.['travelled'] };
    clientOk = offline.ok === true && e2e.ok === true;
  } else {
    lines['3-offline'] = { skipped: 'no --client: offline-check.ts runs in CI on every change' };
  }

  await stop(plaza.proc.proc);
  await stop(park.proc.proc);
  await stop(core.proc);
  const a = lines['1-approval'];
  ok =
    a['asked'] === 'pending' &&
    a['keyBeforeApproval'] === 403 &&
    a['approved'] === 303 &&
    a['key'] === true &&
    a['bothListed'] === true &&
    hops === bots * 2 &&
    misplaced === 0 &&
    persisted &&
    clientOk;
} catch (err) {
  lines['error'] = { message: err instanceof Error ? err.message : String(err) };
} finally {
  travellers.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('accept-stage2', { ok, lines });
process.exit(ok ? 0 : 1);
