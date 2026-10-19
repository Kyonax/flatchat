// SPDX-License-Identifier: AGPL-3.0-or-later
// Moderation in the core (S3.07, G-11, cl-013). The platform suspends or bans an account with a
// reason (the statement of reasons it is shown) and lifts it; a platform ban blocks sign-in and
// joining (and, from Stage 4, uploads and gallery listings). Every decision can be appealed: a
// suspended or banned account appeals from the sign-in page (its password proves it), and the
// owner decides on the admin page; a player banned from a world appeals to that world's owner, who
// decides with the host tool, and a reversed world ban goes to the world over its host channel
// until the world confirms it. Every approved host accepts the host agreement first.
import type { Db, Sql } from './db.ts';
import { digest, newToken } from './secrets.ts';
import { revokeAccountSessions } from './sessions.ts';

/** The host agreement's version (the `agreement` document in strings.ts, served at /host-agreement); a change asks every host to accept again. */
export const HOST_AGREEMENT_VERSION = 1;

export type PlatformAction = 'suspend' | 'ban' | 'lift';
export type AppealDecision = 'uphold' | 'reverse';
export const APPEAL_TOKEN_MS = 60 * 60_000;
export const APPEAL_MAX = 2000;

/** Suspends, bans or lifts an account, recording the reason; a suspension or ban ends its sessions. */
export async function moderateAccount(db: Db, accountId: string, action: PlatformAction, reason: string, actor: string, now: Date): Promise<number> {
  const status = action === 'lift' ? 'active' : action === 'suspend' ? 'suspended' : 'banned';
  const [row] = await db.tx(async (sql) => {
    const rows = await sql.query<{ id: string }>('update accounts set status = $2 where id = $1 returning id', [accountId, status]);
    if (rows.length === 0) return rows;
    await sql.query('insert into moderation_actions (account_id, action, reason, actor, at) values ($1, $2, $3, $4, $5)', [accountId, action, reason.slice(0, 1000), actor, now]);
    return rows;
  });
  if (!row) throw new Error('no such account');
  return action === 'lift' ? 0 : revokeAccountSessions(db, accountId, status, now);
}

export interface Appeal {
  id: string;
  status: 'pending' | 'upheld' | 'reversed';
  createdAt: Date;
  decidedAt: Date | null;
  note: string;
}

/** What a suspended or banned account is shown: the decision, its reason and date, and its latest
 *  appeal against it, if any. */
export async function standing(db: Sql, accountId: string): Promise<{ action: PlatformAction; reason: string; at: Date; appeal: Appeal | undefined } | undefined> {
  const [a] = await db.query<{ id: string; action: PlatformAction; reason: string; at: Date }>("select id, action, reason, at from moderation_actions where account_id = $1 and action <> 'lift' order by at desc, id desc limit 1", [accountId]);
  if (!a) return undefined;
  const [p] = await db.query<{ id: string; status: Appeal['status']; created_at: Date; decided_at: Date | null; note: string }>(
    'select id, status, created_at, decided_at, note from appeals where account_id = $1 and world_id is null and action_id = $2 order by created_at desc limit 1',
    [accountId, a.id],
  );
  return { action: a.action, reason: a.reason, at: a.at, appeal: p ? { id: p.id, status: p.status, createdAt: p.created_at, decidedAt: p.decided_at, note: p.note } : undefined };
}

/** A one-time token for the appeal form a banned account is shown after its password checked. */
export async function appealToken(db: Sql, accountId: string, now: Date): Promise<string> {
  const token = newToken();
  await db.query('delete from appeal_tokens where expires_at < $1', [now]);
  await db.query('insert into appeal_tokens (token_hash, account_id, expires_at) values ($1, $2, $3)', [digest(token), accountId, new Date(now.getTime() + APPEAL_TOKEN_MS)]);
  return token;
}

/** An appeal against the platform's latest decision on the token's account. */
export async function appealDecision(db: Db, token: string, text: string, now: Date): Promise<'ok' | 'expired' | 'nothing' | 'pending'> {
  return db.tx(async (sql) => {
    const [t] = await sql.query<{ account_id: string }>('delete from appeal_tokens where token_hash = $1 and expires_at > $2 returning account_id', [digest(token), now]);
    if (!t) return 'expired';
    const [a] = await sql.query<{ id: string }>("select id from moderation_actions where account_id = $1 and action <> 'lift' order by at desc, id desc limit 1", [t.account_id]);
    if (!a) return 'nothing';
    const open = await sql.query('select 1 from appeals where account_id = $1 and world_id is null and status = $2', [t.account_id, 'pending']);
    if (open.length > 0) return 'pending';
    await sql.query('insert into appeals (account_id, action_id, text, created_at) values ($1, $2, $3, $4)', [t.account_id, a.id, text.slice(0, APPEAL_MAX), now]);
    return 'ok';
  });
}

export interface PlatformAppeal {
  id: string;
  account: string;
  name: string;
  action: string;
  reason: string;
  text: string;
  createdAt: Date;
}

