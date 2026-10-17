// SPDX-License-Identifier: MPL-2.0
// The bots' command line: a measured run (spike S0.07), the quick smoke test the harness runs, a
// report rebuilt from a run's records, and the devlog view of a run.
//
//   node tools/bots/src/run.ts run --transport udp|rtc [--bots 200] [--minutes 30 | --seconds N]
//        [--scenario hubs|crowd] [--no-voice] [--netem "delay 20ms 2ms loss 0.5%"] [--swarms 4]
//        [--server-cpus 0-1] [--bot-cpus 2-7] [--isolate auto|on|off] [--trace] [--out DIR]
//        [--semi-space MB]   (V8's young generation per semi-space, 16 by default as npm run server; 0 = V8's own)
//   node tools/bots/src/run.ts smoke [--bots 12] [--seconds 4]
//   node tools/bots/src/run.ts report DIR
//   node tools/bots/src/run.ts render DIR [--from SECONDS] [--seconds N]
//   FLATCHAT_WORLD_KEY=HEX node tools/bots/src/run.ts visit --signal URL --world-id UUID [--bots 50]
//        [--minutes 30] [--map plaza|flat] [--size 256] [--voice 1] [--chat 1]
//        (S1.12: bots join a world server that is already running, such as the owner's plaza, and
//        stay; one line at the end says how many joined and how many were lost)
//   node tools/bots/src/run.ts client-check -- CLIENT [ARGS…]
//        (a WebRTC world server on loopback, then the client's smoke test told to join it)
//   node tools/bots/src/run.ts voice-check [--seconds 20] [--netem "delay 10ms 10ms loss 2.5%"] -- CLIENT [ARGS…]
//        (spike S0.08: the client joins twice and measures its own voice chain; with --netem the
//        server and the client run in an isolated network with that delay, jitter and loss, the
//        client as the user who started the run. netem acts on each loopback crossing and a voice
//        frame crosses twice, speaker to server to listener: the example is S0.08's line end to
//        end, about 5 % loss and 40 ms of jitter)
//   node tools/bots/src/run.ts lounge [--players 4] [--hours 2]
//        (spike S0.08's listening test: a world server on this machine's LAN address and one
//        client command per player, each with its own token; Ctrl+C stops it)
//
// A run starts one world server and several bot processes (swarms), each pinned to its own cores
// when taskset is there, so the server's tick is timed without the bots on its cores. On Linux it
// runs inside a rootless network namespace (netns.ts) that counts every datagram on the wire. Its
// records go to DIR (default tools/bots/out/<time>-<transport>-<bots>, which git ignores):
// run.json, server.jsonl, swarm-N.jsonl, wire.jsonl, trace.jsonl, report.json and report.md.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, networkInterfaces, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newWorldKey, sealToken, toHex } from '@flatchat/protocol';
import { PLAZA } from '@flatchat/sim';
import type { BotSummary } from './bot.ts';
import { DEFAULT_BRAIN, type Scenario } from './brain.ts';
import { addPrivateAddress, asOuterUser, canIsolate, isIsolated, readCounters, reexecIsolated, setupNetwork } from './netns.ts';
import { analyse, type Line, markdown, type RunConfig } from './report.ts';
import type { SwarmConfig } from './swarm.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
/** V8's young generation fixed at 16 MB per semi-space, as `npm run server` starts it: without it V8 grows
 *  it in steps under the world server's allocation rate (the S-NET report's memory section). */
export const SERVER_V8_FLAGS = (mb = 16): string[] => (mb > 0 ? [`--min-semi-space-size=${mb}`, `--max-semi-space-size=${mb}`] : []);
const SWARM = join(HERE, 'swarm.ts');

