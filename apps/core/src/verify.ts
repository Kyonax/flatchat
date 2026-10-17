// SPDX-License-Identifier: AGPL-3.0-or-later
// Email verification (S3.03): a sign-up whose address the core cannot vouch for gets a one-time
// link, valid a day; following it verifies the address (which trust levels need, S3.09).
import type { Db, Sql } from './db.ts';
import { digest, newToken } from './secrets.ts';

export const VERIFY_MS = 24 * 3_600_000;
/** One new link per account every ten minutes, at most. */
export const RESEND_MS = 10 * 60_000;

/** A new verification link's token for an account's current address, or undefined when one was
 *  made in the last ten minutes. */
export async function newVerification(db: Sql, accountId: string, emailKey: string, now: Date): Promise<string | undefined> {
  const recent = await db.query('select 1 from email_verifications where account_id = $1 and created_at > $2', [accountId, new Date(now.getTime() - RESEND_MS)]);
  if (recent.length > 0) return undefined;
  const token = newToken();
  await db.query('insert into email_verifications (token_hash, account_id, email_key, created_at, expires_at) values ($1, $2, $3, $4, $5)', [digest(token), accountId, emailKey, now, new Date(now.getTime() + VERIFY_MS)]);
  return token;
}

/** Follows a link: verifies the address it was made for, if the account still has it. */
export async function verifyEmail(db: Db, token: string, now: Date): Promise<'verified' | 'expired'> {
  return db.tx(async (sql) => {
    const [v] = await sql.query<{ account_id: string; email_key: string }>('delete from email_verifications where token_hash = $1 and expires_at > $2 returning account_id, email_key', [digest(token), now]);
    if (!v) return 'expired';
    const rows = await sql.query('update accounts set email_verified = true where id = $1 and email_key = $2 returning id', [v.account_id, v.email_key]);
    if (rows.length === 0) return 'expired';
    await sql.query('delete from email_verifications where account_id = $1', [v.account_id]);
    return 'verified';
  });
}
