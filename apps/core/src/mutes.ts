// SPDX-License-Identifier: AGPL-3.0-or-later
// Personal mutes (S3.08): a player mutes an account once and does not hear it in any world; the
// client fetches the list when it joins and drops those voices itself.
import type { Sql } from './db.ts';

export const MAX_MUTES = 1000;

export async function mutesOf(db: Sql, accountId: string): Promise<string[]> {
  const rows = await db.query<{ muted_id: string }>('select muted_id from personal_mutes where account_id = $1 order by created_at limit $2', [accountId, MAX_MUTES]);
  return rows.map((r) => r.muted_id);
}

/** Mutes or unmutes an account; false when the account does not exist or the list is full. */
export async function setMute(db: Sql, accountId: string, mutedId: string, on: boolean, now: Date): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(mutedId) || mutedId === accountId) return false;
  if (!on) {
    await db.query('delete from personal_mutes where account_id = $1 and muted_id = $2', [accountId, mutedId]);
    return true;
  }
  const [n] = await db.query<{ n: string }>('select count(*) as n from personal_mutes where account_id = $1', [accountId]);
  if (Number(n!.n) >= MAX_MUTES) return false;
  const rows = await db.query('insert into personal_mutes (account_id, muted_id, created_at) select $1, id, $3 from accounts where id = $2 on conflict do nothing returning muted_id', [accountId, mutedId, now]);
  return rows.length > 0 || (await db.query('select 1 from personal_mutes where account_id = $1 and muted_id = $2', [accountId, mutedId])).length > 0;
}