function say(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function fail(message: string): never {
  process.stderr.write(`bots: ${message}\n`);
  process.exit(2);
}

/** A child process whose JSON lines are kept and written to a file. */
class Child {
  readonly lines: Line[] = [];
  readonly proc: ChildProcess;
  private waiters: Array<{ event: string; resolve: (l: Line) => void }> = [];
  readonly exited: Promise<number>;

  /** A world server started with --stop-on-stdin stops when its input closes, on Windows too. */
  private readonly stopsOnStdin: boolean;

  constructor(cmd: string[], env: Record<string, string>, file: string | undefined) {
    const [bin, ...args] = cmd;
    this.stopsOnStdin = args.includes('--stop-on-stdin');
    this.proc = spawn(bin!, args, { stdio: [this.stopsOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const out = file ? createWriteStream(file) : undefined;
    let buffer = '';
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        out?.write(`${text}\n`);
        let line: Line;
        try {
          line = JSON.parse(text) as Line;
        } catch {
          continue;
        }
        this.lines.push(line);
        for (const w of this.waiters.filter((x) => x.event === line.event)) w.resolve(line);
        this.waiters = this.waiters.filter((x) => x.event !== line.event);
      }
    });
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => process.stderr.write(chunk));
    this.exited = new Promise((r) =>
      this.proc.on('exit', (code) => {
        out?.end();
        r(code ?? 1);
      }),
    );
  }

  waitFor(event: string, ms: number): Promise<Line> {
    const found = this.lines.find((l) => l.event === event);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`no ${event} line within ${ms} ms`)), ms);
      this.waiters.push({
        event,
        resolve: (l) => {
          clearTimeout(timer);
          res(l);
        },
      });
    });
  }

  /** Stops the child and waits for it. Windows has no SIGTERM handler (kill ends the process at
   *  once), so a world server is asked through its input and its `stopped` summary still arrives. */
  async stop(ms = 15_000): Promise<number> {
    if (this.stopsOnStdin && this.proc.stdin?.writable) this.proc.stdin.end('stop\n');
    else this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), ms);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}

const hasTaskset = process.platform === 'linux' && spawnSync('taskset', ['--version'], { stdio: 'ignore' }).status === 0;
const pinned = (cores: string | undefined, cmd: string[]): string[] => (cores && hasTaskset ? ['taskset', '-c', cores, ...cmd] : cmd);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function machine(): Record<string, string | number> {
  const lib = spawnSync(process.execPath, ['-e', "import('node-datachannel').then((m) => process.stdout.write(m.default.getLibraryVersion()))"], { cwd: join(ROOT, 'apps', 'world-server'), encoding: 'utf8' });
  return { cpu: cpus()[0]?.model ?? '?', cores: cpus().length, node: process.version, kernel: release(), libdatachannel: lib.stdout || '?' };
}

// ------------------------------------------------------------------------ run

interface RunOptions {
  transport: 'udp' | 'rtc';
  bots: number;
  seconds: number;
  scenario: Scenario;
  voice: boolean;
  netem: string;
  swarms: number;
  serverCpus: string | undefined;
  botCpus: string | undefined;
  trace: boolean;
  out: string;
  size: number;
  seed: number;
  /** V8 semi-space size for the server, MB (16, as npm run server); 0 leaves V8's default, which grows on its own. */
  semiSpace: number;
}

