// SPDX-License-Identifier: MPL-2.0
// The blank world server (Stage 0): binds its UDP port, runs an empty fixed-rate tick and stops
// cleanly on SIGINT or SIGTERM. It writes one JSON object per line to stdout.
//
//   node src/main.ts [--port 7777] [--tick-hz 20] [--ticks N]
//
// --port 0 takes any free port; --ticks stops after N ticks (tests and smoke checks).
import { createSocket } from 'node:dgram';
import { parseArgs } from 'node:util';
import { startTicker } from './ticker.ts';

const VERSION = '0.0.0';

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, time: new Date().toISOString(), ...fields })}\n`);
}

function intOption(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    log('error', { message: `--${name} must be an integer from ${min} to ${max}, got ${value}` });
    process.exit(2);
  }
  return n;
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7777' },
    'tick-hz': { type: 'string', default: '20' },
    ticks: { type: 'string' },
  },
  strict: true,
});

const port = intOption('port', values.port, 0, 65535) ?? 7777;
const hz = intOption('tick-hz', values['tick-hz'], 1, 1000) ?? 20;
const maxTicks = intOption('ticks', values.ticks, 1, Number.MAX_SAFE_INTEGER);

const socket = createSocket('udp4');
socket.on('error', (err) => {
  log('error', { message: err.message });
  process.exit(1);
});

socket.bind(port, () => {
  const started = performance.now();
  let slowest = 0;
  const ticker = startTicker({
    hz,
    onTick: () => {},
    onTiming: (ms) => {
      if (ms > slowest) slowest = ms;
    },
    ...(maxTicks !== undefined ? { maxTicks } : {}),
  });
  log('ready', { version: VERSION, port: socket.address().port, tickHz: hz, node: process.version, pid: process.pid });

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const ticks = await ticker.stop();
    socket.close(() => {
      log('stopped', { reason, ticks, uptimeMs: Math.round(performance.now() - started), slowestTickMs: slowest });
      process.exit(0);
    });
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  void ticker.done.then(() => shutdown(maxTicks !== undefined && ticker.ticks >= maxTicks ? 'tick-limit' : 'stopped'));
});
