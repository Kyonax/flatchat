// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign-in through the system browser (DR-22) and account sessions (S1.04).
//
// 1. The client opens a loopback port, makes a PKCE verifier, and asks the core for a login request
//    (its port and the verifier's S256 challenge). It opens /signin?request=ID in the browser.
// 2. The player signs in on the core's own page. The core binds the request to the account and
//    redirects the browser to http://127.0.0.1:PORT/callback with a one-time code (RFC 8252).
// 3. The client trades the request, the code and its verifier for a session: an access token for
//    15 minutes and a refresh token for 30 days that rotates on every use.
//
// There is deliberately no way to poll a request for its result: a link to someone else's request
// would hand that person the session, so the code only ever reaches the port of the machine whose
// browser signed in.
import type { Db, Sql } from './db.ts';
import { challengeOf, digest, newToken } from './secrets.ts';

export const LOGIN_REQUEST_MS = 10 * 60_000;
export const CODE_MS = 60_000;
export const ACCESS_MS = 15 * 60_000;
export const REFRESH_MS = 30 * 86_400_000;

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function validChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && CHALLENGE.test(challenge);
}

export function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export async function createLoginRequest(db: Sql, challenge: string, port: number, now: Date): Promise<{ id: string; expiresAt: Date }> {
  const id = newToken(18);
  const expiresAt = new Date(now.getTime() + LOGIN_REQUEST_MS);
  await db.query('insert into login_requests (id_hash, challenge, port, created_at, expires_at) values ($1, $2, $3, $4, $5)', [
    digest(id),
    challenge,
    port,
    now,
    expiresAt,
  ]);
  return { id, expiresAt };
}

export type LoginRequestState = { ok: true; port: number } | { ok: false; problem: 'unknown' | 'expired' | 'done' };

export async function loginRequestState(db: Sql, id: string, now: Date): Promise<LoginRequestState> {
  const [row] = await db.query<{ port: number; expires_at: Date; account_id: string | null; used_at: Date | null }>(
    'select port, expires_at, account_id, used_at from login_requests where id_hash = $1',
    [digest(id)],
  );
  if (!row) return { ok: false, problem: 'unknown' };
  if (row.used_at || row.account_id) return { ok: false, problem: 'done' };
  if (row.expires_at.getTime() <= now.getTime()) return { ok: false, problem: 'expired' };
  return { ok: true, port: row.port };
}

/** Binds a waiting request to the account that signed in; returns the code and the port to send it to. */
export async function completeLoginRequest(db: Db, id: string, accountId: string, now: Date): Promise<{ code: string; port: number } | undefined> {
  return db.tx(async (sql) => {
    const [row] = await sql.query<{ port: number; expires_at: Date; account_id: string | null; used_at: Date | null }>(
      'select port, expires_at, account_id, used_at from login_requests where id_hash = $1 for update',
      [digest(id)],
    );
    if (!row || row.used_at || row.account_id || row.expires_at.getTime() <= now.getTime()) return undefined;
    const code = newToken(32);
    await sql.query('update login_requests set account_id = $2, code_hash = $3, code_expires_at = $4 where id_hash = $1', [
      digest(id),
      accountId,
      digest(code),
      new Date(now.getTime() + CODE_MS),
    ]);
    return { code, port: row.port };
  });
}

export interface Tokens {
  access: string;
  refresh: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  sessionId: string;
  accountId: string;
}

async function insertSession(sql: Sql, accountId: string, now: Date): Promise<Tokens> {
  const access = newToken(32);
  const refresh = newToken(32);
  const accessExpiresAt = new Date(now.getTime() + ACCESS_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_MS);
  const [row] = await sql.query<{ id: string }>(
    `insert into sessions (account_id, created_at, access_hash, access_expires_at, refresh_hash, refresh_expires_at, last_used_at)
     values ($1, $2, $3, $4, $5, $6, $2) returning id`,
    [accountId, now, digest(access), accessExpiresAt, digest(refresh), refreshExpiresAt],
  );
  return { access, refresh, accessExpiresAt, refreshExpiresAt, sessionId: row!.id, accountId };
}

export type ExchangeProblem = 'unknown' | 'expired' | 'used' | 'code' | 'verifier' | 'inactive';

