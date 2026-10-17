// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's own pages: sign-in, sign-up, the privacy notice, an account's standing and appeal
// (S3.07), the host agreement, the public report form (S3.02). Plain HTML forms with no script.
// Every value goes through `html`, which escapes it; only `raw()` marks trusted markup, and only
// this file builds any. The page's policy forbids scripts, frames and outside resources.
import { COUNTRY_CODES } from './countries.ts';
import { type Lang, STRINGS, type Strings } from './strings.ts';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

class Raw {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
}

/** Markup built here; never wrap anything a person typed. */
export function raw(markup: string): Raw {
  return new Raw(markup);
}

/** A template whose values are escaped, unless they are Raw (or arrays of Raw). */
export function html(parts: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = parts[0]!;
  values.forEach((v, i) => {
    const one = (x: unknown): string => (x instanceof Raw ? x.html : escapeHtml(x ?? ''));
    out += Array.isArray(v) ? v.map(one).join('') : one(v);
    out += parts[i + 1]!;
  });
  return new Raw(out);
}

/** The policy on every page: no scripts at all; the sign-in form may lead to the client's loopback port. */
// media-src: the admin page plays a report's voice clip from this server (S3.02).
export const PAGE_POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";

export const CSS = `:root{color-scheme:light dark;--bg:#f5f5f2;--fg:#17171a;--muted:#5d5d66;--line:#d4d4d8;--accent:#c9a20a;--error:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececee;--muted:#a1a1aa;--line:#2e2e33;--accent:#f9cd26;--error:#f2b8b5;--card:#1b1b1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;margin:6vh auto;padding:0 16px}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0 1rem}.muted{color:var(--muted);font-size:.9rem}
form{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px}label{display:block;font-weight:600;margin:.75rem 0 .25rem}
input,select,textarea{width:100%;font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:2px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:8px}.row>*{flex:1}.check{display:flex;gap:8px;align-items:flex-start;font-weight:400}.check input{width:auto;margin-top:.3rem}
button{margin-top:1rem;width:100%;font:inherit;font-weight:600;padding:.6rem;border:0;border-radius:2px;background:var(--accent);color:#121214;cursor:pointer}
.error{color:var(--error);font-weight:600}a{color:inherit}.brand{font-weight:700;letter-spacing:.02em;margin-bottom:1.5rem}
main.wide{max-width:72rem}table.list{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}table.list th,table.list td{text-align:left;padding:8px;border-top:1px solid var(--line);vertical-align:top}
table.list form,form.inline{background:none;border:0;padding:0;display:inline}form.inline button{width:auto;margin:0 0 0 6px;padding:.2rem .6rem}table.list button{width:auto;margin:0 4px 0 0;padding:.3rem .7rem}button.secondary{background:var(--line);color:var(--fg)}pre.draft{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);padding:8px;font-size:.85rem}`;

function page(lang: Lang, title: string, body: Raw): string {
  const s = STRINGS[lang];
  return html`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${title} · ${s.htmlTitle}</title><link rel="stylesheet" href="/static/core.css"></head>
<body><main><div class="brand">FlatChat</div>${body}</main></body></html>`.html;
}

export function messagePage(lang: Lang, title: string, message: string, error = false): string {
  return page(lang, title, html`<h1>${title}</h1><p class="${error ? 'error' : ''}">${message}</p>`);
}

export function signinPage(lang: Lang, request: string, values: { email?: string; error?: string } = {}): string {
  const s = STRINGS[lang];
  return page(
    lang,
    s.signinTitle,
    html`<h1>${s.signinTitle}</h1><p class="muted">${s.signinLead}</p>
<form method="post" action="/signin?lang=${lang}">
${values.error ? html`<p class="error" role="alert">${values.error}</p>` : ''}
<input type="hidden" name="request" value="${request}">
<label for="email">${s.email}</label><input id="email" name="email" type="email" autocomplete="username" required value="${values.email ?? ''}">
<label for="password">${s.password}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${s.signin}</button></form>`,
  );
}

export interface SignupValues {
  email?: string;
  displayName?: string;
  birthYear?: string;
  birthMonth?: string;
  country?: string;
  error?: string;
}

