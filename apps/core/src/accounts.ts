// SPDX-License-Identifier: AGPL-3.0-or-later
// Accounts by invitation (S1.02) with the age rule and the data-processing authorization (S1.03).
// The owner makes invitations in the admin command line; an invited person sets an email, a
// password, a display name, the birth month and year and the country on the core's own page.
import { type AgePolicy, ageRule } from './age.ts';
import { COUNTRIES } from './countries.ts';
import type { Db, Sql } from './db.ts';
import { decoyHash, digest, hashPassword, newToken, type PasswordCost, verifyPassword } from './secrets.ts';

export interface Account {
  id: string;
  email: string;
  displayName: string;
  birthYear: number;
  birthMonth: number;
  country: string;
  emailVerified: boolean;
  /** The level the owner set by hand: a floor under what the account earns (S3.09). */
  trust: number;
  tester: boolean;
  status: 'active' | 'suspended' | 'banned';
  createdAt: Date;
  /** Days on which it joined a world (S3.09). */
  activeDays: number;
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  country: string;
  email_verified: boolean;
  trust: number;
  tester: boolean;
  status: Account['status'];
  created_at: Date;
  active_days: number;
  password_hash: string;
}

const ACCOUNT_COLUMNS = 'id, email, display_name, birth_year, birth_month, country, email_verified, trust, tester, status, created_at, active_days, password_hash';

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    birthYear: r.birth_year,
    birthMonth: r.birth_month,
    country: r.country.trim(),
    emailVerified: r.email_verified,
    trust: r.trust,
    tester: r.tester,
    status: r.status,
    createdAt: r.created_at,
    activeDays: r.active_days,
  };
}

/** The version of the short privacy notice every account agrees to (the full policy: S7.02). */
// .2: worlds also receive ownership, blocks and a minor's friends; moderation decisions are kept (S3.07).
export const NOTICE_VERSION = '2026-10-17.2';

// ------------------------------------------------------------------------------ the fields

/** The address as given, trimmed; undefined unless it looks like one address. */
export function cleanEmail(email: string): string | undefined {
  const e = email.trim();
  if (e.length < 3 || e.length > 254 || /\s/.test(e)) return undefined;
  const at = e.lastIndexOf('@');
  if (at < 1 || at !== e.indexOf('@') || at === e.length - 1 || !e.slice(at + 1).includes('.')) return undefined;
  return e;
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Letters, marks and digits, with single spaces and . _ ' - between them: no emoji, controls or
 *  direction marks. 3 to 32 characters and at most 64 bytes, the connect token's field. */
export function cleanDisplayName(name: string): string | undefined {
  const n = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const length = [...n].length;
  if (length < 3 || length > 32 || Buffer.byteLength(n, 'utf8') > 64) return undefined;
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} ._'-]*[\p{L}\p{M}\p{N}])?$/u.test(n)) return undefined;
  return n;
}

/** NIST SP 800-63B: a length floor, no composition rules. */
export function passwordProblem(password: string): 'short' | 'long' | undefined {
  const length = [...password].length;
  if (length < 10) return 'short';
  if (length > 256) return 'long';
  return undefined;
}

// --------------------------------------------------------------------------- invitations

export interface NewInvitation {
  note?: string;
  email?: string;
  days?: number;
}

/** Makes an invitation and returns its code, which is shown once and never stored. */
export async function createInvitation(db: Sql, o: NewInvitation, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = newToken(18);
  const expiresAt = new Date(now.getTime() + (o.days ?? 14) * 86_400_000);
  await db.query('insert into invitations (code_hash, note, email_key, created_at, expires_at) values ($1, $2, $3, $4, $5)', [
    digest(code),
    o.note ?? '',
    o.email ? emailKey(o.email) : null,
    now,
    expiresAt,
  ]);
  return { code, expiresAt };
}

export type InvitationState = 'ok' | 'unknown' | 'used' | 'expired' | 'refused';

interface InvitationRow {
  email_key: string | null;
  expires_at: Date;
  used_at: Date | null;
  refused_at: Date | null;
}

function invitationState(row: InvitationRow | undefined, now: Date): InvitationState {
  if (!row) return 'unknown';
  if (row.refused_at) return 'refused';
  if (row.used_at) return 'used';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}

export async function checkInvitation(db: Sql, code: string, now: Date): Promise<InvitationState> {
  const [row] = await db.query<InvitationRow>('select email_key, expires_at, used_at, refused_at from invitations where code_hash = $1', [digest(code)]);
  return invitationState(row, now);
}

// ------------------------------------------------------------------------------- sign-up

export interface SignUp {
  invitation: string;
  email: string;
  password: string;
  displayName: string;
  birthYear: number;
  birthMonth: number;
  country: string;
  consent: boolean;
}

export type SignUpProblem =
  | 'invitation-unknown'
  | 'invitation-used'
  | 'invitation-expired'
  | 'invitation-refused'
  | 'invitation-email'
  | 'email'
  | 'email-taken'
  | 'password-short'
  | 'password-long'
  | 'display-name'
  | 'birth'
  | 'country'
  | 'consent'
  | 'age';