/** Trades a completed request, its code and the client's verifier for a session (once). */
export async function exchangeCode(db: Db, id: string, code: string, verifier: string, now: Date): Promise<{ ok: true; tokens: Tokens } | { ok: false; problem: ExchangeProblem }> {
  if (!VERIFIER.test(verifier)) return { ok: false, problem: 'verifier' };
  return db.tx(async (sql) => {
    const [row] = await sql.query<{ challenge: string; account_id: string | null; code_hash: Buffer | null; code_expires_at: Date | null; used_at: Date | null; status: string | null }>(
      `select r.challenge, r.account_id, r.code_hash, r.code_expires_at, r.used_at, a.status
         from login_requests r left join accounts a on a.id = r.account_id
        where r.id_hash = $1 for update of r`,
      [digest(id)],
    );
    if (!row) return { ok: false, problem: 'unknown' };
    if (row.used_at) return { ok: false, problem: 'used' };
    if (!row.account_id || !row.code_hash || !row.code_hash.equals(digest(code))) return { ok: false, problem: 'code' };
    // Spent from the first try on: a wrong verifier ends the request too.
    await sql.query('update login_requests set used_at = $2 where id_hash = $1', [digest(id), now]);
    if (!row.code_expires_at || row.code_expires_at.getTime() <= now.getTime()) return { ok: false, problem: 'expired' };
    if (challengeOf(verifier) !== row.challenge) return { ok: false, problem: 'verifier' };
    if (row.status !== 'active') return { ok: false, problem: 'inactive' };
    return { ok: true, tokens: await insertSession(sql, row.account_id, now) };
  });
}

/** Starts a session directly (the admin command line's test sign-ins and the tests). */
export function startSession(db: Sql, accountId: string, now: Date): Promise<Tokens> {
  return insertSession(db, accountId, now);
}

export type RefreshProblem = 'unknown' | 'expired' | 'reused' | 'revoked' | 'inactive';

/** Rotates a session's tokens. A refresh token presented after it was rotated ends the session. */
export async function refreshSession(db: Db, refresh: string, now: Date): Promise<{ ok: true; tokens: Tokens } | { ok: false; problem: RefreshProblem }> {
  return db.tx(async (sql) => {
    const hash = digest(refresh);
    const [row] = await sql.query<{ id: string; account_id: string; refresh_expires_at: Date; revoked_at: Date | null; status: string }>(
      `select s.id, s.account_id, s.refresh_expires_at, s.revoked_at, a.status
         from sessions s join accounts a on a.id = s.account_id where s.refresh_hash = $1 for update of s`,
      [hash],
    );
    if (!row) {
      const [stolen] = await sql.query<{ id: string }>('select id from sessions where previous_refresh_hash = $1 and revoked_at is null', [hash]);
      if (stolen) {
        await sql.query("update sessions set revoked_at = $2, revoked_reason = 'refresh token reused' where id = $1", [stolen.id, now]);
        return { ok: false, problem: 'reused' };
      }
      return { ok: false, problem: 'unknown' };
    }
    if (row.revoked_at) return { ok: false, problem: 'revoked' };
    if (row.refresh_expires_at.getTime() <= now.getTime()) return { ok: false, problem: 'expired' };
    if (row.status !== 'active') return { ok: false, problem: 'inactive' };
    const access = newToken(32);
    const next = newToken(32);
    const accessExpiresAt = new Date(now.getTime() + ACCESS_MS);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_MS);
    await sql.query(
      `update sessions set access_hash = $2, access_expires_at = $3, refresh_hash = $4, refresh_expires_at = $5,
              previous_refresh_hash = $6, last_used_at = $7 where id = $1`,
      [row.id, digest(access), accessExpiresAt, digest(next), refreshExpiresAt, hash, now],
    );
    return { ok: true, tokens: { access, refresh: next, accessExpiresAt, refreshExpiresAt, sessionId: row.id, accountId: row.account_id } };
  });
}

/** The session and account an access token belongs to, while it is valid. */
export async function authenticate(db: Sql, access: string, now: Date): Promise<{ sessionId: string; accountId: string } | undefined> {
  const [row] = await db.query<{ id: string; account_id: string }>(
    `select s.id, s.account_id from sessions s join accounts a on a.id = s.account_id
      where s.access_hash = $1 and s.access_expires_at > $2 and s.revoked_at is null and a.status = 'active'`,
    [digest(access), now],
  );
  return row ? { sessionId: row.id, accountId: row.account_id } : undefined;
}

export async function revokeSession(db: Sql, sessionId: string, reason: string, now: Date): Promise<void> {
  await db.query('update sessions set revoked_at = $2, revoked_reason = $3 where id = $1 and revoked_at is null', [sessionId, now, reason]);
}

/** Ends every session of an account (a suspension, a ban, a password change). */
export async function revokeAccountSessions(db: Sql, accountId: string, reason: string, now: Date): Promise<number> {
  const rows = await db.query('update sessions set revoked_at = $2, revoked_reason = $3 where account_id = $1 and revoked_at is null returning id', [
    accountId,
    now,
    reason,
  ]);
  return rows.length;
}
