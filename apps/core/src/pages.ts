// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's own pages: sign-in, sign-up, the privacy notice. Plain HTML forms with no script.
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
export const PAGE_POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'";

export const CSS = `:root{color-scheme:light dark;--bg:#f5f5f2;--fg:#17171a;--muted:#5d5d66;--line:#d4d4d8;--accent:#c9a20a;--error:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececee;--muted:#a1a1aa;--line:#2e2e33;--accent:#f9cd26;--error:#f2b8b5;--card:#1b1b1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;margin:6vh auto;padding:0 16px}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0 1rem}.muted{color:var(--muted);font-size:.9rem}
form{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px}label{display:block;font-weight:600;margin:.75rem 0 .25rem}
input,select{width:100%;font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:2px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:8px}.row>*{flex:1}.check{display:flex;gap:8px;align-items:flex-start;font-weight:400}.check input{width:auto;margin-top:.3rem}
button{margin-top:1rem;width:100%;font:inherit;font-weight:600;padding:.6rem;border:0;border-radius:2px;background:var(--accent);color:#121214;cursor:pointer}
.error{color:var(--error);font-weight:600}a{color:inherit}.brand{font-weight:700;letter-spacing:.02em;margin-bottom:1.5rem}`;

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
