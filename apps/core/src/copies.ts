// SPDX-License-Identifier: AGPL-3.0-or-later
// Copies caught by their fingerprints (S5.09, Q-J4, cl-005, T-03). Once an avatar or an item
// converts, its fingerprint (the converter's; packages/content's fingerprint.ts says what it is) is
// compared with everything taken down from FlatChat, and with others' live gallery entries whose
// licence allows no copies. An exact file hash (S5.06) misses a re-exported copy; a fingerprint does
// not. What the three standard bodies explain is no evidence (anyone may make an avatar of a kit),
// so a shape or a texture that matches a kit's (kits/bodies/fingerprints.json) is set aside first.
// A copy of something taken down is refused and is a strike against its uploader, which the admin
// page lists for a ban; a copy of a closed gallery entry is refused with the licence's reason.
import { existsSync, readFileSync } from 'node:fs';
import { checkFingerprint, type Fingerprint, type Licence, matchOf, SHAPE_MATCH, shapeSimilarity, TEXTURE_MATCH_BITS, textureDistance } from '@flatchat/content';
import type { Sql } from './db.ts';

/** The standard bodies' fingerprints, from their folder's fingerprints.json (none when it has none). */
export function readKitFingerprints(dir: string): Fingerprint[] {
  const file = `${dir}/fingerprints.json`;
  if (!existsSync(file)) return [];
  const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return Object.values(all).map((f) => checkFingerprint(f));
}

/** A fingerprint less what the standard bodies explain. */
export function beyondKits(f: Fingerprint, kits: readonly Fingerprint[]): Fingerprint {
  return {
    shapes: f.shapes.filter((s) => !kits.some((k) => k.shapes.some((ks) => shapeSimilarity(s, ks) >= SHAPE_MATCH))),
    textures: f.textures.filter((t) => !kits.some((k) => k.textures.some((kt) => textureDistance(t, kt) <= TEXTURE_MATCH_BITS))),
  };
}

/** A fingerprint as the converter wrote it or the database holds it, or nothing when it does not read. */
export function readFingerprint(value: unknown): Fingerprint | undefined {
  try {
    return checkFingerprint(value);
  } catch {
    return undefined;
  }
}

export interface Caught {
  /** A copy of something taken down, or of a gallery entry that allows no copies. */
  of: 'removed' | 'gallery';
  /** What the uploader is told. */
  reason: string;
  /** For the strike and the log: what it copies and how it was told. */
  detail: string;
}

/** Whether an upload's fingerprint shows a copy, and of what. `owner` is its uploader: their own
 *  gallery entries are theirs to upload again; what was taken down from them is not. */
export async function copyOf(db: Sql, f: Fingerprint, owner: string, kits: readonly Fingerprint[]): Promise<Caught | undefined> {
  const mine = beyondKits(f, kits);
  if (mine.shapes.length === 0 && mine.textures.length === 0) return undefined;
  const removed = await db.query<{ kind: string; id: string; name: string; fingerprint: unknown }>(
    "select 'avatar' as kind, id, name, fingerprint from avatars where status = 'removed' and fingerprint is not null union all select 'item' as kind, id, name, fingerprint from items where status = 'removed' and fingerprint is not null",
  );
  for (const r of removed) {
    const theirs = readFingerprint(r.fingerprint);
    const m = theirs && matchOf(mine, theirs);
    if (m) return { of: 'removed', reason: `this is a copy of ${r.kind === 'avatar' ? 'an avatar' : 'an item'} taken down from FlatChat, which cannot be uploaded again`, detail: `a copy (by its ${m.by}) of the ${r.kind} ${r.id} taken down` };
  }
  const closed = await db.query<{ id: string; name: string; licence: Licence; fingerprint: unknown }>(
    `select g.id, g.name, g.licence, coalesce(v.fingerprint, i.fingerprint) as fingerprint from gallery g
       left join avatars v on v.id = g.avatar_id left join items i on i.id = g.item_id
      where g.publisher_id <> $1 and g.withdrawn_at is null and g.removed_at is null`,
    [owner],
  );
  for (const r of closed) {
    if (r.licence.allowRedistribution === true) continue;
    const theirs = readFingerprint(r.fingerprint);
    const m = theirs && matchOf(mine, theirs);
    if (m) return { of: 'gallery', reason: `this is a copy of “${r.name}” in the gallery, whose licence does not allow copies: take it from the gallery instead`, detail: `a copy (by its ${m.by}) of the gallery entry ${r.id}` };
  }
  return undefined;
}

/** A strike against an account (S5.09): something of theirs taken down, or a copy they uploaded. */
export async function strike(db: Sql, accountId: string, kind: 'removed' | 'copy', detail: string, now: Date): Promise<void> {
  await db.query('insert into strikes (account_id, kind, detail, created_at) values ($1, $2, $3, $4)', [accountId, kind, detail.slice(0, 500), now]);
}

/** The accounts with strikes, the most first, for the admin page. */
export interface StruckAccount {
  email: string;
  name: string;
  status: string;
  strikes: number;
  copies: number;
  last: string;
  lastAt: Date;
}

export async function struckAccounts(db: Sql): Promise<StruckAccount[]> {
  const rows = await db.query<{ email: string; display_name: string; status: string; strikes: string; copies: string; last: string; last_at: Date }>(
    `select a.email, a.display_name, a.status, count(*) as strikes, count(*) filter (where s.kind = 'copy') as copies,
            (array_agg(s.detail order by s.created_at desc))[1] as last, max(s.created_at) as last_at
       from strikes s join accounts a on a.id = s.account_id group by a.id order by count(*) desc, max(s.created_at) desc limit 100`,
  );
  return rows.map((r) => ({ email: r.email, name: r.display_name, status: r.status, strikes: Number(r.strikes), copies: Number(r.copies), last: r.last, lastAt: r.last_at }));
}
