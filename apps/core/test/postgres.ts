// SPDX-License-Identifier: AGPL-3.0-or-later
// A throwaway PostgreSQL for the tests (scripts/pg.ts): a cluster in a temporary folder with fsync
// off, removed afterwards. FLATCHAT_TEST_DB points the tests at a database you run instead.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clusterUrl, startCluster, stopCluster } from '../scripts/pg.ts';

export interface Postgres {
  url: string;
  stop(): void;
}

export function startPostgres(): Postgres {
  // A short path: a Unix socket's path is limited to about 100 bytes.
  const dir = mkdtempSync(join(tmpdir().length < 40 && !/\s/.test(tmpdir()) ? tmpdir() : '/tmp', 'fcpg-'));
  startCluster(dir, { fast: true });
  return {
    url: clusterUrl(dir, 'postgres'),
    stop(): void {
      try {
        stopCluster(dir, true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
