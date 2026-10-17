// SPDX-License-Identifier: MPL-2.0
// The world server's program. It serves one world over raw UDP, WebRTC data channels or both,
// headless, and writes one JSON object per line to stdout: `ready` (the protocol version and
// schema it speaks, and where it listens), `metrics` every few seconds, `stopped` with the run's
// summary. It stops cleanly on SIGINT or SIGTERM, and with --stop-on-stdin on a `stop` line or the end
// of its input (Windows has no SIGTERM handler).
//
//   node src/main.ts [--port 7777] [--transport udp|rtc|both] [--rtc-port 7778] [--signal-port 7779]
//                    [--bind 0.0.0.0] [--rtc-bind ADDR] [--tick-hz 20] [--voice-hz 50] [--ticks N]
//                    [--capacity 200] [--world-size 256] [--metrics-every 5] [--trace FILE]
//                    [--world-id UUID] [--seed N] [--spawn X,Z,R] [--map flat|plaza] [--stop-on-stdin]
//                    [--core URL --relay] [--ice-server URL]… [--map-port] [--world BUILT_DIR]
//
// Hosting from home (S1.13): --relay takes players' WebRTC offers through the core at --core (an
// outbound WebSocket, so no TCP port is opened; the world proves it holds its key), --ice-server adds
// STUN or TURN servers (the core adds its own over the relay), and --map-port asks the router to
// forward the WebRTC UDP port (PCP, NAT-PMP or UPnP; it changes the router, so it is opt-in).
// --world serves a built world (the converter's output: world.json and content/), which players
// download over their connection (S2.04): its bounds, spawn points, solids, flying and maximum
// capacity come from it (--capacity still overrides; --map, --world-size and --spawn do not apply).
// --map plaza serves Stage 1's greybox plaza (packages/sim: a 128 m world with solids, its own
// spawn; --world-size and --spawn do not apply); the default, flat, is an empty square for load tests.
// --port 0 takes any free UDP port; --ticks stops after N ticks (tests and smoke checks). The
// world's key comes from the environment, FLATCHAT_WORLD_KEY (64 hexadecimal characters), never
// from a flag a process listing would show; without it the world takes no joins. Its id comes from
// --world-id or FLATCHAT_WORLD_ID (both printed by the core when it approves the world).
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import { fingerprintHex, fromHex, PROTOCOL_VERSION, WORLD_KEY_BYTES } from '@flatchat/protocol';
import { PLAZA } from '@flatchat/sim';
import { PortMapper } from './net/portmap.ts';
import { CoreRelay } from './net/relay.ts';
import { RtcServer } from './net/rtc.ts';
import type { ServerTransport } from './net/types.ts';
import { UdpServer } from './net/udp.ts';
import { builtOptions, DEFAULT_SERVER, mapOptions, WorldServer } from './server.ts';
import { ContentServer, loadBuiltWorld } from './world/content.ts';

const VERSION = '0.0.0';

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, time: new Date().toISOString(), ...fields })}\n`);
}

function fail(message: string): never {
  log('error', { message });
  process.exit(2);
}

function intOption(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer from ${min} to ${max}, got ${value}`);
  return n;
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7777' },
    transport: { type: 'string', default: 'udp' },
    'rtc-port': { type: 'string', default: '7778' },
    'signal-port': { type: 'string', default: '7779' },
    bind: { type: 'string' },
    'rtc-bind': { type: 'string' },
    'tick-hz': { type: 'string', default: '20' },
    'voice-hz': { type: 'string', default: '50' },
    ticks: { type: 'string' },
    capacity: { type: 'string' },
    'world-size': { type: 'string' },
    'metrics-every': { type: 'string', default: '5' },
    trace: { type: 'string' },
    'stop-on-stdin': { type: 'boolean', default: false },
    'world-id': { type: 'string' },
    seed: { type: 'string', default: '1' },
    spawn: { type: 'string' },
    map: { type: 'string', default: 'flat' },
    world: { type: 'string' },
    core: { type: 'string' },
    relay: { type: 'boolean', default: false },
    'ice-server': { type: 'string', multiple: true },
    'map-port': { type: 'boolean', default: false },
  },
  strict: true,
});

const port = intOption('port', values.port, 0, 65535) ?? 7777;
const rtcPort = intOption('rtc-port', values['rtc-port'], 1, 65535) ?? 7778;
const signalPort = intOption('signal-port', values['signal-port'], 0, 65535) ?? 7779;
const hz = intOption('tick-hz', values['tick-hz'], 1, 1000) ?? 20;
const voiceHz = intOption('voice-hz', values['voice-hz'], 1, 1000) ?? 50;
const maxTicks = intOption('ticks', values.ticks, 1, Number.MAX_SAFE_INTEGER);
const capacity = intOption('capacity', values.capacity, 1, 65_535) ?? 200;
if (values.map !== 'flat' && values.map !== 'plaza') fail(`--map must be flat or plaza, got ${values.map}`);
const plaza = values.map === 'plaza';
if (plaza && (values['world-size'] !== undefined || values.spawn !== undefined)) fail('--map plaza has its own size and spawn: leave out --world-size and --spawn');
const worldSize = plaza ? PLAZA.size : (intOption('world-size', values['world-size'], 32, 65_536) ?? 256);
const metricsEvery = intOption('metrics-every', values['metrics-every'], 0, 3600) ?? 5;
const seed = intOption('seed', values.seed, 0, 2 ** 32 - 1) ?? 1;
let spawn: { x: number; z: number; r: number } | undefined;
if (values.spawn !== undefined) {
  const parts = values.spawn.split(',').map(Number);
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v) || v < 0)) fail(`--spawn must be X,Z,R in metres, got ${values.spawn}`);
  spawn = { x: parts[0]!, z: parts[1]!, r: parts[2]! };
}
const transports = values.transport === 'both' ? ['udp', 'rtc'] : [values.transport];
if (!transports.every((t) => t === 'udp' || t === 'rtc')) fail(`--transport must be udp, rtc or both, got ${values.transport}`);
// The core's `admin world approve` prints FLATCHAT_WORLD_ID beside the key; a flag overrides it.
const worldId = values['world-id'] ?? process.env['FLATCHAT_WORLD_ID'] ?? randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(worldId)) fail('--world-id must be a lowercase UUID');

