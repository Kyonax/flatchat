// SPDX-License-Identifier: AGPL-3.0-or-later
// Worlds (S1.05) and connect tokens (S1.06). An account registers a world; the owner approves it
// in the admin command line, which makes the 32-byte key the core and that world share (stored
// sealed under the core's secret). To join, a signed-in client asks for a connect token: the
// account's facts sealed for that one world for 60 seconds (sf-001, docs/protocol.md), which the
// world server opens without calling the core.
import { newWorldKey, sealToken, type TokenClaims } from '@flatchat/protocol';
import { type Account, accountById } from './accounts.ts';
import { isMinor } from './age.ts';
import type { Db, Sql } from './db.ts';
import { openWorldKey, sealWorldKey } from './secrets.ts';
import { DEFAULT_TRUST, type TrustRule, trustOf } from './trust.ts';

export const TOKEN_SECONDS = 60;
/** The most players a world may hold in the MVP (Q-L19): its host sets less. */
export const MAX_CAPACITY = 200;
/** Favourites an account may keep. */
export const MAX_FAVOURITES = 100;

export interface World {
  id: string;
  name: string;
  ownerId: string;
  address: string;
  capacity: number;
  /** On the public list (S2.09), or reached by its id only. */
  listed: boolean;
  status: 'pending' | 'approved' | 'revoked';
  createdAt: Date;
  approvedAt: Date | null;
}

interface WorldRow {
  id: string;
  name: string;
  owner_id: string;
  address: string;
  capacity: number;
  listed: boolean;
  status: World['status'];
  created_at: Date;
  approved_at: Date | null;
  key_sealed: Buffer | null;
}

const COLUMNS = 'id, name, owner_id, address, capacity, listed, status, created_at, approved_at, key_sealed';
const W_COLUMNS = 'w.id, w.name, w.owner_id, w.address, w.capacity, w.listed, w.status, w.created_at, w.approved_at, w.key_sealed';

function toWorld(r: WorldRow): World {
  return { id: r.id, name: r.name, ownerId: r.owner_id, address: r.address, capacity: r.capacity, listed: r.listed, status: r.status, createdAt: r.created_at, approvedAt: r.approved_at };
}

/** 3 to 48 characters, no control or direction characters. */
export function cleanWorldName(name: string): string | undefined {
  const n = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const length = [...n].length;
  if (length < 3 || length > 48) return undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(n)) return undefined;
  return n;
}

/** Where clients reach the world: `relay` (offers go through the core: a world on a home PC,
 *  S1.13), or its own WebRTC signalling URL, https anywhere or http on a private or loopback
 *  address (tests and a LAN). */
export function cleanAddress(address: string): string | undefined {
  if (address.trim() === 'relay') return 'relay';
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hash || url.search) return undefined;
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol !== 'http:') return undefined;
  const host = url.hostname;
  const local = host === 'localhost' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return local ? url.toString() : undefined;
}

