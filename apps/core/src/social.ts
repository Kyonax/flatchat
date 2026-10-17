// SPDX-License-Identifier: AGPL-3.0-or-later
// Friends and blocks (S3.10, S3.11). Friendship is asked and accepted; a block is two-way (each
// side is hidden from the other in every world: avatar, voice, text) and ends any friendship or
// request between them. A minor receives no friend request from a stranger: it asks first (OQ-14).
// Worlds learn only what the connect token carries: the blocked pairs, and a minor's friends.
import { isMinor } from './age.ts';
import type { Db, Sql } from './db.ts';

export const MAX_FRIENDS = 500;
export const MAX_BLOCKS = 1000;
/** How many of each list a connect token carries (the protocol's limit). */
export const TOKEN_LIST = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export interface Person {
  account: string;
  name: string;
}

export interface Friends {
  friends: Person[];
  /** Requests to this account, waiting for its answer. */
  incoming: Person[];
  /** Requests it sent. */
  outgoing: Person[];
}

export async function friendsOf(db: Sql, id: string): Promise<Friends> {
  const named = async (sql: string): Promise<Person[]> => (await db.query<{ id: string; display_name: string }>(sql, [id])).map((r) => ({ account: r.id, name: r.display_name }));
  return {
    friends: await named(`select a.id, a.display_name from friends f join accounts a on a.id = case when f.a = $1 then f.b else f.a end where f.a = $1 or f.b = $1 order by a.display_name limit ${MAX_FRIENDS}`),
    incoming: await named('select a.id, a.display_name from friend_requests r join accounts a on a.id = r.from_id where r.to_id = $1 order by r.created_at desc limit 200'),
    outgoing: await named('select a.id, a.display_name from friend_requests r join accounts a on a.id = r.to_id where r.from_id = $1 order by r.created_at desc limit 200'),
  };
}

export type FriendResult = 'requested' | 'accepted' | 'already' | 'self' | 'no-account' | 'blocked' | 'minor' | 'full';

/** Asks `other` to be friends, or accepts its request. A blocked pair cannot; a minor takes no
 *  request from someone it has not asked (S3.10). */
export async function befriend(db: Db, me: string, other: string, now: Date): Promise<FriendResult> {
  if (!UUID.test(other)) return 'no-account';
  if (other === me) return 'self';
  return db.tx(async (sql) => {
    const [o] = await sql.query<{ birth_year: number; birth_month: number }>("select birth_year, birth_month from accounts where id = $1 and status = 'active'", [other]);
    if (!o) return 'no-account';
    if ((await sql.query('select 1 from blocks where (account_id = $1 and blocked_id = $2) or (account_id = $2 and blocked_id = $1)', [me, other])).length > 0) return 'blocked';
    const [a, b] = pair(me, other);
    if ((await sql.query('select 1 from friends where a = $1 and b = $2', [a, b])).length > 0) return 'already';
    const asked = await sql.query('delete from friend_requests where from_id = $1 and to_id = $2 returning from_id', [other, me]);
    if (asked.length > 0) {
      const [n] = await sql.query<{ n: string }>('select count(*) as n from friends where a = $1 or b = $1', [me]);
      if (Number(n!.n) >= MAX_FRIENDS) return 'full';
      await sql.query('insert into friends (a, b, since) values ($1, $2, $3) on conflict do nothing', [a, b, now]);
      await sql.query('delete from friend_requests where from_id = $1 and to_id = $2', [me, other]);
      return 'accepted';
    }
    // A minor is never asked by a stranger; it may ask, and the other side accept.
    if (isMinor(o.birth_year, o.birth_month, now)) return 'minor';
    await sql.query('insert into friend_requests (from_id, to_id, created_at) values ($1, $2, $3) on conflict do nothing', [me, other, now]);
    return 'requested';
  });
}

/** Ends a friendship, or withdraws or declines a request. */
export async function unfriend(db: Sql, me: string, other: string): Promise<void> {
  if (!UUID.test(other)) return;
  const [a, b] = pair(me, other);
  await db.query('delete from friends where a = $1 and b = $2', [a, b]);
  await db.query('delete from friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)', [me, other]);
}

/** The accounts this account blocked. */
export async function blocksOf(db: Sql, me: string): Promise<string[]> {
  return (await db.query<{ blocked_id: string }>(`select blocked_id from blocks where account_id = $1 order by created_at desc limit ${MAX_BLOCKS}`, [me])).map((r) => r.blocked_id);
}

/** Blocks or unblocks an account; a block ends any friendship or request between the two. */
export async function setBlock(db: Db, me: string, other: string, on: boolean, now: Date): Promise<boolean> {
  if (!UUID.test(other) || other === me) return false;
  if (!on) {
    await db.query('delete from blocks where account_id = $1 and blocked_id = $2', [me, other]);
    return true;
  }
  return db.tx(async (sql) => {
    const [n] = await sql.query<{ n: string }>('select count(*) as n from blocks where account_id = $1', [me]);
    if (Number(n!.n) >= MAX_BLOCKS) return false;
    const rows = await sql.query('insert into blocks (account_id, blocked_id, created_at) select $1, id, $3 from accounts where id = $2 on conflict do nothing returning blocked_id', [me, other, now]);
    const known = rows.length > 0 || (await sql.query('select 1 from blocks where account_id = $1 and blocked_id = $2', [me, other])).length > 0;
    if (!known) return false;
    const [a, b] = pair(me, other);
    await sql.query('delete from friends where a = $1 and b = $2', [a, b]);
    await sql.query('delete from friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)', [me, other]);
    return true;
  });
}

/** What a connect token carries (S3.10, S3.11): the accounts kept apart from this one by a block
 *  either way, newest first, and a minor's friends (an adult's are not the world's business). */
export async function tokenLists(db: Sql, me: string, minor: boolean): Promise<{ friends: string[]; blocks: string[] }> {
  const blocks = (
    await db.query<{ other: string }>(
      `select other from (select blocked_id as other, created_at from blocks where account_id = $1 union all select account_id as other, created_at from blocks where blocked_id = $1) x
        group by other order by max(created_at) desc limit ${TOKEN_LIST}`,
      [me],
    )
  ).map((r) => r.other);
  const friends = minor
    ? (await db.query<{ other: string }>(`select case when a = $1 then b else a end as other from friends where a = $1 or b = $1 order by since desc limit ${TOKEN_LIST}`, [me])).map((r) => r.other)
    : [];
  return { friends, blocks };
}