function monthOptions(lang: Lang, chosen: string | undefined): Raw[] {
  const fmt = new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => {
    const name = fmt.format(new Date(Date.UTC(2000, i, 15)));
    const value = String(i + 1);
    return html`<option value="${value}"${chosen === value ? raw(' selected') : ''}>${name}</option>`;
  });
}


function countryOptions(lang: Lang, chosen: string | undefined): Raw[] {
  const names = new Intl.DisplayNames([lang], { type: 'region' });
  const collator = new Intl.Collator(lang);
  return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => collator.compare(a.name, b.name))
    .map(({ code, name }) => html`<option value="${code}"${chosen === code ? raw(' selected') : ''}>${name}</option>`);
}

export function signupPage(lang: Lang, invitation: string, v: SignupValues = {}): string {
  const s = STRINGS[lang];
  return page(
    lang,
    s.signupTitle,
    html`<h1>${s.signupTitle}</h1><p class="muted">${s.signupLead}</p>
<form method="post" action="/signup?lang=${lang}">
${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
<input type="hidden" name="invitation" value="${invitation}">
<label for="email">${s.email}</label><input id="email" name="email" type="email" autocomplete="email" required value="${v.email ?? ''}">
<label for="password">${s.password}</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
<p class="muted">${s.passwordHint}</p>
<label for="displayName">${s.displayName}</label><input id="displayName" name="displayName" required minlength="3" maxlength="32" autocomplete="nickname" value="${v.displayName ?? ''}">
<p class="muted">${s.displayNameHint}</p>
<label>${s.birth}</label><div class="row">
<select name="birthMonth" aria-label="${s.month}" required><option value="">${s.month}</option>${monthOptions(lang, v.birthMonth)}</select>
<input name="birthYear" aria-label="${s.year}" placeholder="${s.year}" inputmode="numeric" pattern="[0-9]{4}" required value="${v.birthYear ?? ''}"></div>
<label for="country">${s.country}</label><select id="country" name="country" required><option value="">${s.chooseCountry}</option>${countryOptions(lang, v.country)}</select>
<label class="check"><input type="checkbox" name="consent" value="yes" required> <span>${s.consent} <a href="/privacy?lang=${lang}" target="_blank" rel="noopener">${s.privacyLink}</a></span></label>
<button type="submit">${s.create}</button></form>`,
  );
}

