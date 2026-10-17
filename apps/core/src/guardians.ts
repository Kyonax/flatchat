// SPDX-License-Identifier: AGPL-3.0-or-later
// The guardian link (S3.04, rr-015, OQ-16). An account aged 13 to 17 (only where the age rule lets
// minors in: not Brazil, and 16 and over in Australia) names a parent or guardian right after its
// sign-up and agrees to supervision; it plays no world until the guardian authorizes. The guardian
// gets a one-time link by mail, reads a plain summary in English or Spanish, signs in or makes an
// adult account and authorizes, expressly including world servers abroad; the core keeps when,
// how, which summary, the teen's own agreement and the abroad authorization. Afterwards the
// guardian's page shows the teen's friends, removes them, and widens or narrows who may reach the
// teen by voice and text (the token's `contact`, S3.10); the teen always sees that it is supervised.
import { isMinor } from './age.ts';
import type { Db, Sql } from './db.ts';
import { digest, newToken } from './secrets.ts';

/** The plain summary the guardian reads: its version is kept with the authorization. */
export const SUMMARY_VERSION = '2026-10-17';
export const STEP_MS = 60 * 60_000;
export const INVITE_MS = 7 * 86_400_000;
export const GUARDIAN_SESSION_MS = 12 * 3_600_000;
export type Contact = 'friends' | 'everyone' | 'none';

/** The one-time token a teen's guardian form carries, made right after its sign-up. */
export async function guardianStep(db: Sql, teenId: string, now: Date): Promise<string> {
  const token = newToken();
  await db.query('insert into guardian_steps (token_hash, teen_id, expires_at) values ($1, $2, $3)', [digest(token), teenId, new Date(now.getTime() + STEP_MS)]);
  return token;
}

/** The teen names its guardian and agrees to supervision; answers the guardian's invitation
 *  token, to be mailed. */
export async function askGuardian(db: Db, step: string, guardianEmailKey: string, now: Date): Promise<{ teen: string; invite: string } | 'expired'> {
  return db.tx(async (sql) => {
    const [s] = await sql.query<{ teen_id: string }>('delete from guardian_steps where token_hash = $1 and expires_at > $2 returning teen_id', [digest(step), now]);
    if (!s) return 'expired';
    const invite = newToken();
    await sql.query(
      `insert into guardian_links (teen_id, guardian_email_key, invite_hash, invite_expires, teen_agreed_at, created_at) values ($1, $2, $3, $4, $5, $5)
       on conflict (teen_id) do update set guardian_email_key = excluded.guardian_email_key, invite_hash = excluded.invite_hash, invite_expires = excluded.invite_expires, teen_agreed_at = excluded.teen_agreed_at
       where guardian_links.authorized_at is null`,
      [s.teen_id, guardianEmailKey, digest(invite), new Date(now.getTime() + INVITE_MS), now],
    );
    return { teen: s.teen_id, invite };
  });
}

/** Who the invitation is for: the teen's display name and the address it named. */
export async function inviteOf(db: Sql, invite: string, now: Date): Promise<{ teen: string; teenName: string; emailKey: string } | undefined> {
  const [r] = await db.query<{ teen_id: string; display_name: string; guardian_email_key: string }>(
    'select g.teen_id, a.display_name, g.guardian_email_key from guardian_links g join accounts a on a.id = g.teen_id where g.invite_hash = $1 and g.invite_expires > $2 and g.authorized_at is null',
    [digest(invite), now],
  );
  return r ? { teen: r.teen_id, teenName: r.display_name, emailKey: r.guardian_email_key } : undefined;
}

export type AuthorizeProblem = 'expired' | 'not-adult' | 'wrong-email' | 'abroad';

