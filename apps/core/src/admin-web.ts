// SPDX-License-Identifier: AGPL-3.0-or-later
// The admin page (S2.10): where the owner approves the worlds other hosts ask for, and revokes
// them. It signs in with an admin account's email and password on its own form, and keeps a
// session in an HttpOnly, SameSite=Strict cookie; every form carries the session's CSRF token.
// Sessions last 12 hours and are stored as digests.
import type { Db, Sql } from './db.ts';
import { html, raw } from './pages.ts';
import { digest, newToken } from './secrets.ts';

export const ADMIN_SESSION_MS = 12 * 3_600_000;
export const ADMIN_COOKIE = 'fc_admin';

export async function startAdminSession(db: Sql, accountId: string, now: Date): Promise<{ cookie: string; csrf: string }> {
  const id = newToken(32);
  const csrf = newToken(24);
  await db.query('insert into admin_sessions (id_hash, account_id, csrf, created_at, expires_at) values ($1, $2, $3, $4, $5)', [digest(id), accountId, csrf, now, new Date(now.getTime() + ADMIN_SESSION_MS)]);
  return { cookie: id, csrf };
}

/** The admin behind a cookie, while its session is valid and the account still an active admin. */
export async function adminFromCookie(db: Sql, header: string | undefined, now: Date): Promise<{ accountId: string; csrf: string; email: string } | undefined> {
  const m = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([A-Za-z0-9_-]{20,64})`).exec(header ?? '');
  if (!m) return undefined;
  const [row] = await db.query<{ account_id: string; csrf: string; email: string }>(
    `select s.account_id, s.csrf, a.email from admin_sessions s join accounts a on a.id = s.account_id
      where s.id_hash = $1 and s.expires_at > $2 and a.admin and a.status = 'active'`,
    [digest(m[1]!), now],
  );
  return row ? { accountId: row.account_id, csrf: row.csrf, email: row.email } : undefined;
}

export async function endAdminSession(db: Db, header: string | undefined): Promise<void> {
  const m = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([A-Za-z0-9_-]{20,64})`).exec(header ?? '');
  if (m) await db.query('delete from admin_sessions where id_hash = $1', [digest(m[1]!)]);
}

export interface AdminWorld {
  id: string;
  name: string;
  status: string;
  owner: string;
  address: string;
  capacity: number;
  created: Date;
}

function frame(title: string, body: ReturnType<typeof html>): string {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title} · FlatChat admin</title><link rel="stylesheet" href="/static/core.css"></head>
<body><main class="wide"><div class="brand">FlatChat · admin</div>${body}</main></body></html>`.html;
}

export function adminSigninPage(error?: string): string {
  return frame(
    'Sign in',
    html`<h1>Admin sign-in</h1>
<form method="post" action="/admin/signin">
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>`,
  );
}

export function adminWorldsPage(admin: { email: string; csrf: string }, worlds: readonly AdminWorld[], notice?: string): string {
  const row = (w: AdminWorld): ReturnType<typeof html> => html`<tr>
<td><strong>${w.name}</strong><br><span class="muted">${w.id}</span></td>
<td>${w.status}</td><td>${w.owner}</td><td>${w.address}</td><td>${w.capacity}</td>
<td>${w.status !== 'approved' ? html`<form method="post" action="/admin/worlds/${w.id}/approve"><input type="hidden" name="csrf" value="${admin.csrf}"><button type="submit">Approve</button></form>` : ''}
${w.status !== 'revoked' ? html`<form method="post" action="/admin/worlds/${w.id}/revoke"><input type="hidden" name="csrf" value="${admin.csrf}"><button type="submit" class="secondary">Revoke</button></form>` : ''}</td></tr>`;
  return frame(
    'Worlds',
    html`<h1>Worlds</h1><p class="muted">Signed in as ${admin.email}. <a href="/admin/signout">Sign out</a></p>
${notice ? html`<p role="status">${notice}</p>` : ''}
<table class="list"><thead><tr><th>World</th><th>Status</th><th>Host</th><th>Address</th><th>Capacity</th><th></th></tr></thead>
<tbody>${worlds.map(row)}</tbody></table>
${worlds.length === 0 ? raw('<p class="muted">No worlds yet.</p>') : ''}`,
  );
}