export async function registerWorld(db: Sql, o: { name: string; ownerId: string; address: string; capacity?: number; listed?: boolean }, now: Date): Promise<World> {
  const [row] = await db.query<WorldRow>(
    `insert into worlds (name, owner_id, address, capacity, listed, created_at) values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [o.name, o.ownerId, o.address, o.capacity ?? 50, o.listed ?? true, now],
  );
  await db.query("insert into world_events (world_id, kind, actor, at) values ($1, 'registered', $2, $3)", [row!.id, `account:${o.ownerId}`, now]);
  return toWorld(row!);
}

export async function worldById(db: Sql, id: string): Promise<World | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const [row] = await db.query<WorldRow>(`select ${COLUMNS} from worlds where id = $1`, [id]);
  return row ? toWorld(row) : undefined;
}

export async function listWorlds(db: Sql, status?: World['status']): Promise<World[]> {
  const rows = status
    ? await db.query<WorldRow>(`select ${COLUMNS} from worlds where status = $1 order by created_at`, [status])
    : await db.query<WorldRow>(`select ${COLUMNS} from worlds order by created_at`);
  return rows.map(toWorld);
}

/** The worlds that may appear on the public list: approved and listed by their hosts. */
export async function listedWorlds(db: Sql): Promise<World[]> {
  return (await db.query<WorldRow>(`select ${COLUMNS} from worlds where status = 'approved' and listed order by name limit 2000`)).map(toWorld);
}

/** An account's favourite worlds, oldest first, whatever their status. */
export async function favouriteWorlds(db: Sql, accountId: string): Promise<World[]> {
  const rows = await db.query<WorldRow>(
    `select ${W_COLUMNS} from favourites f join worlds w on w.id = f.world_id where f.account_id = $1 order by f.created_at, w.name`,
    [accountId],
  );
  return rows.map(toWorld);
}

/** Adds or removes a favourite. */
export async function setFavourite(db: Sql, accountId: string, worldId: string, on: boolean, now: Date): Promise<'ok' | 'no-world' | 'too-many'> {
  if (!on) {
    await db.query('delete from favourites where account_id = $1 and world_id = $2', [accountId, worldId]);
    return 'ok';
  }
  if (!(await worldById(db, worldId))) return 'no-world';
  const [{ n }] = (await db.query<{ n: number }>('select count(*)::int as n from favourites where account_id = $1', [accountId])) as [{ n: number }];
  if (n >= MAX_FAVOURITES) return 'too-many';
  await db.query('insert into favourites (account_id, world_id, created_at) values ($1, $2, $3) on conflict do nothing', [accountId, worldId, now]);
  return 'ok';
}

/** A host changes its own world: whether it is listed, and its capacity (at most MAX_CAPACITY). */
export async function updateOwnWorld(db: Sql, ownerId: string, id: string, change: { listed?: boolean; capacity?: number }): Promise<World | undefined> {
  const w = await worldById(db, id);
  if (!w || w.ownerId !== ownerId) return undefined;
  const [row] = await db.query<WorldRow>(`update worlds set listed = $2, capacity = $3 where id = $1 returning ${COLUMNS}`, [id, change.listed ?? w.listed, change.capacity ?? w.capacity]);
  return row ? toWorld(row) : undefined;
}

/** Approves a world and returns its new key (shown once, for the world server's environment).
 *  Approving again replaces the key, which also ends every token sealed under the old one. */
export async function approveWorld(db: Db, sealing: Buffer, id: string, actor: string, note: string, now: Date): Promise<Uint8Array<ArrayBuffer>> {
  return db.tx(async (sql) => {
    const [row] = await sql.query<WorldRow>(`select ${COLUMNS} from worlds where id = $1 for update`, [id]);
    if (!row) throw new Error(`no world ${id}`);
    const key = newWorldKey();
    await sql.query("update worlds set status = 'approved', key_sealed = $2, approved_at = $3, revoked_at = null where id = $1", [id, sealWorldKey(sealing, id, key), now]);
    await sql.query("insert into world_events (world_id, kind, actor, note, at) values ($1, 'approved', $2, $3, $4)", [id, actor, note, now]);
    return key;
  });
}

export async function revokeWorld(db: Db, id: string, actor: string, note: string, now: Date): Promise<void> {
  await db.tx(async (sql) => {
    const rows = await sql.query("update worlds set status = 'revoked', key_sealed = null, revoked_at = $2 where id = $1 returning id", [id, now]);
    if (rows.length === 0) throw new Error(`no world ${id}`);
    await sql.query("insert into world_events (world_id, kind, actor, note, at) values ($1, 'revoked', $2, $3, $4)", [id, actor, note, now]);
  });
}

export async function worldEvents(db: Sql, id: string): Promise<Array<{ kind: string; actor: string; note: string; at: Date }>> {
  return db.query('select kind, actor, note, at from world_events where world_id = $1 order by id', [id]);
}

/** What a world learns about a player: never the birth date or the email (S3.10, dp-006); the
 *  trust level it earned or was given (S3.09). */
export function claimsFor(account: Account, now: Date, rules: readonly TrustRule[] = DEFAULT_TRUST): TokenClaims {
  const ageDays = Math.max(0, Math.floor((now.getTime() - account.createdAt.getTime()) / 86_400_000));
  return {
    account: account.id,
    name: account.displayName,
    trust: trustOf(account, now, rules),
    tester: account.tester,
    emailVerified: account.emailVerified,
    under18: isMinor(account.birthYear, account.birthMonth, now),
    ageDays: Math.min(ageDays, 65_535),
  };
}

export type JoinProblem = 'no-world' | 'not-approved' | 'inactive';

export async function connectToken(
  db: Sql,
  sealing: Buffer,
  accountId: string,
  worldId: string,
  now: Date,
  rules: readonly TrustRule[] = DEFAULT_TRUST,
): Promise<{ ok: true; token: Uint8Array; address: string; expiresAt: number } | { ok: false; problem: JoinProblem }> {
  const [row] = /^[0-9a-f-]{36}$/i.test(worldId) ? await db.query<WorldRow>(`select ${COLUMNS} from worlds where id = $1`, [worldId]) : [];
  if (!row) return { ok: false, problem: 'no-world' };
  if (row.status !== 'approved' || !row.key_sealed) return { ok: false, problem: 'not-approved' };
  const account = await accountById(db, accountId);
  if (!account || account.status !== 'active') return { ok: false, problem: 'inactive' };
  const expiresAt = Math.floor(now.getTime() / 1000) + TOKEN_SECONDS;
  const key = openWorldKey(sealing, row.id, row.key_sealed);
  // A join is activity: once a day it counts toward trust (S3.09), and this token already carries it.
  const today = now.toISOString().slice(0, 10);
  const [counted] = await db.query<{ active_days: number }>(
    'update accounts set active_days = active_days + 1, last_active_day = $2::date where id = $1 and (last_active_day is null or last_active_day < $2::date) returning active_days',
    [account.id, today],
  );
  const token = await sealToken(claimsFor(counted ? { ...account, activeDays: counted.active_days } : account, now, rules), { key, world: row.id, expiresAt });
  return { ok: true, token, address: row.address, expiresAt };
}
