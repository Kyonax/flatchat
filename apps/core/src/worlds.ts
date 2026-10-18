// SPDX-License-Identifier: AGPL-3.0-or-later
// Worlds (S1.05) and connect tokens (S1.06). An account registers a world; the owner approves it
// in the admin command line, which makes the 32-byte key the core and that world share (stored
// sealed under the core's secret). To join, a signed-in client asks for a connect token: the
// account's facts sealed for that one world for 60 seconds (sf-001, docs/protocol.md), which the
// world server opens without calling the core.
import { fromHex, newWorldKey, sealToken, type TokenClaims } from '@flatchat/protocol';
import { type Account, accountById } from './accounts.ts';
import { isMinor } from './age.ts';
import type { Db, Sql } from './db.ts';
import { openWorldKey, sealWorldKey } from './secrets.ts';
import { DEFAULT_TRUST, type TrustRule, trustOf } from './trust.ts';
import { tokenLists } from './social.ts';
import { supervisionOf } from './guardians.ts';

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

/** Registers a world (pending until approved); `agreement` is the host agreement's version its host
 *  accepted (S3.07). */
export async function registerWorld(db: Sql, o: { name: string; ownerId: string; address: string; capacity?: number; listed?: boolean; agreement?: number }, now: Date): Promise<World> {
  const [row] = await db.query<WorldRow>(
    `insert into worlds (name, owner_id, address, capacity, listed, created_at, agreement_version, agreement_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
    [o.name, o.ownerId, o.address, o.capacity ?? 50, o.listed ?? true, now, o.agreement ?? null, o.agreement === undefined ? null : now],
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
 *  trust level it earned or was given (S3.09); whether it owns the world (S3.06); who may reach
 *  it (a minor: friends until a guardian changes it, S3.10). */
export function claimsFor(
  account: Account,
  now: Date,
  rules: readonly TrustRule[] = DEFAULT_TRUST,
  world?: { ownerId: string },
  social: { friends: string[]; blocks: string[]; contact?: 'friends' | 'everyone' | 'none' } = { friends: [], blocks: [] },
): TokenClaims {
  const ageDays = Math.max(0, Math.floor((now.getTime() - account.createdAt.getTime()) / 86_400_000));
  const under18 = isMinor(account.birthYear, account.birthMonth, now);
  return {
    account: account.id,
    name: account.displayName,
    trust: trustOf(account, now, rules),
    tester: account.tester,
    emailVerified: account.emailVerified,
    under18,
    ageDays: Math.min(ageDays, 65_535),
    owner: world?.ownerId === account.id,
    // A minor's guardian chooses who may reach it (S3.04); friends until then.
    contact: under18 ? (social.contact ?? 'friends') : 'everyone',
    // A minor's friends (S3.10) and the accounts kept apart by a block either way (S3.11).
    friends: under18 ? social.friends.slice(0, 100) : [],
    blocks: social.blocks.slice(0, 100),
  };
}

export type JoinProblem = 'no-world' | 'not-approved' | 'inactive' | 'guardian-pending';

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
  // A player aged 13 to 17 plays only once its guardian authorized it (S3.04).
  const minor = isMinor(account.birthYear, account.birthMonth, now);
  const supervision = minor ? await supervisionOf(db, account.id) : undefined;
  if (supervision && supervision.state !== 'authorized') return { ok: false, problem: 'guardian-pending' };
  const expiresAt = Math.floor(now.getTime() / 1000) + TOKEN_SECONDS;
  const key = openWorldKey(sealing, row.id, row.key_sealed);
  // A join is activity: once a day it counts toward trust (S3.09), and this token already carries it.
  const today = now.toISOString().slice(0, 10);
  const [counted] = await db.query<{ active_days: number }>(
    'update accounts set active_days = active_days + 1, last_active_day = $2::date where id = $1 and (last_active_day is null or last_active_day < $2::date) returning active_days',
    [account.id, today],
  );
  const social = { ...(await tokenLists(db, account.id, minor)), ...(supervision ? { contact: supervision.contact } : {}) };
  const claims = claimsFor(counted ? { ...account, activeDays: counted.active_days } : account, now, rules, { ownerId: row.owner_id }, social);
  // The avatar the account wears (S4.05), by its manifest's SHA-256: the core vouches for it, so a
  // world shows only what the account owns.
  const [worn] = await db.query<{ manifest_sha256: string | null }>(
    "select v.manifest_sha256 from accounts a join avatars v on v.id = a.avatar_id where a.id = $1 and v.status = 'ready' and v.deleted_at is null",
    [account.id],
  );
  if (worn?.manifest_sha256) claims.avatar = fromHex(worn.manifest_sha256);
  const token = await sealToken(claims, { key, world: row.id, expiresAt });
  return { ok: true, token, address: row.address, expiresAt };
}