async function measuredRun(o: RunOptions): Promise<number> {
  mkdirSync(o.out, { recursive: true });
  const isolated = isIsolated();
  const ports = { udp: 7777, ice: 7778, signal: 7779 };
  if (!isolated) Object.assign(ports, { udp: 0, ice: 20_000 + Math.floor(Math.random() * 30_000), signal: 0 });
  if (isolated) setupNetwork({ mtu: 1500, ports: [ports.udp, ports.ice], ...(o.netem ? { netem: o.netem } : {}) });
  const key = newWorldKey();
  const env = { FLATCHAT_WORLD_KEY: toHex(key) };
  const worldId = randomUUID();
  const serverPort = o.transport === 'udp' ? ports.udp : ports.ice;
  const config: RunConfig = {
    transport: o.transport,
    bots: o.bots,
    seconds: o.seconds,
    scenario: o.scenario,
    voice: o.voice,
    netem: o.netem,
    isolated,
    serverPort,
    machine: { ...machine(), serverCpus: o.serverCpus ?? 'any', botCpus: o.botCpus ?? 'any', swarms: o.swarms, semiSpaceMB: o.semiSpace },
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(o.out, 'run.json'), `${JSON.stringify(config, null, 2)}\n`);

  const server = new Child(
    pinned(o.serverCpus, [
      process.execPath,
      ...SERVER_V8_FLAGS(o.semiSpace),
      SERVER_MAIN,
      '--stop-on-stdin',
      '--transport', o.transport,
      '--port', String(ports.udp),
      '--rtc-port', String(ports.ice),
      '--signal-port', String(ports.signal),
      '--bind', '127.0.0.1',
      '--rtc-bind', '127.0.0.1',
      '--capacity', String(o.bots + 8),
      '--world-size', String(o.size),
      '--metrics-every', '5',
      '--world-id', worldId,
      '--seed', String(o.seed),
      ...(o.trace ? ['--trace', join(o.out, 'trace.jsonl')] : []),
    ]),
    env,
    join(o.out, 'server.jsonl'),
  );
  const ready = await server.waitFor('ready', 15_000);
  const udpPort = Number(ready['udpPort'] ?? ports.udp);
  const signalUrl = `http://127.0.0.1:${Number(ready['signalPort'] ?? ports.signal)}/rtc`;
  say('server-ready', { transport: o.transport, udpPort, signalUrl, isolated });

  const wire = createWriteStream(join(o.out, 'wire.jsonl'));
  const sample = (): void => {
    if (isolated) wire.write(`${JSON.stringify({ t: Date.now(), counters: readCounters() })}\n`);
  };
  sample();
  const sampler = setInterval(sample, 5000);

  const per = Math.ceil(o.bots / o.swarms);
  const swarms: Child[] = [];
  for (let i = 0; i < o.swarms; i++) {
    const count = Math.min(per, o.bots - i * per);
    if (count <= 0) break;
    const sc: SwarmConfig = {
      from: i * per,
      count,
      seed: o.seed,
      transport: o.transport,
      host: '127.0.0.1',
      udpPort,
      signalUrl,
      iceBind: '127.0.0.1',
      worldId,
      brain: { ...DEFAULT_BRAIN, size: o.size, scenario: o.scenario },
      voice: o.voice,
      chat: true,
      joinPerSecond: 10,
      windowSec: 5,
      durationSec: 0,
    };
    swarms.push(new Child(pinned(o.botCpus, [process.execPath, SWARM]), { ...env, FLATCHAT_SWARM: JSON.stringify(sc) }, join(o.out, `swarm-${i}.jsonl`)));
  }
  await Promise.all(swarms.map((s) => s.waitFor('joined', 120_000)));
  const joined = swarms.reduce((n, s) => n + Number(s.lines.find((l) => l.event === 'joined')?.['joined'] ?? 0), 0);
  say('joined', { joined, of: o.bots });

  const end = Date.now() + o.seconds * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(60_000, end - Date.now()));
    const last = server.lines.filter((l) => l.event === 'metrics').at(-1);
    say('progress', { leftS: Math.round((end - Date.now()) / 1000), players: last?.['players'], tickP99: (last?.['tickMs'] as { p99?: number } | undefined)?.p99 });
  }
  await Promise.all(swarms.map((s) => s.stop(30_000)));
  await sleep(500);
  await server.stop(30_000);
  sample();
  clearInterval(sampler);
  wire.end();
  return finish(o.out);
}

function readLines(file: string): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Line);
}

function finish(dir: string): number {
  const config = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunConfig;
  const swarmFiles = readdirSync(dir).filter((f) => /^swarm-\d+\.jsonl$/.test(f)).sort();
  const results = analyse(config, readLines(join(dir, 'server.jsonl')), swarmFiles.map((f) => readLines(join(dir, f))), readLines(join(dir, 'wire.jsonl')));
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(dir, 'report.md'), markdown(results));
  const lines = Object.fromEntries(results.pass.map((p) => [p.id, p.ok]));
  say('report', { dir, pass: lines, joined: results.joined, lost: results.disconnects });
  return results.pass.some((p) => p.ok === false) ? 1 : 0;
}

// ---------------------------------------------------------------------- smoke

