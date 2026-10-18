// SPDX-License-Identifier: AGPL-3.0-or-later
// The rules and policies (S7.02): every document in both languages with the same sections and
// paragraphs, each page the core serves with the operator's details filled in, marked as a draft,
// linking to the other language and to every other document, with no script and nothing left
// unfilled; Colombia's data policy carries what Decreto 1377 de 2013, art. 13, asks of it.
import { POLICY_PAGES } from '@flatchat/content';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_IDS, DOCUMENTS } from '../src/documents.ts';
import { documentPage } from '../src/pages.ts';

const FILL = { operator: 'Kyonax', contact: 'privacy@example.org', address: 'Calle 1 # 2-3, Bogotá', phone: '+57 601 000 0000' };

describe('the rules and policies', () => {
  it('say the same in both languages: the same documents, sections and paragraphs', () => {
    expect(Object.keys(DOCUMENTS.es).sort()).toEqual(Object.keys(DOCUMENTS.en).sort());
    for (const id of DOCUMENT_IDS) {
      const en = DOCUMENTS.en[id];
      const es = DOCUMENTS.es[id];
      expect(es.sections.map((s) => s.paragraphs.length), id).toEqual(en.sections.map((s) => s.paragraphs.length));
      for (const d of [en, es]) {
        expect(d.title.length, id).toBeGreaterThan(3);
        expect(d.summary.length, id).toBeGreaterThan(20);
        expect(d.sections.length, id).toBeGreaterThan(0);
        // Only the placeholders the core fills.
        const text = JSON.stringify(d);
        expect(text.match(/\{[a-z]+\}/g)?.filter((p) => !['{operator}', '{contact}', '{address}', '{phone}', '{effective}'].includes(p)) ?? [], id).toEqual([]);
      }
    }
  });

  it('are served filled in, marked as drafts, linked to each other and to the other language', () => {
    for (const id of DOCUMENT_IDS) {
      for (const lang of ['en', 'es'] as const) {
        const page = documentPage(lang, id, FILL);
        expect(page, `${id} ${lang}`).not.toMatch(/\{(operator|contact|address|phone|effective)\}/);
        expect(page).not.toMatch(/<script|\son\w+=/i);
        expect(page).toContain('class="draft-note"');
        expect(page).toContain(`href="${POLICY_PAGES[id]}?lang=${lang === 'en' ? 'es' : 'en'}"`);
        for (const other of DOCUMENT_IDS) expect(page).toContain(`href="${POLICY_PAGES[other]}?lang=${lang}"`);
      }
    }
    expect(documentPage('en', 'privacy', FILL)).toContain('privacy@example.org');
  });

  it('give Colombia’s data policy what Decreto 1377, art. 13, asks: who, what for, rights, where to ask, how, since when', () => {
    const page = documentPage('es', 'dataPolicy', FILL);
    for (const must of [FILL.operator, FILL.address, FILL.contact, FILL.phone]) expect(page).toContain(must);
    expect(page).toMatch(/finalidad/i);
    expect(page).toMatch(/derechos/i);
    expect(page).toMatch(/consultas/i);
    expect(page).toMatch(/reclamos/i);
    expect(page).toMatch(/vigencia/i);
  });
});
