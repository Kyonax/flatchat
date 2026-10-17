// SPDX-License-Identifier: MPL-2.0
// One world's database (S2.08, ARCHITECTURE / DATA AND PERSISTENCE): a single SQLite file through
// Node.js's own `node:sqlite`. It keeps the world's state (key-value data in scopes: the world's
// own, and from Stage 3 each plugin's) and where each account last stood. A world in `reset` mode
// starts every run with its state cleared; a `persistent` world carries it over. Moderation records
// (roles and bans, Stage 3) are never cleared by a reset.
import { DatabaseSync } from 'node:sqlite';
import { STORE_LIMITS } from './store-limits.ts';

export type Persistence = 'reset' | 'persistent';

export interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists kv (scope text not null, key text not null, value blob not null, updated_at integer not null, primary key (scope, key));
create table if not exists places (account text primary key, x real not null, y real not null, z real not null, yaw real not null, seen_at integer not null);
create table if not exists roles (account text primary key, role text not null, granted_at integer not null);
create table if not exists bans (account text primary key, until integer, reason text not null, banned_at integer not null);
`;

export { STORE_LIMITS };

export class WorldStore {
  private readonly db: DatabaseSync;
  readonly mode: Persistence;

  private constructor(db: DatabaseSync, mode: Persistence) {
    this.db = db;
    this.mode = mode;
  }

  /** Opens (or makes) the world's file; `:memory:` for none. A reset world forgets its state. */
  static open(path: string, mode: Persistence, now = Date.now()): WorldStore {
    const db = new DatabaseSync(path);
    db.exec('pragma journal_mode = wal; pragma synchronous = normal;');
    db.exec(SCHEMA);
    const store = new WorldStore(db, mode);
    if (mode === 'reset') db.exec('delete from kv; delete from places;');
    store.setMeta('opened_at', String(now));
    store.setMeta('mode', mode);
    return store;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(key, value);
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  get(scope: string, key: string): Uint8Array | undefined {
    const row = this.db.prepare('select value from kv where scope = ? and key = ?').get(scope, key) as { value: Uint8Array } | undefined;
    return row ? new Uint8Array(row.value) : undefined;
  }

  /** Keeps a value; false when it is over the limits. */
  set(scope: string, key: string, value: Uint8Array, now = Date.now()): boolean {
    if (key.length === 0 || key.length > STORE_LIMITS.key || value.length > STORE_LIMITS.value) return false;
    const exists = this.db.prepare('select 1 from kv where scope = ? and key = ?').get(scope, key);
    if (!exists) {
      const count = (this.db.prepare('select count(*) as n from kv where scope = ?').get(scope) as { n: number }).n;
      if (count >= STORE_LIMITS.keys) return false;
    }
    this.db.prepare('insert into kv (scope, key, value, updated_at) values (?, ?, ?, ?) on conflict (scope, key) do update set value = excluded.value, updated_at = excluded.updated_at').run(scope, key, value, now);
    return true;
  }

  delete(scope: string, key: string): void {
    this.db.prepare('delete from kv where scope = ? and key = ?').run(scope, key);
  }

  keys(scope: string): string[] {
    return (this.db.prepare('select key from kv where scope = ? order by key').all(scope) as Array<{ key: string }>).map((r) => r.key);
  }

  /** Where an account last stood here: kept only in a persistent world. */
  place(account: string): Place | undefined {
    if (this.mode !== 'persistent') return undefined;
    const row = this.db.prepare('select x, y, z, yaw from places where account = ?').get(account) as Place | undefined;
    return row ? { x: row.x, y: row.y, z: row.z, yaw: row.yaw } : undefined;
  }

  savePlace(account: string, p: Place, now = Date.now()): void {
    if (this.mode !== 'persistent') return;
    this.db.prepare('insert into places (account, x, y, z, yaw, seen_at) values (?, ?, ?, ?, ?, ?) on conflict (account) do update set x = excluded.x, y = excluded.y, z = excluded.z, yaw = excluded.yaw, seen_at = excluded.seen_at').run(account, p.x, p.y, p.z, p.yaw, now);
  }

  /** An account's role here (S3.06), when it has one besides visitor. Never reset. */
  role(account: string): 'builder' | 'moderator' | 'admin' | undefined {
    const row = this.db.prepare('select role from roles where account = ?').get(account) as { role: string } | undefined;
    return row?.role === 'builder' || row?.role === 'moderator' || row?.role === 'admin' ? row.role : undefined;
  }

  /** Gives a role; `visitor` removes it. The owner's role is never kept here: it comes from the core. */
  setRole(account: string, role: 'visitor' | 'builder' | 'moderator' | 'admin', now = Date.now()): void {
    if (role === 'visitor') this.db.prepare('delete from roles where account = ?').run(account);
    else this.db.prepare('insert into roles (account, role, granted_at) values (?, ?, ?) on conflict (account) do update set role = excluded.role, granted_at = excluded.granted_at').run(account, role, now);
  }

  /** Every role given here. */
  roles(): Array<{ account: string; role: string }> {
    return this.db.prepare('select account, role from roles order by granted_at').all() as Array<{ account: string; role: string }>;
  }

  /** Bans an account in this world (S3.01, S3.07): until a time (ms), or until lifted. Never reset. */
  ban(account: string, until: number | undefined, reason: string, now = Date.now()): void {
    this.db.prepare('insert into bans (account, until, reason, banned_at) values (?, ?, ?, ?) on conflict (account) do update set until = excluded.until, reason = excluded.reason, banned_at = excluded.banned_at').run(account, until ?? null, reason.slice(0, 500), now);
  }

  unban(account: string): void {
    this.db.prepare('delete from bans where account = ?').run(account);
  }

  /** The ban's reason while an account is banned here; a lapsed ban is lifted. */
  banned(account: string, now = Date.now()): string | undefined {
    const row = this.db.prepare('select until, reason from bans where account = ?').get(account) as { until: number | null; reason: string } | undefined;
    if (!row) return undefined;
    if (row.until !== null && row.until <= now) {
      this.unban(account);
      return undefined;
    }
    return row.reason;
  }

  close(): void {
    this.db.close();
  }
}