export type SignUpResult = { ok: true; account: Account } | { ok: false; problem: SignUpProblem };

export interface SignUpOptions {
  now: Date;
  cost: PasswordCost;
  policy: AgePolicy;
  /** Open sign-up (S3.03): no invitation needed; the address is verified by mail. */
  open?: boolean;
}

/** Creates an account from an invitation, or without one when sign-up is open (S3.03). The age
 *  rule's refusal spends the invitation and keeps nothing about the person; a mistake in a field
 *  leaves the invitation as it was. */
export async function signUp(db: Db, s: SignUp, o: SignUpOptions): Promise<SignUpResult> {
  const email = cleanEmail(s.email);
  const name = cleanDisplayName(s.displayName);
  const pw = passwordProblem(s.password);
  // Hashed before the transaction: Argon2id takes a tenth of a second and should not hold a lock.
  const hash = email && name && !pw ? await hashPassword(s.password, o.cost) : '';
  return db.tx(async (sql) => {
    const invited = s.invitation !== '' || !o.open;
    const [inv] = invited
      ? await sql.query<InvitationRow>('select email_key, expires_at, used_at, refused_at from invitations where code_hash = $1 for update', [digest(s.invitation)])
      : [];
    if (invited) {
      const state = invitationState(inv, o.now);
      if (state !== 'ok') return { ok: false, problem: `invitation-${state}` as SignUpProblem };
    }
    if (!email) return { ok: false, problem: 'email' };
    if (inv?.email_key && inv.email_key !== emailKey(email)) return { ok: false, problem: 'invitation-email' };
    if (pw) return { ok: false, problem: `password-${pw}` as SignUpProblem };
    if (!name) return { ok: false, problem: 'display-name' };
    if (!COUNTRIES.has(s.country.toUpperCase())) return { ok: false, problem: 'country' };
    const verdict = ageRule({ year: s.birthYear, month: s.birthMonth, country: s.country }, o.now, o.policy);
    if (!verdict.ok && verdict.reason === 'invalid') return { ok: false, problem: 'birth' };
    if (!verdict.ok) {
      if (invited) await sql.query('update invitations set refused_at = $2 where code_hash = $1', [digest(s.invitation), o.now]);
      return { ok: false, problem: 'age' };
    }
    if (!s.consent) return { ok: false, problem: 'consent' };
    const taken = await sql.query('select 1 from accounts where email_key = $1', [emailKey(email)]);
    if (taken.length > 0) return { ok: false, problem: 'email-taken' };
    const [row] = await sql.query<AccountRow>(
      `insert into accounts (email, email_key, password_hash, display_name, birth_year, birth_month, country, email_verified, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${ACCOUNT_COLUMNS}`,
      [email, emailKey(email), hash, name, s.birthYear, s.birthMonth, s.country.toUpperCase(), inv?.email_key === emailKey(email), o.now],
    );
    await sql.query("insert into consents (account_id, kind, notice_version, method, given_at) values ($1, 'data-processing', $2, 'sign-up page', $3)", [
      row!.id,
      NOTICE_VERSION,
      o.now,
    ]);
    if (invited) await sql.query('update invitations set used_at = $2, used_by = $3 where code_hash = $1', [digest(s.invitation), o.now, row!.id]);
    return { ok: true, account: toAccount(row!) };
  });
}

// ------------------------------------------------------------------------------- sign-in

/** A suspended or banned account's id comes back only once its password checked (S3.07). */
export type SignInResult = { ok: true; account: Account } | { ok: false; problem: 'wrong'; account?: undefined } | { ok: false; problem: 'suspended' | 'banned'; account: string };

/** Checks an email and password. A missing address costs the same time as a wrong password. */
export async function checkSignIn(db: Sql, email: string, password: string, decoy: Promise<string>): Promise<SignInResult> {
  const [row] = await db.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from accounts where email_key = $1`, [emailKey(email)]);
  if (!row) {
    await verifyPassword(password, await decoy);
    return { ok: false, problem: 'wrong' };
  }
  if (!(await verifyPassword(password, row.password_hash))) return { ok: false, problem: 'wrong' };
  if (row.status !== 'active') return { ok: false, problem: row.status, account: row.id };
  return { ok: true, account: toAccount(row) };
}

export function makeDecoy(cost: PasswordCost): Promise<string> {
  return decoyHash(cost);
}

export async function accountById(db: Sql, id: string): Promise<Account | undefined> {
  const [row] = await db.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from accounts where id = $1`, [id]);
  return row ? toAccount(row) : undefined;
}

export async function accountByEmail(db: Sql, email: string): Promise<Account | undefined> {
  const [row] = await db.query<AccountRow>(`select ${ACCOUNT_COLUMNS} from accounts where email_key = $1`, [emailKey(email)]);
  return row ? toAccount(row) : undefined;
}