async function smokeOne(transport: 'udp' | 'rtc', bots: number, seconds: number): Promise<Record<string, unknown>> {
  const key = newWorldKey();
  const env = { FLATCHAT_WORLD_KEY: toHex(key) };
  const worldId = randomUUID();
  const ice = 20_000 + Math.floor(Math.random() * 30_000);
  const server = new Child(
    [process.execPath, ...SERVER_V8_FLAGS(), SERVER_MAIN, '--stop-on-stdin', '--transport', transport, '--port', '0', '--rtc-port', String(ice), '--signal-port', '0', '--bind', '127.0.0.1', '--rtc-bind', '127.0.0.1', '--capacity', String(bots + 4), '--world-size', '48', '--metrics-every', '0', '--world-id', worldId],
    env,
    undefined,
  );
  const ready = await server.waitFor('ready', 15_000);
  const sc: SwarmConfig = {
    from: 0,
    count: bots,
    seed: 7,
    transport,
    host: '127.0.0.1',
    udpPort: Number(ready['udpPort'] ?? 0),
    signalUrl: `http://127.0.0.1:${Number(ready['signalPort'] ?? 0)}/rtc`,
    iceBind: '127.0.0.1',
    worldId,
    brain: { ...DEFAULT_BRAIN, size: 48, scenario: 'crowd' },
    voice: true,
    chat: true,
    firstTalkWithin: 1,
    joinPerSecond: 40,
    windowSec: 2,
    durationSec: seconds,
  };
  const swarm = new Child([process.execPath, SWARM], { ...env, FLATCHAT_SWARM: JSON.stringify(sc) }, undefined);
  await swarm.exited;
  await server.stop();
  const summary = (swarm.lines.find((l) => l.event === 'summary')?.['bots'] ?? []) as BotSummary[];
  const stopped = server.lines.find((l) => l.event === 'stopped');
  const tick = ((stopped?.['summary'] as Record<string, unknown> | undefined)?.['tickMs'] ?? {}) as { p99?: number };
  const joined = summary.filter((b) => b.entity !== undefined);
  const problems: string[] = [];
  if (joined.length !== bots) problems.push(`${joined.length} of ${bots} joined`);
  const lost = joined.filter((b) => b.lostReason !== '');
  if (lost.length > 0) problems.push(`${lost.length} lost (${lost[0]?.lostReason})`);
  if (joined.some((b) => (b.downMessages['snapshot'] ?? 0) === 0)) problems.push('a bot got no snapshot');
  if (joined.reduce((n, b) => n + b.voiceFrames, 0) === 0) problems.push('no voice was forwarded');
  if (joined.some((b) => b.rtt.n === 0)) problems.push('a bot got no pong');
  if (joined.some((b) => b.corrections > 0 || b.bad > 0)) problems.push('corrections or malformed messages');
  return {
    transport,
    ok: problems.length === 0,
    problems,
    joined: joined.length,
    joinMs: Math.max(0, ...joined.map((b) => b.joinMs)),
    voiceFrames: joined.reduce((n, b) => n + b.voiceFrames, 0),
    tickP99Ms: Math.round((tick.p99 ?? 0) * 100) / 100,
  };
}

// --------------------------------------------------------------------- visit

interface VisitOptions {
  signalUrl: string;
  worldId: string;
  key: string;
  bots: number;
  minutes: number;
  map: 'plaza' | 'flat';
  size: number;
  voice: boolean;
  chat: boolean;
}

/** S1.12: bots join a running world (WebRTC, as players do) and stay for the run. */
async function visit(o: VisitOptions): Promise<number> {
  if (!Number.isInteger(o.bots) || o.bots < 1 || o.bots > 500) fail('--bots must be 1 to 500');
  if (!(o.minutes > 0 && o.minutes <= 600)) fail('--minutes must be more than 0, at most 600');
  const perSwarm = 50;
  const swarms: Child[] = [];
  const started = Date.now();
  for (let from = 0; from < o.bots; from += perSwarm) {
    const sc: SwarmConfig = {
      from,
      count: Math.min(perSwarm, o.bots - from),
      seed: 11,
      transport: 'rtc',
      host: '127.0.0.1',
      udpPort: 0,
      signalUrl: o.signalUrl,
      worldId: o.worldId,
      brain: { ...DEFAULT_BRAIN, size: o.map === 'plaza' ? PLAZA.size : o.size, scenario: o.map === 'plaza' ? 'plaza' : 'hubs' },
      voice: o.voice,
      chat: o.chat,
      joinPerSecond: 10,
      windowSec: 10,
      durationSec: Math.round(o.minutes * 60),
    };
    swarms.push(new Child([process.execPath, SWARM], { FLATCHAT_SWARM: JSON.stringify(sc), FLATCHAT_WORLD_KEY: o.key }, undefined));
  }
  await Promise.all(swarms.map((s) => s.exited));
  const summary = swarms.flatMap((s) => (s.lines.find((l) => l.event === 'summary')?.['bots'] ?? []) as BotSummary[]);
  const joined = summary.filter((b) => b.entity !== undefined);
  const lost = joined.filter((b) => b.lostReason !== '');
  const minutes = (Date.now() - started) / 60_000;
  const downKbps = joined.map((b) => (Object.values(b.down).reduce((n, v) => n + v, 0) * 8) / 1000 / Math.max(1, b.joinedMs / 1000)).sort((a, b) => a - b);
  const result = {
    ok: joined.length === o.bots && lost.length === 0,
    bots: o.bots,
    joined: joined.length,
    lost: lost.length,
    lostReasons: [...new Set(lost.map((b) => b.lostReason))].slice(0, 5),
    refused: [...new Set(summary.filter((b) => b.refuseReason).map((b) => b.refuseReason))],
    corrections: joined.reduce((n, b) => n + b.corrections, 0),
    voiceFrames: joined.reduce((n, b) => n + b.voiceFrames, 0),
    chats: joined.reduce((n, b) => n + b.chats, 0),
    downKbpsP95: Math.round(downKbps[Math.floor(downKbps.length * 0.95)] ?? 0),
    minutes: Math.round(minutes * 10) / 10,
  };
  say('visit', result);
  return result.ok ? 0 : 1;
}

