// SPDX-License-Identifier: MPL-2.0
// The credits page's rows (S6.07), read from the repository's CREDITS.md at build time: its first
// table (the models, sounds, effects, fonts and data in the repository, with their creators and
// licences) and its table of the packages that ship (those inside the client). One source for the
// file, the notices and the page, so they never disagree.

export interface CreditLink {
  text: string;
  url: string;
}

export interface CreditRow {
  item: string;
  creator: string;
  licence: string;
  sources: CreditLink[];
  /** A package's version; empty for an asset. */
  version: string;
}

/** Markdown links and code spans in a cell: the text without them, and the links. */
function cell(raw: string): { text: string; links: CreditLink[] } {
  const links: CreditLink[] = [];
  const text = raw
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_m, t: string, url: string) => {
      links.push({ text: t.replace(/`/g, ''), url });
      return t;
    })
    .replace(/`/g, '')
    .trim();
  return { text, links };
}

/** The rows of the markdown table that follows `heading` (a table's header row starting with it). */
function table(md: string, header: string): string[][] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`| ${header} |`));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.startsWith('|'); i++) {
    rows.push(
      lines[i]!
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

/** The assets in the repository and the packages inside the client, from CREDITS.md. */
export function readCredits(md: string): { assets: CreditRow[]; packages: CreditRow[] } {
  // | Item | Path | Creator | Source | Licence | Retrieved | Changes |
  const assets = table(md, 'Item').map((c) => {
    const source = cell(c[3] ?? '');
    return { item: cell(c[0] ?? '').text, creator: cell(c[2] ?? '').text, licence: cell(c[4] ?? '').text, sources: source.links, version: '' };
  });
  // | Package | Ships in | Creator | Source | Licence | Version |
  const packages = table(md, 'Package')
    .filter((c) => (c[1] ?? '').includes('the client'))
    .map((c) => {
      const source = cell(c[3] ?? '');
      return { item: cell(c[0] ?? '').text, creator: cell(c[2] ?? '').text, licence: cell(c[4] ?? '').text, sources: source.links, version: cell(c[5] ?? '').text };
    });
  return { assets, packages };
}
