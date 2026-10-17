// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's PostgreSQL access (DR-06): one pool, plain parameterised SQL (never text built from
// input), transactions, and the migrations in ./migrations applied in order under an advisory lock.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Anything that runs a query: the pool, or one transaction's connection. */
export interface Sql {
  query<R extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<R[]>;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
// The advisory lock's key: "flatchat" as a number, so two cores starting at once migrate one by one.
const MIGRATION_LOCK = 0x666c6174;

function wrap(client: pg.Pool | pg.PoolClient): Sql {
  return {
    async query<R extends object>(text: string, params: readonly unknown[] = []): Promise<R[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as R[];
    },
  };
}

export class Db implements Sql {
  private readonly pool: pg.Pool;
  private readonly sql: Sql;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, application_name: 'flatchat-core' });
    // A dropped idle connection is reported here instead of crashing the process.
    this.pool.on('error', () => undefined);
    this.sql = wrap(this.pool);
  }

  query<R extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<R[]> {
    return this.sql.query<R>(text, params);
  }

  /** Runs `fn` in one transaction: committed if it returns, rolled back if it throws. */
  async tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(wrap(client));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/** The migration files, in order: `0001-name.sql`, `0002-name.sql`, … */
export function migrationFiles(): Array<{ version: number; name: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}-[a-z0-9-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') }));
}

/** Applies every migration the database has not seen; returns the versions applied. */
export async function migrate(db: Db): Promise<number[]> {
  return db.tx(async (sql) => {
    await sql.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await sql.query('create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())');
    const done = new Set((await sql.query<{ version: number }>('select version from schema_migrations')).map((r) => r.version));
    const applied: number[] = [];
    for (const m of migrationFiles()) {
      if (done.has(m.version)) continue;
      await sql.query(m.sql);
      await sql.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}