let worldKey: Uint8Array | undefined;
const keyHex = process.env['FLATCHAT_WORLD_KEY'];
if (keyHex !== undefined) {
  try {
    worldKey = fromHex(keyHex);
  } catch {
    fail('FLATCHAT_WORLD_KEY is not hexadecimal');
  }
  if (worldKey.length !== WORLD_KEY_BYTES) fail(`FLATCHAT_WORLD_KEY must be ${WORLD_KEY_BYTES} bytes`);
}

if (values.relay && (!values.core || !transports.includes('rtc') || !worldKey)) fail('--relay needs --core URL, the rtc transport and FLATCHAT_WORLD_KEY');
if (values.core !== undefined && !/^https?:\/\/[^\s/]+(\/.*)?$/.test(values.core)) fail(`--core must be an http(s) URL, got ${values.core}`);
if (values['map-port'] && !transports.includes('rtc')) fail('--map-port maps the WebRTC port: it needs the rtc transport');

const listening: ServerTransport[] = [];
try {
  if (transports.includes('udp')) listening.push(await UdpServer.listen({ port, ...(values.bind ? { host: values.bind } : {}), maxSessions: capacity + 16 }));
  if (transports.includes('rtc')) {
    listening.push(
      await RtcServer.listen({
        icePort: rtcPort,
        signalPort,
        ...(values.bind ? { host: values.bind } : {}),
        ...(values['rtc-bind'] ? { iceBind: values['rtc-bind'] } : {}),
        maxSessions: capacity + 16,
        iceServers: (values['ice-server'] ?? []).map((urls) => ({ urls })),
      }),
    );
  }
} catch (err) {
  log('error', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

let built: ReturnType<typeof builtOptions> | undefined;
if (values.world !== undefined) {
  if (values.map !== 'flat' || values['world-size'] !== undefined || values.spawn !== undefined) fail('--world brings its own size, spawn points and solids: leave out --map, --world-size and --spawn');
  try {
    const loaded = await loadBuiltWorld(values.world);
    built = builtOptions(loaded, new ContentServer(loaded));
    log('world-loaded', { name: loaded.world.manifest.name, hash: loaded.hash, files: loaded.files.size, colliders: loaded.colliders.length });
  } catch (err) {
    fail(`--world: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const traceOut = values.trace ? createWriteStream(values.trace, { flags: 'w' }) : undefined;
const server = new WorldServer(
  {
    ...DEFAULT_SERVER,
    worldId,
    worldKey,
    build: `flatchat-world ${VERSION}`,
    tickHz: hz,
    voiceHz,
    capacity,
    world: { size: worldSize },
    metricsEverySec: metricsEvery,
    seed,
    ...(spawn ? { spawn } : {}),
    ...(plaza ? mapOptions(PLAZA) : {}),
    ...(built ? { ...built, capacity: values.capacity !== undefined ? capacity : built.capacity } : {}),
    log,
    ...(traceOut ? { trace: (frame) => traceOut.write(`${JSON.stringify(frame)}\n`) } : {}),
  },
  listening,
);

const started = performance.now();
const ticker = server.start(maxTicks);
const where = Object.assign({}, ...listening.map((t) => t.address)) as Record<string, string | number>;
log('ready', {
  version: VERSION,
  protocol: PROTOCOL_VERSION,
  schema: fingerprintHex(),
  port: where['udpPort'] ?? 0,
  ...where,
  transports,
  world: worldId,
  joins: worldKey !== undefined,
  tickHz: hz,
  voiceHz,
  capacity,
  worldSize,
  map: values.map,
  relay: values.relay,
  node: process.version,
  pid: process.pid,
});

const rtc = listening.find((t): t is RtcServer => t instanceof RtcServer);
const relay = values.relay && rtc && worldKey && values.core ? new CoreRelay({ core: values.core, worldId, worldKey, rtc, log }) : undefined;
relay?.start();
const mapper = values['map-port'] ? new PortMapper(rtcPort, log) : undefined;
void mapper?.start();

let stopping = false;
const shutdown = async (reason: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  relay?.stop();
  await mapper?.stop();
  const summary = await server.stop(reason);
  traceOut?.end();
  const tickMs = summary['tickMs'] as { max: number } | undefined;
  log('stopped', { reason, ticks: summary['ticks'], uptimeMs: Math.round(performance.now() - started), slowestTickMs: tickMs?.max ?? 0, summary });
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// Windows delivers no SIGTERM a process can handle, so a parent (the bots' runs, the host tool) asks
// through standard input instead: a line `stop`, or the input closing.
if (values['stop-on-stdin']) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.split('\n').some((line) => line.trim() === 'stop')) void shutdown('stdin');
  });
  process.stdin.on('end', () => void shutdown('stdin'));
}
void ticker.done.then(() => shutdown(maxTicks !== undefined && ticker.ticks >= maxTicks ? 'tick-limit' : 'stopped'));
