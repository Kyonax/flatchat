// SPDX-License-Identifier: AGPL-3.0-or-later
// A private PostgreSQL cluster in a folder, run by the current user: no root, no service, no
// network (it listens only on a Unix socket inside the folder). The tests and `npm run core:db`
// use it. The server's programs are found through PG_BIN, pg_config, PATH, or Debian's
// /usr/lib/postgresql/N/bin (where GitHub's Ubuntu runners keep them).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function findPgBin(): string | undefined {
  const has = (dir: string): boolean => existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'));
  const fromEnv = process.env['PG_BIN'];
  if (fromEnv && has(fromEnv)) return fromEnv;
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (has(dir)) return dir;
  } catch {
    // no pg_config: look further
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) if (dir && has(dir)) return dir;
  const debian = '/usr/lib/postgresql';
  if (existsSync(debian)) {
    for (const v of readdirSync(debian).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a))) {
      if (has(join(debian, v, 'bin'))) return join(debian, v, 'bin');
    }
  }
  return undefined;
}

export function needPgBin(): string {
  const bin = findPgBin();
  if (!bin) throw new Error('PostgreSQL (initdb and pg_ctl) was not found: install it, or set PG_BIN to the folder that holds them');
  return bin;
}

export interface ClusterOptions {
  /** fsync and friends off: for throwaway test clusters only. */
  fast?: boolean;
}

/** The connection string for a database in the cluster at `dir`. */
export function clusterUrl(dir: string, database: string): string {
  return `postgresql://flatchat@localhost/${database}?host=${encodeURIComponent(dir)}`;
}

export function clusterRunning(dir: string): boolean {
  const bin = needPgBin();
  try {
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Creates the cluster if the folder has none, then starts it. A Unix socket path is limited to
 *  about 100 bytes, so `dir` should be short. Spaces are not allowed (pg_ctl passes it on). */
export function startCluster(dir: string, o: ClusterOptions = {}): void {
  if (/\s/.test(dir)) throw new Error(`the cluster's folder may not contain spaces: ${dir}`);
  const bin = needPgBin();
  const data = join(dir, 'data');
  if (!existsSync(join(data, 'PG_VERSION'))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'flatchat', '-A', 'peer', '--auth-local=trust', '-E', 'UTF8', '--locale=C', ...(o.fast ? ['--no-sync'] : [])], { stdio: 'ignore' });
  }
  if (clusterRunning(dir)) return;
  const options = [`-k ${dir}`, '-c listen_addresses=', ...(o.fast ? ['-c fsync=off', '-c synchronous_commit=off', '-c full_page_writes=off'] : [])].join(' ');
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60', '-o', options, 'start'], { stdio: 'ignore' });
}

export function stopCluster(dir: string, immediate = false): void {
  const bin = needPgBin();
  execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', immediate ? 'immediate' : 'fast', '-w', 'stop'], { stdio: 'ignore' });
}
