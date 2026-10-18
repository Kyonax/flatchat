// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's program: migrates the database, serves the pages and the API, and writes one JSON
// object per line to stdout: `ready` (where it listens), `request` per request (method, route,
// status, time; never a query, a body or a token), `stopped`. It stops cleanly on SIGINT or SIGTERM,
// and with --stop-on-stdin on a `stop` line or the end of its input.
//
//   node --env-file=PATH src/main.ts [--port 8787] [--bind 127.0.0.1] [--stop-on-stdin]
//
// Settings come from the environment (src/config.ts). Bound to 127.0.0.1 by default: in front of
// it sits a Cloudflare Tunnel (DR-16), never an open port.
import { parseArgs } from 'node:util';
import { buildCore, CORE_VERSION } from './app.ts';
import { ConfigError, readEnv } from './config.ts';
import { Db, migrate } from './db.ts';
import { localStore } from './store.ts';

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, time: new Date().toISOString(), ...fields })}\n`);
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    bind: { type: 'string', default: '127.0.0.1' },
    'stop-on-stdin': { type: 'boolean', default: false },
  },
});

let env;
try {
  env = readEnv();
} catch (err) {
  log('error', { message: err instanceof ConfigError ? err.message : String(err) });
  process.exit(2);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  log('error', { message: `--port must be 0 to 65535, got ${values.port}` });
  process.exit(2);
}

const db = new Db(env.db);
const applied = await migrate(db);
const app = await buildCore({
  db,
  secret: env.secret,
  publicUrl: env.publicUrl,
  operator: env.operator,
  contact: env.contact,
  address: env.address,
  phone: env.phone,
  behindTunnel: env.behindTunnel,
  ice: env.ice,
  trust: env.trust,
  signup: env.signup,
  mailer: env.mail,
  policy: { minors: env.minors },
  store: localStore(env.store, env.secret, env.publicUrl),
  avatars: { ktx2: env.ktx2 },
  ...(env.blender ? { blender: env.blender } : {}),
  animations: { ...(env.rhubarb ? { rhubarb: env.rhubarb } : {}) },
  log,
});
const address = await app.listen({ port, host: values.bind });
log('ready', { version: CORE_VERSION, listen: address, publicUrl: env.publicUrl, migrations: applied, pid: process.pid });

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  await db.close();
  log('stopped', { reason });
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
if (values['stop-on-stdin']) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.split('\n').some((line) => line.trim() === 'stop')) void shutdown('stdin');
  });
  process.stdin.on('end', () => void shutdown('stdin'));
}