/** The guardian (an adult account, the address the teen named) authorizes; the proof is kept. */
export async function authorize(db: Db, invite: string, guardian: { id: string; emailKey: string; birthYear: number; birthMonth: number }, abroad: boolean, now: Date): Promise<'ok' | AuthorizeProblem> {
  if (isMinor(guardian.birthYear, guardian.birthMonth, now)) return 'not-adult';
  // World servers may run abroad: joining any of them needs this express authorization.
  if (!abroad) return 'abroad';
  return db.tx(async (sql) => {
    const [g] = await sql.query<{ teen_id: string; guardian_email_key: string }>('select teen_id, guardian_email_key from guardian_links where invite_hash = $1 and invite_expires > $2 and authorized_at is null for update', [digest(invite), now]);
    if (!g) return 'expired';
    if (g.guardian_email_key !== guardian.emailKey) return 'wrong-email';
    if (g.teen_id === guardian.id) return 'not-adult';
    await sql.query("update guardian_links set guardian_id = $2, authorized_at = $3, method = 'guardian page', summary_version = $4, abroad = true, invite_hash = null where teen_id = $1", [g.teen_id, guardian.id, now, SUMMARY_VERSION]);
    await sql.query("insert into consents (account_id, kind, notice_version, method, given_at) values ($1, 'guardian-authorization', $2, $3, $4)", [g.teen_id, SUMMARY_VERSION, `guardian page: ${guardian.id}`, now]);
    return 'ok';
  });
}

export interface Supervision {
  /** pending: no authorization yet (the teen plays no world); authorized: playing, supervised. */
  state: 'none' | 'pending' | 'authorized';
  contact: Contact;
}

/** Where a teen stands: what the core checks before a join, and what the teen is shown. */
export async function supervisionOf(db: Sql, teenId: string): Promise<Supervision> {
  const [g] = await db.query<{ authorized_at: Date | null; contact: Contact }>('select authorized_at, contact from guardian_links where teen_id = $1', [teenId]);
  return { state: !g ? 'none' : g.authorized_at ? 'authorized' : 'pending', contact: g?.contact ?? 'friends' };
}

export interface Teen {
  id: string;
  name: string;
  contact: Contact;
  friends: Array<{ account: string; name: string }>;
}

/** The teens a guardian supervises, with their friends. */
export async function teensOf(db: Sql, guardianId: string): Promise<Teen[]> {
  const teens = await db.query<{ teen_id: string; display_name: string; contact: Contact }>(
    'select g.teen_id, a.display_name, g.contact from guardian_links g join accounts a on a.id = g.teen_id where g.guardian_id = $1 and g.authorized_at is not null order by a.display_name',
    [guardianId],
  );
  const out: Teen[] = [];
  for (const t of teens) {
    const friends = await db.query<{ id: string; display_name: string }>(
      'select a.id, a.display_name from friends f join accounts a on a.id = case when f.a = $1 then f.b else f.a end where f.a = $1 or f.b = $1 order by a.display_name limit 500',
      [t.teen_id],
    );
    out.push({ id: t.teen_id, name: t.display_name, contact: t.contact, friends: friends.map((f) => ({ account: f.id, name: f.display_name })) });
  }
  return out;
}

/** Whether this account guards that teen (and may change its settings). */
export async function guards(db: Sql, guardianId: string, teenId: string): Promise<boolean> {
  return (await db.query('select 1 from guardian_links where guardian_id = $1 and teen_id = $2 and authorized_at is not null', [guardianId, teenId])).length > 0;
}

export async function setContact(db: Sql, guardianId: string, teenId: string, contact: Contact): Promise<boolean> {
  return (await db.query('update guardian_links set contact = $3 where guardian_id = $1 and teen_id = $2 and authorized_at is not null returning teen_id', [guardianId, teenId, contact])).length > 0;
}

// --------------------------------------------------------------------------- the guardian's page

export async function startGuardianSession(db: Sql, accountId: string, now: Date): Promise<{ cookie: string; csrf: string }> {
  const id = newToken();
  const csrf = newToken(24);
  await db.query('insert into guardian_sessions (id_hash, account_id, csrf, created_at, expires_at) values ($1, $2, $3, $4, $5)', [digest(id), accountId, csrf, now, new Date(now.getTime() + GUARDIAN_SESSION_MS)]);
  return { cookie: id, csrf };
}

export const GUARDIAN_COOKIE = 'fc_guardian';

export async function guardianFromCookie(db: Sql, header: string | undefined, now: Date): Promise<{ accountId: string; csrf: string } | undefined> {
  const raw = (header ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${GUARDIAN_COOKIE}=`))?.slice(GUARDIAN_COOKIE.length + 1);
  if (!raw || raw.length > 128) return undefined;
  const [s] = await db.query<{ account_id: string; csrf: string }>(
    "select s.account_id, s.csrf from guardian_sessions s join accounts a on a.id = s.account_id where s.id_hash = $1 and s.expires_at > $2 and a.status = 'active'",
    [digest(raw), now],
  );
  return s ? { accountId: s.account_id, csrf: s.csrf } : undefined;
}
