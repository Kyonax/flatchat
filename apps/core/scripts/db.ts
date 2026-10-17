// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's database on this machine, run by your own user (no root, no service, no open port):
//
//   npm run core:db -- start [--dir DIR]   create it the first time, start it, print FLATCHAT_CORE_DB
//   npm run core:db -- stop [--dir DIR]
//   npm run core:db -- status [--dir DIR]
//
// DIR defaults to ~/.local/share/flatchat/core-db (XDG_DATA_HOME when set). It holds the cluster
// and its Unix socket. The database the core uses is called flatchat.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { clusterRunning, clusterUrl, needPgBin, startCluster, stopCluster } from './pg.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' } } });
const dir = values.dir ?? join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'flatchat', 'core-db');
const [command] = positionals;

if (command === 'start') {
  startCluster(dir);
  const bin = needPgBin();
  const exists = execFileSync(join(bin, 'psql'), ['-h', dir, '-U', 'flatchat', '-d', 'postgres', '-tAc', "select 1 from pg_database where datname = 'flatchat'"], { encoding: 'utf8' }).trim();
  if (exists !== '1') execFileSync(join(bin, 'createdb'), ['-h', dir, '-U', 'flatchat', 'flatchat'], { stdio: 'inherit' });
  process.stdout.write(`running in ${dir}\nFLATCHAT_CORE_DB=${clusterUrl(dir, 'flatchat')}\n`);
} else if (command === 'stop') {
  if (clusterRunning(dir)) stopCluster(dir);
  process.stdout.write('stopped\n');
} else if (command === 'status') {
  process.stdout.write(clusterRunning(dir) ? `running in ${dir}\nFLATCHAT_CORE_DB=${clusterUrl(dir, 'flatchat')}\n` : `not running (${dir})\n`);
} else {
  process.stderr.write('usage: npm run core:db -- start|stop|status [--dir DIR]\n');
  process.exit(2);
}