// --------------------------------------------------------------- client-check

/** Runs the real client's smoke test against a world server, over Chromium's own WebRTC. */
async function clientCheck(client: string[]): Promise<number> {
  const key = newWorldKey();
  const worldId = randomUUID();
  const ice = 20_000 + Math.floor(Math.random() * 30_000);
  const server = new Child(
    [process.execPath, ...SERVER_V8_FLAGS(), SERVER_MAIN, '--stop-on-stdin', '--transport', 'rtc', '--rtc-port', String(ice), '--signal-port', '0', '--bind', '127.0.0.1', '--rtc-bind', '127.0.0.1', '--capacity', '4', '--metrics-every', '0', '--world-id', worldId],
    { FLATCHAT_WORLD_KEY: toHex(key) },
    undefined,
  );
  const ready = await server.waitFor('ready', 15_000);
  const url = `http://127.0.0.1:${Number(ready['signalPort'] ?? 0)}/rtc`;
  // Two minutes: a cold CI runner builds nothing here, but the client's first start can be slow.
  const token = await sealToken(
    { account: randomUUID(), name: 'client-check', trust: 1, tester: true, emailVerified: true, under18: false, ageDays: 1 },
    { key, world: worldId, expiresAt: Math.floor(Date.now() / 1000) + 120 },
  );
  const [bin, ...args] = client;
  const proc = spawn(bin!, [...args, `--join=${url}`, `--join-token=${toHex(token)}`], { stdio: 'inherit', shell: process.platform === 'win32' && bin!.endsWith('.cmd') });
  const code = await new Promise<number>((r) => proc.on('exit', (c) => r(c ?? 1)));
  await server.stop();
  const summary = (server.lines.find((l) => l.event === 'stopped')?.['summary'] ?? {}) as { events?: Record<string, { messages: number }> };
  const joins = summary.events?.['join']?.messages ?? 0;
  say('client-check', { clientExit: code, joins, ok: code === 0 && joins === 1 });
  return code === 0 && joins === 1 ? 0 : 1;
}

// ---------------------------------------------------------------- voice-check

/** Spike S0.08's voice test: a world server with a spawn point, two tokens, the client's voice test. */
async function voiceCheck(seconds: number, client: string[], netem: string): Promise<number> {
  let host = '127.0.0.1';
  if (netem && isIsolated()) {
    setupNetwork({ mtu: 1500, netem, ports: [] });
    host = addPrivateAddress() ?? fail('voice-check --netem: cannot add a dummy interface in the namespace (the kernel module `dummy`)');
  }
  const key = newWorldKey();
  const worldId = randomUUID();
  const ice = 20_000 + Math.floor(Math.random() * 30_000);
  const server = new Child(
    [process.execPath, ...SERVER_V8_FLAGS(), SERVER_MAIN, '--stop-on-stdin', '--transport', 'rtc', '--rtc-port', String(ice), '--signal-port', '0', '--bind', host, '--rtc-bind', host, '--capacity', '4', '--metrics-every', '0', '--world-size', '64', '--spawn', '8,32,1', '--world-id', worldId],
    { FLATCHAT_WORLD_KEY: toHex(key) },
    undefined,
  );
  const ready = await server.waitFor('ready', 15_000);
  const url = `http://${host}:${Number(ready['signalPort'] ?? 0)}/rtc`;
  const seal = (name: string): Promise<Uint8Array> =>
    sealToken({ account: randomUUID(), name, trust: 1, tester: true, emailVerified: true, under18: false, ageDays: 1 }, { key, world: worldId, expiresAt: Math.floor(Date.now() / 1000) + 120 });
  const [speaker, listener] = await Promise.all([seal('voice-speaker'), seal('voice-listener')]);
  const [bin, ...args] = asOuterUser(client);
  const proc = spawn(bin!, [...args, `--voice-test=${seconds}`, `--join=${url}`, `--join-token=${toHex(speaker)}`, `--listen-token=${toHex(listener)}`], { stdio: 'inherit' });
  const code = await new Promise<number>((r) => proc.on('exit', (c) => r(c ?? 1)));
  await server.stop();
  say('voice-check', { clientExit: code, ok: code === 0 });
  return code;
}

