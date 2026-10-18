// SPDX-License-Identifier: AGPL-3.0-or-later
// The free gallery in the core (S5.06, ad-008, Q-M29, Q-J4): avatars and items anyone may wear,
// each under licence fields (packages/content's licence.ts: VRM 1.0's terms, every field stated).
// A publisher at trust level 2 (or a tester) puts in one of their own ready avatars or items, saying
// it is theirs to share and keeps to the content rules; an avatar's file states its own terms and
// the publisher may make them stricter, never looser; the gallery takes only what everyone may
// wear. Anyone signed in browses it; taking an entry gives the account its own ready copy (an
// avatars or items row naming the entry), worn, saved in outfits and delivered like its own. A
// withdrawn entry (by its publisher, or its original deleted) leaves the gallery; taken copies stay.
// An exact copy of someone else's entry is refused at upload unless its licence allows copies
// (a changed copy is caught by its fingerprint after conversion: copies.ts, S5.09).
import { BODY_KITS, type BodyKit, checkItemManifest, checkManifest, galleryProblems, type Licence, LicenceError, licenceOfFile, looserThan, readLicence, type Slot } from '@flatchat/content';
import type { Db, Sql } from './db.ts';
import { MAX_AVATARS } from './avatars.ts';
import { MAX_ITEMS } from './items.ts';
import { cleanName, ContentProblem } from './sandbox.ts';
import type { FileStore } from './store.ts';

/** Publishing needs this trust level (or the tester flag): a gallery is public. */
export const PUBLISH_TRUST = 2;
export const GALLERY_PAGE = 40;
export const KINDS = ['avatar', 'item'] as const;
export type GalleryKind = (typeof KINDS)[number];

export interface GalleryEntry {
  id: string;
  kind: GalleryKind;
  name: string;
  authors: string[];
  licence: Licence;
  /** An item's slot and the bodies it fits (none for an attachment: any avatar). */
  slot: Slot | null;
  fits: BodyKit[];
  /** An avatar's rank. */
  rank: string | null;
  takes: number;
  publishedAt: Date;
  /** The publisher's display name. */
  publisher: string;
  manifest: string;
  /** The viewer published it, or has a copy of it. */
  mine: boolean;
  taken: boolean;
}

interface Row {
  id: string;
  kind: GalleryKind;
  name: string;
  authors: string[];
  licence: Licence;
  slot: Slot | null;
  fits: string;
  rank: string | null;
  takes: number;
  published_at: Date;
  publisher: string;
  manifest_sha256: string;
  mine: boolean;
  taken: boolean;
}

const ENTRY_SQL = `select g.id, g.kind, g.name, g.authors, g.licence, g.slot, g.fits, g.rank, g.takes, g.published_at, a.display_name as publisher, g.manifest_sha256,
  g.publisher_id = $1 as mine,
  exists (select 1 from avatars v where v.owner_id = $1 and v.gallery_id = g.id and v.deleted_at is null) or exists (select 1 from items i where i.owner_id = $1 and i.gallery_id = g.id and i.deleted_at is null) as taken
  from gallery g join accounts a on a.id = g.publisher_id`;
const LIVE = 'g.withdrawn_at is null and g.removed_at is null';

const entryOf = (r: Row): GalleryEntry => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  authors: r.authors,
  licence: r.licence,
  slot: r.slot,
  fits: r.fits ? (r.fits.split(',').filter((b) => (BODY_KITS as readonly string[]).includes(b)) as BodyKit[]) : [],
  rank: r.rank,
  takes: r.takes,
  publishedAt: r.published_at,
  publisher: r.publisher,
  manifest: r.manifest_sha256,
  mine: r.mine === true,
  taken: r.taken === true,
});

/** The names a file credits, or the publisher's when it credits none. */
function authorsOf(stated: unknown, fallback: string): string[] {
  const list = (Array.isArray(stated) ? stated : typeof stated === 'string' && stated ? [stated] : []).filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => cleanName(a, 80));
  return list.length > 0 ? list.slice(0, 10) : [fallback];
}