export function privacyPage(lang: Lang, operator: string, contact: string): string {
  const s: Strings = STRINGS[lang];
  const paragraphs = s.privacy.map((p) => p.replace('{operator}', operator).replace('{contact}', contact));
  return page(lang, s.privacyTitle, html`<h1>${s.privacyTitle}</h1>${paragraphs.map((p) => html`<p>${p}</p>`)}`);
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

export interface Standing {
  action: 'suspend' | 'ban' | 'lift';
  reason: string;
  at: Date;
  appeal: { status: 'pending' | 'upheld' | 'reversed'; createdAt: Date; decidedAt: Date | null; note: string } | undefined;
}

/** What a suspended or banned account sees after its password checked (S3.07): the decision, its
 *  reason (the statement of reasons), and the appeal form or where its appeal stands. */
export function standingPage(lang: Lang, status: 'suspended' | 'banned', st: Standing | undefined, appealToken: string | undefined, error?: string): string {
  const s = STRINGS[lang];
  // A status set without a recorded decision (before S3.07) has no reason to show.
  const decision = st
    ? html`<p>${(st.action === 'suspend' ? s.suspendedSince : s.bannedSince).replace('{date}', day(st.at))}</p><p>${s.standingReason.replace('{reason}', st.reason)}</p>`
    : html`<p>${status === 'suspended' ? s.signinSuspended : s.signinBanned}</p>`;
  const a = st?.appeal;
  const appealLine = a
    ? a.status === 'pending'
      ? html`<p role="status">${s.appealPending.replace('{date}', day(a.createdAt))}</p>`
      : html`<p role="status">${s.appealUpheld.replace('{date}', day(a.decidedAt ?? a.createdAt))}</p>${a.note ? html`<p>${s.appealNote.replace('{note}', a.note)}</p>` : ''}`
    : '';
  const form =
    st && !a && appealToken
      ? html`<p class="muted">${s.appealLead}</p>
<form method="post" action="/appeal?lang=${lang}">
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<input type="hidden" name="token" value="${appealToken}">
<label for="text">${s.appealText}</label><textarea id="text" name="text" rows="6" maxlength="2000" required></textarea>
<button type="submit">${s.appealSend}</button></form>`
      : '';
  return page(lang, s.standingTitle, html`<h1>${s.standingTitle}</h1>${decision}${appealLine}${form}`);
}

/** The host agreement every approved host accepts (S3.07, S2.10). */
export function agreementPage(lang: Lang, version: number): string {
  const s = STRINGS[lang];
  return page(lang, s.agreementTitle, html`<h1>${s.agreementTitle}</h1><p>${s.agreementLead.replace('{version}', String(version))}</p><ol>${s.agreement.map((p) => html`<li>${p}</li>`)}</ol>`);
}

/** The public report form, for people without an account (S3.02, OQ-12). */
export function reportPage(lang: Lang, categories: readonly string[], values: { category?: string; what?: string; text?: string; contact?: string; error?: string } = {}): string {
  const s = STRINGS[lang];
  const options = categories.map((c) => html`<option value="${c}"${values.category === c ? raw(' selected') : ''}>${(s.categories as Record<string, string>)[c] ?? c}</option>`);
  return page(
    lang,
    s.reportTitle,
    html`<h1>${s.reportTitle}</h1><p class="muted">${s.reportLead}</p>
<form method="post" action="/report?lang=${lang}">
${values.error ? html`<p class="error" role="alert">${values.error}</p>` : ''}
<label for="category">${s.reportCategory}</label><select id="category" name="category">${options}</select>
<label for="what">${s.reportWhat}</label><input id="what" name="what" maxlength="300" value="${values.what ?? ''}">
<label for="text">${s.reportText}</label><textarea id="text" name="text" rows="6" maxlength="2000" required>${values.text ?? ''}</textarea>
<label for="contact">${s.reportContact}</label><input id="contact" name="contact" type="email" maxlength="254" value="${values.contact ?? ''}">
<button type="submit">${s.reportSend}</button></form>`,
  );
}

/** A teen's step after sign-up (S3.04): name a parent or guardian, and agree to supervision. */
export function guardianAskPage(lang: Lang, step: string, error?: string): string {
  const s = STRINGS[lang];
  return page(
    lang,
    s.teenTitle,
    html`<h1>${s.teenTitle}</h1><p>${s.teenLead}</p>
<form method="post" action="/guardian/ask?lang=${lang}">
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<input type="hidden" name="step" value="${step}">
<label for="guardianEmail">${s.teenGuardianEmail}</label><input id="guardianEmail" name="guardianEmail" type="email" required maxlength="254">
<label class="check"><input type="checkbox" name="agree" value="yes" required> <span>${s.teenAgree}</span></label>
<button type="submit">${s.teenSend}</button></form>`,
  );
}

/** What the guardian reads and signs (S3.04): the plain summary, then sign in or make an adult
 *  account, and authorize, world servers abroad included. */
export function guardianInvitePage(lang: Lang, invite: string, teenName: string, contact: string, error?: string): string {
  const s = STRINGS[lang];
  const named = (text: string): string => text.replaceAll('{name}', teenName);
  const consent = html`<label class="check"><input type="checkbox" name="authorize" value="yes" required> <span>${named(s.guardianAuthorize)}</span></label>
<label class="check"><input type="checkbox" name="abroad" value="yes" required> <span>${named(s.guardianAbroad)}</span></label>`;
  return page(
    lang,
    s.guardianTitle,
    html`<h1>${s.guardianTitle}</h1><p>${named(s.guardianLead)}</p>
<ul>${s.guardianSummary.map((p) => html`<li>${p.replace('{contact}', contact)}</li>`)}</ul>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<h2>${s.guardianHaveAccount}</h2>
<form method="post" action="/guardian/authorize?lang=${lang}">
<input type="hidden" name="invite" value="${invite}"><input type="hidden" name="mode" value="existing">
<label for="g-email">${s.email}</label><input id="g-email" name="email" type="email" autocomplete="username" required>
<label for="g-password">${s.password}</label><input id="g-password" name="password" type="password" autocomplete="current-password" required>
${consent}
<button type="submit">${s.guardianAuthorizeButton}</button></form>
<h2>${s.guardianNewAccount}</h2>
<form method="post" action="/guardian/authorize?lang=${lang}">
<input type="hidden" name="invite" value="${invite}"><input type="hidden" name="mode" value="new">
<label for="n-email">${s.email}</label><input id="n-email" name="email" type="email" autocomplete="email" required>
<label for="n-password">${s.password}</label><input id="n-password" name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="256">
<label for="n-name">${s.displayName}</label><input id="n-name" name="displayName" required minlength="3" maxlength="32">
<label>${s.birth}</label><div class="row">
<select name="birthMonth" aria-label="${s.month}" required><option value="">${s.month}</option>${monthOptions(lang, undefined)}</select>
<input name="birthYear" aria-label="${s.year}" placeholder="${s.year}" inputmode="numeric" pattern="[0-9]{4}" required></div>
<label for="n-country">${s.country}</label><select id="n-country" name="country" required><option value="">${s.chooseCountry}</option>${countryOptions(lang, undefined)}</select>
<label class="check"><input type="checkbox" name="consent" value="yes" required> <span>${s.consent} <a href="/privacy?lang=${lang}" target="_blank" rel="noopener">${s.privacyLink}</a></span></label>
${consent}
<button type="submit">${s.guardianAuthorizeButton}</button></form>`,
  );
}

export function guardianSigninPage(lang: Lang, error?: string): string {
  const s = STRINGS[lang];
  return page(
    lang,
    s.supervisionTitle,
    html`<h1>${s.supervisionTitle}</h1><p class="muted">${s.supervisionSignin}</p>
<form method="post" action="/guardian/signin?lang=${lang}">
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<label for="email">${s.email}</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">${s.password}</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${s.signin}</button></form>`,
  );
}

export interface GuardedTeen {
  id: string;
  name: string;
  contact: 'friends' | 'everyone' | 'none';
  friends: Array<{ account: string; name: string }>;
}

/** The guardian's page (S3.04): each teen's friends, removable, and who may talk to them. */
export function guardianPage(lang: Lang, csrf: string, teens: readonly GuardedTeen[], notice?: string): string {
  const s = STRINGS[lang];
  const option = (t: GuardedTeen, value: GuardedTeen['contact'], label: string): ReturnType<typeof html> =>
    html`<label class="check"><input type="radio" name="contact" value="${value}"${t.contact === value ? raw(' checked') : ''}> <span>${label}</span></label>`;
  const teen = (t: GuardedTeen): ReturnType<typeof html> => html`<h2>${t.name}</h2>
<h3>${s.supervisionFriends}</h3>
${t.friends.length === 0 ? html`<p class="muted">${s.supervisionNoFriends}</p>` : html`<ul>${t.friends.map((f) => html`<li>${f.name} <form method="post" action="/guardian/teens/${t.id}/unfriend/${f.account}?lang=${lang}" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" class="secondary">${s.supervisionRemove}</button></form></li>`)}</ul>`}
<form method="post" action="/guardian/teens/${t.id}?lang=${lang}"><input type="hidden" name="csrf" value="${csrf}">
<p>${s.supervisionContact.replace('{name}', t.name)}</p>
${option(t, 'friends', s.supervisionContactFriends)}${option(t, 'everyone', s.supervisionContactEveryone)}${option(t, 'none', s.supervisionContactNone)}
<button type="submit">${s.supervisionSave}</button></form>`;
  return page(lang, s.supervisionTitle, html`<h1>${s.supervisionTitle}</h1>${notice ? html`<p role="status">${notice}</p>` : ''}${teens.length === 0 ? html`<p class="muted">${s.supervisionNone}</p>` : teens.map(teen)}`);
}
