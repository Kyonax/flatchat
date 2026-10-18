// SPDX-License-Identifier: MPL-2.0
// The licence gate (P.07) on throwaway folders: a planted asset without a record fails, as do a
// licence the project does not accept, another's work without its archived licence page, a CC BY
// asset whose credit line is missing from CREDITS.md, a record that covers nothing, and an AI
// tool without its terms. A complete record passes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAssets, isAsset, patternToRegExp, PROVENANCE_DIR } from '../src/asset-check.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>): { root: string; list: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'asset-check-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, list: Object.keys(files) };
}
const record = (r: Record<string, unknown>): string => JSON.stringify(r);
const THEIRS = {
  files: ['kits/wear/shirt/*.glb'],
  title: 'A shirt',
  creator: 'Jane Maker',
  licence: 'CC-BY-4.0',
  source: 'https://example.org/shirt',
  retrieved: '2026-10-17',
  changes: 'none',
  licencePage: { url: 'https://example.org/licence', archived: 'kits/provenance/archive/example-licence.txt' },
  credit: '"Shirt" by Jane Maker, CC BY 4.0',
};

describe('the licence gate', () => {
  it('fails a planted asset that has no provenance record', () => {
    const { root, list } = repo({ 'kits/props/crate.png': 'x', 'apps/client/src/a.ts': '//' });
    expect(checkAssets(root, list)).toEqual([`kits/props/crate.png: no provenance record in ${PROVENANCE_DIR}/`]);
  });

  it('passes the project\'s own work and another\'s CC BY work with everything recorded', () => {
    const { root, list } = repo({
      'kits/worlds/a/scene.glb': 'x',
      'kits/wear/shirt/a.glb': 'x',
      'kits/wear/shirt/b.glb': 'x',
      'kits/provenance/archive/example-licence.txt': 'CC BY 4.0, saved 2026-10-17',
      'kits/provenance/own.json': record({ files: ['kits/worlds/**/*.glb'], title: 'Worlds', creator: 'the FlatChat contributors', licence: 'CC-BY-4.0', made: 'tools/make.ts' }),
      'kits/provenance/shirt.json': record(THEIRS),
      'CREDITS.md': `| A shirt | ${THEIRS.credit} |`,
    });
    expect(checkAssets(root, list)).toEqual([]);
  });

  it('refuses a licence outside CC0, CC BY and the owner\'s own', () => {
    const { root, list } = repo({
      'kits/a.ogg': 'x',
      'kits/provenance/a.json': record({ files: ['kits/a.ogg'], title: 'A', creator: 'B', licence: 'CC-BY-NC-4.0', made: 'by hand' }),
    });
    expect(checkAssets(root, list)).toEqual([expect.stringContaining('licence "CC-BY-NC-4.0" is not one the project accepts')]);
  });

  it('refuses another\'s work without its archived licence page, and a CC BY one without its credit line', () => {
    const { root, list } = repo({
      'kits/wear/shirt/a.glb': 'x',
      'kits/provenance/shirt.json': record({ ...THEIRS, licencePage: { url: 'https://example.org/licence', archived: 'kits/provenance/archive/missing.txt' } }),
      'CREDITS.md': '# Credits',
    });
    const problems = checkAssets(root, list);
    expect(problems).toContainEqual(expect.stringContaining('licencePage.archived kits/provenance/archive/missing.txt is not a file'));
    expect(problems).toContainEqual(expect.stringContaining('its credit line is not in CREDITS.md'));
  });

  it('refuses a record that covers nothing, both made and source, and an AI tool without its terms', () => {
    const { root, list } = repo({
      'kits/a.png': 'x',
      'kits/provenance/a.json': record({ files: ['kits/a.png', 'kits/gone/*.png'], title: 'A', creator: 'B', licence: 'CC0-1.0', made: 'x', source: 'https://example.org', ai: { tool: 'An image model' } }),
    });
    const problems = checkAssets(root, list);
    expect(problems).toContainEqual(expect.stringContaining('"kits/gone/*.png" matches no asset'));
    expect(problems).toContainEqual(expect.stringContaining('not both'));
    expect(problems).toContainEqual(expect.stringContaining('ai needs tool, terms'));
  });

  it('holds what our own work was made from to the same licences and saved pages', () => {
    const { root, list } = repo({
      'kits/bodies/a/a.vrm': 'x',
      'kits/provenance/archive/cc0.txt': 'CC0',
      'kits/provenance/kit.json': record({
        files: ['kits/bodies/*/*.vrm'],
        title: 'A body',
        creator: 'the FlatChat contributors',
        licence: 'CC-BY-4.0',
        made: 'tools/make.py',
        derivedFrom: [
          { what: 'A base mesh', creator: 'Them', source: 'https://example.org/mesh', licence: 'CC0-1.0', licencePage: { url: 'https://example.org/l', archived: 'kits/provenance/archive/cc0.txt' } },
          { what: 'A paid model', creator: 'Someone', source: 'https://example.org/paid', licence: 'LicenseRef-Proprietary', licencePage: { url: 'https://example.org/l', archived: 'kits/provenance/archive/gone.txt' } },
        ],
      }),
    });
    const problems = checkAssets(root, list);
    expect(problems).toContainEqual(expect.stringContaining('derivedFrom[1]: licence "LicenseRef-Proprietary" is not one the project accepts'));
    expect(problems).toContainEqual(expect.stringContaining('derivedFrom[1]: licencePage.archived is not a file'));
    expect(problems.filter((p) => p.includes('derivedFrom[0]'))).toEqual([]);
  });

  it('knows assets by their extension and reads * and ** in patterns', () => {
    expect(['a/b.GLB', 'x.vrma', 'f.woff2', 'b.ts', 'README.md', 'dir.png/file'].map(isAsset)).toEqual([true, true, true, false, false, false]);
    expect(patternToRegExp('kits/**/*.glb').test('kits/a/b/c.glb')).toBe(true);
    expect(patternToRegExp('kits/**/*.glb').test('kits/c.glb')).toBe(true);
    expect(patternToRegExp('kits/*.glb').test('kits/a/c.glb')).toBe(false);
  });
});
