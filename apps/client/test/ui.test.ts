// SPDX-License-Identifier: MPL-2.0
// The UI pass (S6.07): every text the interface asks for is in both languages (the translation
// coverage), the keys help lists every action once, the credits page reads every asset and the
// client's packages from CREDITS.md, the theme keeps the Kyonax HUD's laws (no rounded corners,
// gradients or shadows; Space Mono; FlatChat's accent, the logo's), and the icon is the logo's squares.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iconPixels } from '../scripts/icon.ts';
import { ACTIONS } from '../src/shared/settings';
import { LOGO_ACCENT, LOGO_BRIGHT, LOGO_GRID, LOGO_RECTS } from '../src/shared/logo';
import en from '../src/renderer/src/i18n/en';
import es from '../src/renderer/src/i18n/es';
import { readCredits } from '../src/renderer/src/ui/credits';
import { KEY_GROUPS } from '../src/renderer/src/ui/key-groups';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(CLIENT, 'src', 'renderer', 'src');

/** Every .vue and .ts file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(vue|ts)$/.test(name) ? [path] : [];
  });
}

/** A message by its dotted key, or undefined. */
function message(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((at, k) => (typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[k] : undefined), messages);
}

describe('the translation coverage', () => {
  it('has every key the interface asks for, in English and Spanish', () => {
    const asked = new Set<string>();
    const prefixes = new Set<string>();
    for (const file of sources(RENDERER)) {
      const text = readFileSync(file, 'utf8');
      // t('a.b') and te('a.b'): a literal key; t(`a.${x}.b`): its fixed start must be a section.
      for (const m of text.matchAll(/\bte?\(\s*'([a-zA-Z0-9_.]+)'/g)) asked.add(m[1]!);
      for (const m of text.matchAll(/\bte?\(\s*`([a-zA-Z0-9_.]+)\.\$\{/g)) prefixes.add(m[1]!);
    }
    expect(asked.size).toBeGreaterThan(300);
    for (const key of asked) {
      expect(typeof message(en, key), `en: ${key}`).toBe('string');
      expect(typeof message(es, key), `es: ${key}`).toBe('string');
    }
    for (const prefix of prefixes) {
      expect(typeof message(en, prefix), `en: ${prefix}`).toBe('object');
      expect(typeof message(es, prefix), `es: ${prefix}`).toBe('object');
    }
  });

  it('names every action, in both languages', () => {
    for (const a of ACTIONS) {
      expect(typeof message(en, `actions.${a}`), a).toBe('string');
      expect(typeof message(es, `actions.${a}`), a).toBe('string');
    }
  });
});

describe('the keys help', () => {
  it('lists every action exactly once', () => {
    const listed = KEY_GROUPS.flatMap((g) => g.actions);
    expect([...listed].sort()).toEqual([...ACTIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('the credits page', () => {
  it('reads every asset and the packages inside the client from CREDITS.md', () => {
    const md = readFileSync(join(CLIENT, '..', '..', 'CREDITS.md'), 'utf8');
    const { assets, packages } = readCredits(md);
    // Each table's rows: from its header to the first line that is not a row.
    const rows = (header: string): string[] => {
      const lines = md.split('\n');
      const start = lines.findIndex((l) => l.startsWith(`| ${header} |`)) + 2;
      const end = lines.findIndex((l, i) => i >= start && !l.startsWith('|'));
      return lines.slice(start, end < 0 ? undefined : end);
    };
    expect(assets).toHaveLength(rows('Item').length);
    expect(packages).toHaveLength(rows('Package').filter((l) => l.split('|')[2]!.includes('the client')).length);
    for (const r of [...assets, ...packages]) {
      expect(r.item, JSON.stringify(r)).not.toBe('');
      expect(r.creator, r.item).not.toBe('');
      expect(r.licence, r.item).not.toBe('');
      expect(r.sources.length, r.item).toBeGreaterThan(0);
      for (const s of r.sources) expect(s.url, r.item).toMatch(/^https:\/\//);
    }
    expect(assets.map((a) => a.item).join('\n')).toMatch(/Space Mono/);
    expect(packages.map((p) => p.item)).toEqual(expect.arrayContaining(['Electron', 'three.js']));
    expect(packages.every((p) => p.version !== '')).toBe(true);
  });
});

/** oklch() to #rrggbb (CSS Color 4's conversion). */
function oklchHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const [L, M, S] = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3) as [number, number, number];
  const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  return `#${lin.map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0')).join('')}`;
}

describe('the theme', () => {
  const theme = readFileSync(join(RENDERER, 'ui', 'theme.css'), 'utf8');

  it('keeps the HUD laws everywhere: no rounded corners, gradients or shadows', () => {
    for (const file of [...sources(RENDERER).filter((f) => f.endsWith('.vue')), join(RENDERER, 'ui', 'theme.css')]) {
      const styles = file.endsWith('.css') ? readFileSync(file, 'utf8') : (readFileSync(file, 'utf8').match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n');
      expect(styles.match(/border-radius:(?!\s*0[\s;!])[^;]+/g) ?? [], file).toEqual([]);
      expect(styles.match(/gradient\(/g) ?? [], file).toEqual([]);
      expect(styles.match(/box-shadow:(?!\s*none)[^;]+/g) ?? [], file).toEqual([]);
    }
  });

  it('sets Space Mono from the two fonts it ships, and the accent the logo carries', () => {
    expect(theme).toMatch(/--font: 'Space Mono'/);
    for (const m of theme.matchAll(/url\('\.\.\/assets\/fonts\/([^']+)'\)/g)) expect(statSync(join(RENDERER, 'assets', 'fonts', m[1]!)).size).toBeGreaterThan(10_000);
    const accent = /--accent: oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/.exec(theme)!;
    expect(oklchHex(Number(accent[1]) / 100, Number(accent[2]), Number(accent[3]))).toBe(LOGO_ACCENT);
  });
});

describe('the icon', () => {
  it('is the logo’s squares on black', () => {
    const size = 64;
    const px = iconPixels(size);
    const at = (x: number, y: number): string => `#${[0, 1, 2].map((k) => px[(y * size + x) * 4 + k]!.toString(16).padStart(2, '0')).join('')}`;
    const unit = size / LOGO_GRID;
    for (const r of LOGO_RECTS) expect(at(Math.floor((r.x + r.w / 2) * unit), Math.floor((r.y + r.h / 2) * unit))).toBe(r.ink === 'accent' ? LOGO_ACCENT : LOGO_BRIGHT);
    expect(at(0, 0)).toBe('#000000');
    expect(at(size - 1, size - 1)).toBe('#000000');
  });
});