// --------------------------------------------------------------------- lounge

/** The voice lounge for a listening test across machines: a LAN world server and one command per player. */
async function lounge(players: number, hours: number): Promise<number> {
  const addresses = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
  const lan = addresses.find((a) => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a));
  const overlay = addresses.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a));
  if (!lan && !overlay) fail('no local-network or overlay IPv4 address found');
  const key = newWorldKey();
  const worldId = randomUUID();
  const server = new Child(
    [process.execPath, ...SERVER_V8_FLAGS(), SERVER_MAIN, '--stop-on-stdin', '--transport', 'rtc', '--rtc-port', '7778', '--signal-port', '7779', '--capacity', String(players + 2), '--metrics-every', '0', '--world-size', '96', '--spawn', '48,48,3', '--world-id', worldId],
    { FLATCHAT_WORLD_KEY: toHex(key) },
    undefined,
  );
  await server.waitFor('ready', 15_000);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const url = `http://${lan ?? overlay}:7779/rtc`;
  process.stdout.write(`\nThe voice lounge is open at ${url} (world ${worldId}) until Ctrl+C.\n`);
  if (lan && overlay) process.stdout.write(`From another machine on the same Tailscale network, use http://${overlay}:7779/rtc instead (the internet test).\n`);
  process.stdout.write(`If another machine cannot join, allow TCP 7779 and UDP 7778 in this machine's firewall.\n`);
  process.stdout.write(`On each machine, start the client with one of these lines (each token joins once, for ${hours} h):\n\n`);
  for (let i = 1; i <= players; i++) {
    const token = await sealToken(
      { account: randomUUID(), name: `player-${i}`, trust: 1, tester: true, emailVerified: true, under18: false, ageDays: 1 },
      { key, world: worldId, expiresAt },
    );
    process.stdout.write(`  player ${i}:  <client> --lounge=${url} --join-token=${toHex(token)}\n`);
  }
  process.stdout.write(`\n<client> is apps/client/release/linux-unpacked/flatchat, FlatChat.exe from CI's Windows zip, or \`npx electron apps/client\` after \`npm run build -w @flatchat/client\`.\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await server.stop();
  return 0;
}

// ---------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);
if (command === 'run') {
  const { values } = parseArgs({
    args: rest,
    options: {
      transport: { type: 'string', default: 'udp' },
      bots: { type: 'string', default: '200' },
      minutes: { type: 'string' },
      seconds: { type: 'string' },
      scenario: { type: 'string', default: 'hubs' },
      'no-voice': { type: 'boolean', default: false },
      netem: { type: 'string', default: '' },
      swarms: { type: 'string', default: '4' },
      'server-cpus': { type: 'string' },
      'bot-cpus': { type: 'string' },
      isolate: { type: 'string', default: 'auto' },
      trace: { type: 'boolean', default: false },
      out: { type: 'string' },
      'world-size': { type: 'string', default: '256' },
      seed: { type: 'string', default: '1' },
      'semi-space': { type: 'string', default: '16' },
    },
    strict: true,
  });
  if (values.transport !== 'udp' && values.transport !== 'rtc') fail('--transport must be udp or rtc');
  if (values.scenario !== 'hubs' && values.scenario !== 'crowd') fail('--scenario must be hubs or crowd');
  if (values.isolate !== 'off' && !isIsolated()) {
    if (canIsolate()) process.exit(await reexecIsolated(SCRIPT, process.argv.slice(2)));
    if (values.isolate === 'on') fail('cannot make an isolated network namespace here (unshare -Urn failed)');
  }
  const seconds = values.seconds ? Number(values.seconds) : Number(values.minutes ?? '30') * 60;
  const bots = Number(values.bots);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  process.exit(
    await measuredRun({
      transport: values.transport,
      bots,
      seconds,
      scenario: values.scenario,
      voice: !values['no-voice'],
      netem: values.netem,
      swarms: Number(values.swarms),
      serverCpus: values['server-cpus'],
      botCpus: values['bot-cpus'],
      trace: values.trace,
      out: values.out ?? join(HERE, '..', 'out', `${stamp}-${values.transport}-${bots}`),
      size: Number(values['world-size']),
      seed: Number(values.seed),
      semiSpace: Number(values['semi-space']),
    }),
  );
} else if (command === 'smoke') {
  const { values } = parseArgs({ args: rest, options: { bots: { type: 'string', default: '12' }, seconds: { type: 'string', default: '4' } }, strict: true });
  const bots = Number(values.bots);
  const seconds = Number(values.seconds);
  const results = await Promise.all([smokeOne('udp', bots, seconds), smokeOne('rtc', bots, seconds)]);
  const ok = results.every((r) => r['ok'] === true);
  say('bots-smoke', { ok, results });
  process.exit(ok ? 0 : 1);
} else if (command === 'report') {
  const dir = rest[0] ?? fail('report needs a run directory');
  process.exit(finish(resolve(dir)));
} else if (command === 'client-check') {
  const client = rest[0] === '--' ? rest.slice(1) : rest;
  if (client.length === 0) fail('client-check needs the client command after --');
  process.exit(await clientCheck(client));
} else if (command === 'voice-check') {
  const dash = rest.indexOf('--');
  const own = dash >= 0 ? rest.slice(0, dash) : rest;
  const client = dash >= 0 ? rest.slice(dash + 1) : [];
  const { values } = parseArgs({ args: own, options: { seconds: { type: 'string', default: '20' }, netem: { type: 'string', default: '' } }, strict: true });
  if (client.length === 0) fail('voice-check needs the client command after --');
  if (values.netem && !isIsolated()) {
    if (!canIsolate()) fail('--netem needs an isolated network namespace (unshare -Urn)');
    process.exit(await reexecIsolated(SCRIPT, process.argv.slice(2)));
  }
  process.exit(await voiceCheck(Number(values.seconds), client, values.netem));
} else if (command === 'visit') {
  const { values } = parseArgs({
    args: rest,
    options: {
      signal: { type: 'string' },
      'world-id': { type: 'string' },
      bots: { type: 'string', default: '50' },
      minutes: { type: 'string', default: '30' },
      map: { type: 'string', default: 'plaza' },
      size: { type: 'string', default: '256' },
      voice: { type: 'string', default: '1' },
      chat: { type: 'string', default: '1' },
    },
    strict: true,
  });
  const key = process.env['FLATCHAT_WORLD_KEY'] ?? fail('visit needs the world key in FLATCHAT_WORLD_KEY');
  const signalUrl = values.signal ?? fail('visit needs --signal http(s)://HOST:PORT/rtc');
  const worldId = values['world-id'] ?? process.env['FLATCHAT_WORLD_ID'] ?? fail('visit needs --world-id');
  if (values.map !== 'plaza' && values.map !== 'flat') fail('--map plaza|flat');
  process.exit(await visit({ signalUrl, worldId, key, bots: Number(values.bots), minutes: Number(values.minutes), map: values.map, size: Number(values.size), voice: values.voice === '1', chat: values.chat === '1' }));
} else if (command === 'lounge') {
  const { values } = parseArgs({ args: rest, options: { players: { type: 'string', default: '4' }, hours: { type: 'string', default: '2' } }, strict: true });
  process.exit(await lounge(Number(values.players), Number(values.hours)));
} else if (command === 'render') {
  const { renderRun } = await import('./render.ts');
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { from: { type: 'string', default: '300' }, seconds: { type: 'string', default: '45' } }, strict: true });
  const dir = positionals[0] ?? fail('render needs a run directory');
  process.exit(await renderRun(resolve(dir), Number(values.from), Number(values.seconds)));
} else {
  fail('usage: run.ts run|smoke|report|render|client-check|voice-check|lounge … (see the header of tools/bots/src/run.ts)');
}
