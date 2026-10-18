// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure parts: the age rule (S1.03), passwords and sealed keys, the fields, the pages' escaping
// and the two languages.
import { argon2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cleanDisplayName, cleanEmail, passwordProblem } from '../src/accounts.ts';
import { ageOn, ageRule, isMinor } from '../src/age.ts';
import { LIMITS, RateLimiter } from '../src/limits.ts';
import { documentPage, escapeHtml, html, raw, signinPage, signupPage } from '../src/pages.ts';
import { challengeOf, hashPassword, openWorldKey, sealingKey, sealWorldKey, TEST_COST, verifyPassword } from '../src/secrets.ts';
import { pickLang, STRINGS } from '../src/strings.ts';
import { cleanAddress, cleanWorldName } from '../src/worlds.ts';

const on = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

describe('the age rule', () => {
  const stage1 = { minors: false };
  const stage3 = { minors: true };
  const today = on('2026-10-17');

  it('counts a birthday in the current month as not yet passed', () => {
    expect(ageOn(2008, 9, today)).toBe(18);
    expect(ageOn(2008, 10, today)).toBe(17);
    expect(ageOn(2008, 11, today)).toBe(17);
    expect(isMinor(2008, 10, today)).toBe(true);
    expect(isMinor(2008, 9, today)).toBe(false);
  });

  it('refuses under 13 everywhere and keeps the reason neutral', () => {
    expect(ageRule({ year: 2013, month: 10, country: 'CO' }, today, stage3)).toEqual({ ok: false, reason: 'under-13' });
    expect(ageRule({ year: 2013, month: 9, country: 'CO' }, today, stage3)).toEqual({ ok: true, age: 13, minor: true });
  });

  it('admits only adults until the minors protections ship (OQ-16)', () => {
    expect(ageRule({ year: 2010, month: 1, country: 'CO' }, today, stage1)).toEqual({ ok: false, reason: 'minors-not-yet' });
    expect(ageRule({ year: 2008, month: 9, country: 'CO' }, today, stage1)).toEqual({ ok: true, age: 18, minor: false });
    expect(ageRule({ year: 1990, month: 5, country: 'US' }, today, stage1)).toEqual({ ok: true, age: 36, minor: false });
  });

  it('keeps Australia at 16 and over, and Brazilian minors waiting (B-20)', () => {
    expect(ageRule({ year: 2011, month: 1, country: 'AU' }, today, stage3)).toEqual({ ok: false, reason: 'under-16-here' });
    expect(ageRule({ year: 2010, month: 9, country: 'au' }, today, stage3)).toEqual({ ok: true, age: 16, minor: true });
    expect(ageRule({ year: 2009, month: 1, country: 'BR' }, today, stage3)).toEqual({ ok: false, reason: 'minors-wait-here' });
    expect(ageRule({ year: 2008, month: 1, country: 'BR' }, today, stage3)).toEqual({ ok: true, age: 18, minor: false });
  });

  it('refuses impossible dates and countries', () => {
    for (const bad of [
      { year: 2027, month: 1, country: 'CO' },
      { year: 2026, month: 11, country: 'CO' },
      { year: 1899, month: 1, country: 'CO' },
      { year: 2000, month: 13, country: 'CO' },
      { year: 2000, month: 0, country: 'CO' },
      { year: 2000.5, month: 1, country: 'CO' },
      { year: 2000, month: 1, country: 'Colombia' },
    ]) {
      expect(ageRule(bad, today, stage3)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('secrets', () => {
  it("Node's Argon2id matches RFC 9106's test vector", () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(Buffer.from(tag).toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('hashes passwords as PHC strings and verifies them', async () => {
    const phc = await hashPassword('correct horse battery', TEST_COST);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verifyPassword('correct horse battery', phc)).toBe(true);
    expect(await verifyPassword('correct horse batterz', phc)).toBe(false);
    expect(await verifyPassword('correct horse battery', 'not a hash')).toBe(false);
    expect(await hashPassword('correct horse battery', TEST_COST)).not.toBe(phc);
  });

  it('seals a world key bound to its world', () => {
    const sealing = sealingKey(randomBytes(32));
    const key = randomBytes(32);
    const sealed = sealWorldKey(sealing, 'world-a', key);
    expect(Buffer.from(openWorldKey(sealing, 'world-a', sealed)).equals(key)).toBe(true);
    expect(() => openWorldKey(sealing, 'world-b', sealed)).toThrow();
    expect(() => openWorldKey(sealingKey(randomBytes(32)), 'world-a', sealed)).toThrow();
  });

  it('derives the PKCE challenge of RFC 7636, appendix B', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('the fields', () => {
  it('takes one email address', () => {
    expect(cleanEmail(' ana@example.org ')).toBe('ana@example.org');
    for (const bad of ['', 'ana', 'ana@', '@example.org', 'ana@example', 'a b@example.org', 'ana@x@example.org']) expect(cleanEmail(bad)).toBeUndefined();
  });

  it('takes display names of letters and numbers, without controls, emoji or direction marks', () => {
    expect(cleanDisplayName('  Ana   María ')).toBe('Ana María');
    expect(cleanDisplayName('kyo_nax.42')).toBe('kyo_nax.42');
    expect(cleanDisplayName('Ｋｙｏ')).toBe('Kyo');
    for (const bad of ['ab', 'x'.repeat(33), '<script>', 'ana‮maria', 'ana​maria', 'ana 😀', '-ana', 'ana.']) expect(cleanDisplayName(bad)).toBeUndefined();
    expect(cleanDisplayName('ana\n\tmaría')).toBe('ana maría');
    // At most 64 bytes, the connect token's field: 21 three-byte or 16 four-byte characters.
    expect(cleanDisplayName('漢'.repeat(21))).toBe('漢'.repeat(21));
    expect(cleanDisplayName('漢'.repeat(22))).toBeUndefined();
    expect(cleanDisplayName('𠀀'.repeat(16))).toBe('𠀀'.repeat(16));
    expect(cleanDisplayName('𠀀'.repeat(17))).toBeUndefined();
  });

  it('asks only for a long enough password', () => {
    expect(passwordProblem('short')).toBe('short');
    expect(passwordProblem('ten chars!')).toBeUndefined();
    expect(passwordProblem('x'.repeat(257))).toBe('long');
  });

  it('takes world names and addresses', () => {
    expect(cleanWorldName(' Kyonax  Plaza ')).toBe('Kyonax Plaza');
    expect(cleanWorldName('ab')).toBeUndefined();
    expect(cleanWorldName('evil‮world')).toBeUndefined();
    expect(cleanAddress('https://worlds.example.org/rtc')).toBe('https://worlds.example.org/rtc');
    expect(cleanAddress('http://192.168.1.20:7779/rtc')).toBe('http://192.168.1.20:7779/rtc');
    expect(cleanAddress('http://127.0.0.1:7779/rtc')).toBe('http://127.0.0.1:7779/rtc');
    for (const bad of ['http://example.org/rtc', 'ftp://x/y', 'https://u:p@x.org/', 'https://x.org/?a=1', 'javascript:alert(1)', 'nonsense']) expect(cleanAddress(bad)).toBeUndefined();
  });
});

describe('the pages', () => {
  it('escape every value', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(html`<p>${'<b>'}</p>${raw('<i>ok</i>')}${['<x>', raw('<y>')]}`.html).toBe('<p>&lt;b&gt;</p><i>ok</i>&lt;x&gt;<y>');
    const page = signinPage('en', 'req"><script>', { email: '"><img src=x onerror=alert(1)>', error: '<b>' });
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<img');
    expect(page).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('carry no script and post only to the core', () => {
    for (const p of [signinPage('es', 'r'), signupPage('es', 'i'), documentPage('en', 'privacy', { operator: 'Op', contact: 'privacy@example.org', address: 'A street', phone: '+57 1' })]) {
      expect(p).not.toMatch(/<script|\son\w+=/i);
      for (const action of p.matchAll(/action="([^"]*)"/g)) expect(action[1]).toMatch(/^\/(signin|signup)\?lang=(en|es)$/);
    }
  });

  it('list every country, named in the page language', () => {
    const page = signupPage('es', 'i', { country: 'CO' });
    expect(page).toContain('<option value="CO" selected>Colombia</option>');
    expect(page).toContain('>Alemania</option>');
    expect((page.match(/<option value="[A-Z]{2}"/g) ?? []).length).toBe(249);
  });

  it('are written in both languages, key for key', () => {
    const shape = (o: unknown): unknown =>
      Array.isArray(o) ? o.length : typeof o === 'object' && o !== null ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o;
    expect(shape(STRINGS.es)).toEqual(shape(STRINGS.en));
    expect(pickLang(undefined, 'es-CO,es;q=0.9,en;q=0.8')).toBe('es');
    expect(pickLang('en', 'es-CO')).toBe('en');
    expect(pickLang('fr', 'de-DE')).toBe('en');
  });
});

describe('rate limits', () => {
  it('refill over time and forget nobody too early', () => {
    const l = new RateLimiter(LIMITS.signinByEmail);
    for (let i = 0; i < 5; i++) expect(l.take('ana', 0)).toBe(true);
    expect(l.take('ana', 0)).toBe(false);
    expect(l.retryAfter('ana', 0)).toBe(60_000);
    expect(l.take('ana', 59_000)).toBe(false);
    expect(l.take('ana', 60_001)).toBe(true);
    expect(l.take('bea', 0)).toBe(true);
  });
});