/** Puts one of the account's own ready avatars or items in the gallery. */
export async function publish(
  db: Db,
  store: FileStore,
  account: { id: string; trust: number; tester: boolean; status: string; displayName: string },
  req: { kind: unknown; id: unknown; name: unknown; licence: unknown; affirm: unknown },
  now: Date,
): Promise<GalleryEntry> {
  if (account.status !== 'active' || (account.trust < PUBLISH_TRUST && !account.tester)) throw new ContentProblem('publish-trust', `publishing to the gallery needs trust level ${PUBLISH_TRUST}`);
  const kind = req.kind as GalleryKind;
  if (!(KINDS as readonly unknown[]).includes(kind) || typeof req.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(req.id)) throw new ContentProblem('bad-request', 'an avatar or an item of yours, by its id');
  if (req.affirm !== true) throw new ContentProblem('bad-request', 'say that it is yours to share and keeps to FlatChat’s content rules');
  let licence: Licence;
  try {
    licence = readLicence(req.licence);
  } catch (err) {
    throw new ContentProblem('bad-request', err instanceof LicenceError ? `the licence: ${err.problems.join('; ')}` : 'the licence');
  }
  const refused = galleryProblems(licence);
  if (refused.length > 0) throw new ContentProblem('licence', refused.join('; '));
  type Own = { id: string; name: string; manifest_sha256: string; source_sha256: string; rank?: string; slot?: Slot; fits?: string };
  const [row] =
    kind === 'avatar'
      ? await db.query<Own>("select id, name, manifest_sha256, source_sha256, rank from avatars where id = $1 and owner_id = $2 and status = 'ready' and deleted_at is null and gallery_id is null", [req.id, account.id])
      : await db.query<Own>("select id, name, manifest_sha256, source_sha256, slot, fits from items where id = $1 and owner_id = $2 and status = 'ready' and deleted_at is null and gallery_id is null and starter is null", [req.id, account.id]);
  if (!row) throw new ContentProblem('not-found', `no ready ${kind} of yours by that id (a copy taken from the gallery, or a starter item, is not yours to publish)`);
  const bytes = store.read(row.manifest_sha256);
  if (!bytes) throw new ContentProblem('not-found', 'its files are gone');
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  let authors: string[];
  if (kind === 'avatar') {
    const m = checkManifest(manifest);
    const looser = looserThan(licence, licenceOfFile(m.licence));
    if (looser.length > 0) throw new ContentProblem('licence', `the avatar’s own file allows less than this licence: ${looser.join(', ')}`);
    authors = authorsOf(m.licence['authors'] ?? m.licence['author'], account.displayName);
  } else {
    authors = authorsOf(checkItemManifest(manifest).authors, account.displayName);
  }
  const name = cleanName(req.name, 64) || row.name || 'Untitled';
  try {
    const [g] = await db.query<{ id: string }>(
      `insert into gallery (kind, publisher_id, avatar_id, item_id, manifest_sha256, source_sha256, name, authors, licence, slot, fits, rank, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [kind, account.id, kind === 'avatar' ? row.id : null, kind === 'item' ? row.id : null, row.manifest_sha256, row.source_sha256, name, JSON.stringify(authors), JSON.stringify(licence), row.slot ?? null, row.fits ?? '', row.rank ?? null, now],
    );
    return (await entry(db, account.id, g!.id))!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ContentProblem('bad-request', 'it is in the gallery already');
    throw err;
  }
}

/** One entry, as the viewer sees it; withdrawn and removed ones are gone. */
export async function entry(db: Sql, viewer: string, id: string): Promise<GalleryEntry | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [r] = await db.query<Row>(`${ENTRY_SQL} where g.id = $2 and ${LIVE}`, [viewer, id]);
  return r ? entryOf(r) : undefined;
}

/** The gallery, newest first, a page at a time: by kind, an item's slot or the body it fits, words
 *  in its name or its authors; `before` (the `next` of a page: a time and an id) continues it. */
export async function browse(db: Sql, viewer: string, q: { kind?: unknown; slot?: unknown; body?: unknown; text?: unknown; before?: unknown }): Promise<{ entries: GalleryEntry[]; next: string | null }> {
  // Each filter is a parameter, null when not asked for.
  const kind = (KINDS as readonly unknown[]).includes(q.kind) ? q.kind : null;
  const slot = typeof q.slot === 'string' && /^[a-z]{1,16}$/.test(q.slot) ? q.slot : null;
  const body = typeof q.body === 'string' && (BODY_KITS as readonly string[]).includes(q.body) ? `%,${q.body},%` : null;
  const text = typeof q.text === 'string' && q.text.trim() ? `%${q.text.trim().slice(0, 64).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const cursor = typeof q.before === 'string' ? /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\|([0-9a-f-]{36})$/i.exec(q.before) : null;
  const rows = await db.query<Row>(
    `${ENTRY_SQL} where ${LIVE}
       and ($2::text is null or g.kind = $2) and ($3::text is null or g.slot = $3) and ($4::text is null or (',' || g.fits || ',') like $4)
       and ($5::text is null or (g.name || ' ' || g.authors::text) ilike $5) and ($6::timestamptz is null or (g.published_at, g.id) < ($6, $7::uuid))
     order by g.published_at desc, g.id desc limit $8`,
    [viewer, kind, slot, body, text, cursor ? new Date(cursor[1]!) : null, cursor ? cursor[2] : null, GALLERY_PAGE + 1],
  );
  const entries = rows.slice(0, GALLERY_PAGE).map(entryOf);
  const last = entries.at(-1);
  return { entries, next: rows.length > GALLERY_PAGE && last ? `${last.publishedAt.toISOString()}|${last.id}` : null };
}

/** Takes an entry: the account's own ready copy, made once (taking again answers the same copy). */
export async function take(db: Db, account: { id: string; status: string }, id: string, now: Date): Promise<{ kind: GalleryKind; id: string }> {
  if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot take from the gallery');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContentProblem('not-found', 'no such entry');
  return db.tx(async (t) => {
    const [g] = await t.query<{ kind: GalleryKind; avatar_id: string | null; item_id: string | null; name: string; publisher_id: string }>(`select g.kind, g.avatar_id, g.item_id, g.name, g.publisher_id from gallery g where g.id = $1 and ${LIVE} for update`, [id]);
    if (!g) throw new ContentProblem('not-found', 'no such entry');
    // The publisher has the original already.
    if (g.publisher_id === account.id) return { kind: g.kind, id: (g.avatar_id ?? g.item_id)! };
    const avatar = g.kind === 'avatar';
    const [mine] = avatar
      ? await t.query<{ id: string }>('select id from avatars where owner_id = $1 and gallery_id = $2 and deleted_at is null', [account.id, id])
      : await t.query<{ id: string }>('select id from items where owner_id = $1 and gallery_id = $2 and deleted_at is null', [account.id, id]);
    if (mine) return { kind: g.kind, id: mine.id };
    const [n] = avatar
      ? await t.query<{ n: string }>('select count(*) as n from avatars where owner_id = $1 and deleted_at is null', [account.id])
      : await t.query<{ n: string }>('select count(*) as n from items where owner_id = $1 and deleted_at is null', [account.id]);
    const max = avatar ? MAX_AVATARS : MAX_ITEMS;
    if (Number(n?.n ?? 0) >= max) throw new ContentProblem('upload-limit', `${max} ${avatar ? 'avatars' : 'items'} at most: delete one first`);
    const [row] = avatar
        ? await t.query<{ id: string }>(
            `insert into avatars (owner_id, name, status, source_sha256, source_bytes, manifest_sha256, rank, kit, created_at, converted_at, gallery_id)
             select $1, $2, 'ready', source_sha256, source_bytes, manifest_sha256, rank, kit, $3, $3, $4 from avatars where id = $5 returning id`,
            [account.id, g.name, now, id, g.avatar_id],
          )
        : await t.query<{ id: string }>(
            `insert into items (owner_id, name, status, source_sha256, source_bytes, manifest_sha256, slot, fits, warnings, created_at, converted_at, gallery_id)
             select $1, $2, 'ready', source_sha256, source_bytes, manifest_sha256, slot, fits, warnings, $3, $3, $4 from items where id = $5 returning id`,
            [account.id, g.name, now, id, g.item_id],
          );
    if (!row) throw new ContentProblem('not-found', 'its original is gone');
    await t.query('update gallery set takes = takes + 1 where id = $1', [id]);
    return { kind: g.kind, id: row.id };
  });
}

/** The publisher takes an entry out of the gallery; copies already taken stay. */
export async function withdraw(db: Sql, accountId: string, id: string, now: Date): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return (await db.query('update gallery set withdrawn_at = $3 where id = $1 and publisher_id = $2 and withdrawn_at is null returning id', [id, accountId, now])).length > 0;
}

/** Why an upload of these bytes is refused, if it is: an exact copy of someone else's gallery entry
 *  whose licence does not allow copies. */
export async function copyRefused(db: Sql, accountId: string, sourceSha256: string): Promise<string | undefined> {
  const rows = await db.query<{ name: string; licence: Licence }>(`select g.name, g.licence from gallery g where g.source_sha256 = $1 and g.publisher_id <> $2 and ${LIVE}`, [sourceSha256, accountId]);
  const closed = rows.find((r) => r.licence.allowRedistribution !== true);
  return closed ? `this file is “${closed.name}” in the gallery, whose licence does not allow copies: take it from the gallery instead` : undefined;
}