/** Appeals against the platform's decisions that wait for the owner, oldest first. */
export async function pendingPlatformAppeals(db: Sql): Promise<PlatformAppeal[]> {
  const rows = await db.query<{ id: string; account_id: string; display_name: string; action: string; reason: string; text: string; created_at: Date }>(
    `select p.id, p.account_id, a.display_name, m.action, m.reason, p.text, p.created_at from appeals p
       join accounts a on a.id = p.account_id left join moderation_actions m on m.id = p.action_id
      where p.world_id is null and p.status = 'pending' order by p.created_at limit 200`,
  );
  return rows.map((r) => ({ id: r.id, account: r.account_id, name: r.display_name, action: r.action ?? '', reason: r.reason ?? '', text: r.text, createdAt: r.created_at }));
}

/** The owner's decision on an appeal against the platform: reversing it lifts the decision. */
export async function decidePlatformAppeal(db: Db, appealId: string, decision: AppealDecision, note: string, actor: string, now: Date): Promise<boolean> {
  const [p] = await db.query<{ account_id: string }>("update appeals set status = $2, decided_at = $3, decided_by = $4, note = $5 where id = $1 and world_id is null and status = 'pending' returning account_id", [
    appealId,
    decision === 'reverse' ? 'reversed' : 'upheld',
    now,
    actor,
    note.slice(0, 1000),
  ]);
  if (!p) return false;
  if (decision === 'reverse') await moderateAccount(db, p.account_id, 'lift', `reversed on appeal${note ? `: ${note}` : ''}`, actor, now);
  return true;
}

// --------------------------------------------------------------------------------- worlds' bans

/** A player's appeal against a world's ban, to that world's owner. */
export async function appealWorldBan(db: Sql, accountId: string, worldId: string, reason: string, text: string, now: Date): Promise<{ id: string } | 'pending'> {
  const open = await db.query('select 1 from appeals where account_id = $1 and world_id = $2 and status = $3', [accountId, worldId, 'pending']);
  if (open.length > 0) return 'pending';
  const [row] = await db.query<{ id: string }>('insert into appeals (account_id, world_id, reason, text, created_at) values ($1, $2, $3, $4, $5) returning id', [accountId, worldId, reason.slice(0, 500), text.slice(0, APPEAL_MAX), now]);
  return { id: row!.id };
}

/** A player's latest appeal against a world's ban, with its decision. */
export async function myWorldAppeal(db: Sql, accountId: string, worldId: string): Promise<Appeal | undefined> {
  const [p] = await db.query<{ id: string; status: Appeal['status']; created_at: Date; decided_at: Date | null; note: string }>(
    'select id, status, created_at, decided_at, note from appeals where account_id = $1 and world_id = $2 order by created_at desc limit 1',
    [accountId, worldId],
  );
  return p ? { id: p.id, status: p.status, createdAt: p.created_at, decidedAt: p.decided_at, note: p.note } : undefined;
}

export interface WorldAppeal {
  id: string;
  account: string;
  name: string;
  reason: string;
  text: string;
  status: Appeal['status'];
  createdAt: Date;
  note: string;
}

/** Appeals against a world's bans, for its owner: the pending ones, then the last decided. */
export async function worldAppeals(db: Sql, worldId: string): Promise<WorldAppeal[]> {
  const rows = await db.query<{ id: string; account_id: string; display_name: string; reason: string; text: string; status: Appeal['status']; created_at: Date; note: string }>(
    `select p.id, p.account_id, a.display_name, p.reason, p.text, p.status, p.created_at, p.note from appeals p join accounts a on a.id = p.account_id
      where p.world_id = $1 order by (p.status = 'pending') desc, p.created_at desc limit 100`,
    [worldId],
  );
  return rows.map((r) => ({ id: r.id, account: r.account_id, name: r.display_name, reason: r.reason, text: r.text, status: r.status, createdAt: r.created_at, note: r.note }));
}

/** The world owner's decision; a reversal queues the unban for the world. Answers the account a
 *  reversal unbans, or false when there is no such pending appeal. */
export async function decideWorldAppeal(db: Db, worldId: string, appealId: string, decision: AppealDecision, note: string, actor: string, now: Date): Promise<{ account: string | undefined } | false> {
  return db.tx(async (sql) => {
    const [p] = await sql.query<{ account_id: string }>("update appeals set status = $3, decided_at = $4, decided_by = $5, note = $6 where id = $1 and world_id = $2 and status = 'pending' returning account_id", [
      appealId,
      worldId,
      decision === 'reverse' ? 'reversed' : 'upheld',
      now,
      actor,
      note.slice(0, 1000),
    ]);
    if (!p) return false;
    if (decision !== 'reverse') return { account: undefined };
    await sql.query('insert into world_unbans (appeal_id, world_id, account_id, created_at) values ($1, $2, $3, $4)', [appealId, worldId, p.account_id, now]);
    return { account: p.account_id };
  });
}

/** Reversed bans a world has not confirmed yet: sent each time it connects. */
export async function pendingUnbans(db: Sql, worldId: string): Promise<Array<{ appeal: string; account: string }>> {
  const rows = await db.query<{ appeal_id: string; account_id: string }>('select appeal_id, account_id from world_unbans where world_id = $1 and delivered_at is null order by created_at', [worldId]);
  return rows.map((r) => ({ appeal: r.appeal_id, account: r.account_id }));
}

export async function unbanDelivered(db: Sql, worldId: string, appealId: string, now: Date): Promise<void> {
  await db.query('update world_unbans set delivered_at = $3 where appeal_id = $1 and world_id = $2 and delivered_at is null', [appealId, worldId, now]);
}
