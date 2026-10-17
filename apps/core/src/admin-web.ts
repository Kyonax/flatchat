// SPDX-License-Identifier: AGPL-3.0-or-later
// The admin page (S2.10, S3.07): where the owner approves the worlds other hosts ask for and
// revokes them with a reason, suspends, bans or lifts accounts with a reason, and decides the
// appeals against those decisions. It signs in with an admin account's email and password on its own form, and keeps a
// session in an HttpOnly, SameSite=Strict cookie; every form carries the session's CSRF token.
// Sessions last 12 hours and are stored as digests.
import { type CaseRow, DESTINATIONS } from './abuse.ts';
import type { Db, Sql } from './db.ts';
import type { QueuedReport } from './reports.ts';
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
  /** The host agreement's version its host accepted, if any (S3.07). */
  agreement: number | null;
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

/** An appeal against the platform's decision, waiting for the owner (S3.07). */
export interface AdminAppeal {
  id: string;
  account: string;
  name: string;
  action: string;
  reason: string;
  text: string;
  createdAt: Date;
}

const ago = (d: Date, now: Date): string => {
  const h = Math.floor((now.getTime() - d.getTime()) / 3_600_000);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
};

export function adminWorldsPage(
  admin: { email: string; csrf: string },
  worlds: readonly AdminWorld[],
  notice?: string,
  appeals: readonly AdminAppeal[] = [],
  reports: readonly QueuedReport[] = [],
  now = new Date(),
  cases: readonly CaseRow[] = [],
): string {
  const csrf = html`<input type="hidden" name="csrf" value="${admin.csrf}">`;
  // The abuse path (S3.12): open on reports of abuse material or intimate images, folded on others.
  const abusePath = (r: QueuedReport): ReturnType<typeof html> => html`<details${r.category === 'csam' || r.category === 'intimate' ? raw(' open') : ''}><summary>Abuse path</summary>
<form method="post" action="/admin/reports/${r.id}/abuse">${csrf}<select name="kind" aria-label="What it is"><option value="csam">Child sexual abuse material</option><option value="intimate"${r.category === 'intimate' ? raw(' selected') : ''}>Intimate images shared without consent</option></select>
<label class="check"><input type="checkbox" name="uk" value="yes"> Linked to the United Kingdom</label><button type="submit">Take down, preserve, draft the reports</button></form></details>`;
  const abuseCase = (c: CaseRow): ReturnType<typeof html> => html`<tr>
<td><strong>${c.drill ? 'DRILL · ' : ''}${c.kind === 'csam' ? 'Abuse material' : 'Intimate images'}</strong><br><span class="muted">${c.id} · ${ago(c.openedAt, now)}</span></td>
<td>${c.target}<br><span class="muted">${c.removal}</span>${c.clock ? html`<br><strong>${c.clock}</strong>` : ''}
${c.removedAt ? '' : html`<form method="post" action="/admin/abuse/${c.id}/removed">${csrf}<input name="how" aria-label="How it was removed" placeholder="How it was removed" required maxlength="300"><button type="submit">Removed by hand</button></form>`}</td>
<td>${c.preserved ? html`Sealed until ${c.preserveUntil.toISOString().slice(0, 10)}<br><span class="muted">SHA-256 ${c.sha256.slice(0, 16)}…</span>` : 'Purged after its year'}</td>
<td>${
    c.forms.length === 0
      ? raw('<span class="muted">No forms for this kind.</span>')
      : c.forms.map(
          (f) => html`<details><summary>${DESTINATIONS[f.destination].name}: ${f.sentAt ? `filed ${f.sentAt.toISOString().slice(0, 10)}${f.reference ? `, ${f.reference}` : ''}` : 'to file'}</summary><pre class="draft">${f.draft}</pre>
${f.sentAt ? '' : html`<form method="post" action="/admin/abuse/${c.id}/sent">${csrf}<input type="hidden" name="destination" value="${f.destination}"><input name="reference" aria-label="The reference it gave" placeholder="The reference it gave" required maxlength="200"><button type="submit">Filed</button></form>`}</details>`,
        )
  }</td></tr>`;
  // The triage queue (S3.07): abuse material, grooming and threats first, within hours.
  const report = (r: QueuedReport): ReturnType<typeof html> => html`<tr>
<td><strong>${r.urgent ? 'URGENT · ' : ''}${r.category}</strong><br><span class="muted">${r.receipt} · ${ago(r.createdAt, now)}</span></td>
<td>${r.target}<br><span class="muted">from ${r.reporter}</span></td>
<td>${r.text}${r.evidence.chat?.length ? html`<details><summary>Chat (${r.evidence.chat.length} lines)</summary><ul>${r.evidence.chat.map((l) => html`<li>${l.from}: ${l.text}</li>`)}</ul></details>` : ''}
${r.evidence.near?.length ? html`<details><summary>Near (${r.evidence.near.length})</summary><ul>${r.evidence.near.map((p) => html`<li>${p.name} · ${p.account} · ${p.distance} m</li>`)}</ul></details>` : ''}
${r.evidence.speech?.length ? html`<details><summary>Who spoke in the clip</summary><ul>${r.evidence.speech.map((p) => html`<li>${p.name} · ${p.account} · ${Math.round(p.from / 100) / 10}–${Math.round(p.to / 100) / 10} s</li>`)}</ul></details>` : ''}
${r.hasClip ? html`<audio controls preload="none" src="/admin/reports/${r.id}/clip"></audio>` : ''}</td>
<td><form method="post" action="/admin/reports/${r.id}">${csrf}<input name="note" aria-label="The answer" placeholder="The answer (the reporter is told)" maxlength="1000">
${
  r.category === 'underage' && r.targetAccount
    ? html`<button type="submit" name="decision" value="underage-confirmed">Under age: delete the account</button><button type="submit" name="decision" value="underage-cleared" class="secondary">Old enough: lift</button>`
    : html`<button type="submit" name="decision" value="actioned">Acted on it</button><button type="submit" name="decision" value="dismissed" class="secondary">No action</button>`
}</form>${abusePath(r)}</td></tr>`;
  const row = (w: AdminWorld): ReturnType<typeof html> => html`<tr>
<td><strong>${w.name}</strong><br><span class="muted">${w.id}</span></td>
<td>${w.status}${w.agreement ? '' : html`<br><span class="muted">no host agreement</span>`}</td><td>${w.owner}</td><td>${w.address}</td><td>${w.capacity}</td>
<td>${w.status !== 'approved' ? html`<form method="post" action="/admin/worlds/${w.id}/approve">${csrf}<button type="submit">Approve</button></form>` : ''}
${w.status !== 'revoked' ? html`<form method="post" action="/admin/worlds/${w.id}/revoke">${csrf}<input name="note" aria-label="Why it is revoked" placeholder="Why (the host is told)" required maxlength="500"><button type="submit" class="secondary">Revoke</button></form>` : ''}</td></tr>`;
  const appeal = (a: AdminAppeal): ReturnType<typeof html> => html`<tr>
<td><strong>${a.name}</strong><br><span class="muted">${a.account}</span></td>
<td>${a.action}: ${a.reason}</td><td>${a.text}</td><td>${a.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
<td><form method="post" action="/admin/appeals/${a.id}">${csrf}<input name="note" aria-label="The answer" placeholder="The answer (the person is told)" maxlength="1000">
<button type="submit" name="decision" value="reverse">Reverse</button><button type="submit" name="decision" value="uphold" class="secondary">Uphold</button></form></td></tr>`;
  return frame(
    'Worlds',
    html`<h1>Worlds</h1><p class="muted">Signed in as ${admin.email}. <a href="/admin/signout">Sign out</a></p>
${notice ? html`<p role="status">${notice}</p>` : ''}
<table class="list"><thead><tr><th>World</th><th>Status</th><th>Host</th><th>Address</th><th>Capacity</th><th></th></tr></thead>
<tbody>${worlds.map(row)}</tbody></table>
${worlds.length === 0 ? raw('<p class="muted">No worlds yet.</p>') : ''}
<h2>Reports</h2>
${reports.length === 0 ? raw('<p class="muted">No open reports.</p>') : html`<table class="list"><thead><tr><th>Report</th><th>About</th><th>Evidence</th><th></th></tr></thead><tbody>${reports.map(report)}</tbody></table>`}
<h2>The abuse path</h2>
<p class="muted">Abuse material and intimate images come down at once and are preserved, sealed, for a year. Nothing is sent from here: file each draft on its official site, then record the reference it gave. The drill (admin command line: abuse drill) runs it all with a harmless stand-in.</p>
${cases.length === 0 ? raw('<p class="muted">No cases.</p>') : html`<table class="list"><thead><tr><th>Case</th><th>Removed</th><th>Preserved</th><th>Forms</th></tr></thead><tbody>${cases.map(abuseCase)}</tbody></table>`}
<h2>Appeals</h2>
${appeals.length === 0 ? raw('<p class="muted">No appeals wait for a decision.</p>') : html`<table class="list"><thead><tr><th>Account</th><th>Decision</th><th>Appeal</th><th>Sent</th><th></th></tr></thead><tbody>${appeals.map(appeal)}</tbody></table>`}
<h2>Suspend, ban or lift an account</h2>
<form method="post" action="/admin/accounts">${csrf}
<label for="acct-email">Email</label><input id="acct-email" name="email" type="email" required>
<label for="acct-action">Decision</label><select id="acct-action" name="action"><option value="suspend">Suspend</option><option value="ban">Ban</option><option value="lift">Lift</option></select>
<label for="acct-reason">Reason (the person is shown it, and may appeal)</label><input id="acct-reason" name="reason" required maxlength="1000">
<button type="submit">Apply</button></form>`,
  );
}
