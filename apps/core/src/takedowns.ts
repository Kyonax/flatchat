// SPDX-License-Identifier: AGPL-3.0-or-later
// Takedowns (S5.09, G-10, Q-J4, cl-005). A rights holder asks, on the public form beside the report
// form (/takedown), for an avatar or an item that copies their work to come down: who they are, how
// to answer them, the work and where it is, what on FlatChat copies it (a gallery entry's link or
// ID, or words), their word that the request is made in good faith, accurate and theirs to make,
// and their name as a signature. They keep a receipt and read the decision by it. The admin page
// reviews each request; removing takes the avatar or item down everywhere (removeContent): every
// gallery entry of its manifest, every avatars or items row of it (the original, the copies taken
// from the gallery, exact re-uploads), the outfits that hold it, and whoever wears it; its files
// are no longer delivered. The admin page also removes, with no request, what breaks the content
// rule (no sexual content or nudity, OQ-11), and may ban the uploader. A removed row keeps its
// fingerprint, so a re-exported copy is caught (copies.ts). The standard bodies are never removed.
import { randomBytes } from 'node:crypto';
import type { Db, Sql } from './db.ts';
import { strike } from './copies.ts';
import { moderateAccount } from './moderation.ts';

export const TAKEDOWN_TEXT_MAX = 2000;

/** A short reference the claimant keeps: T-XXXX-XXXX (Crockford's base 32). */
function receipt(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const c = [...randomBytes(8)].map((x) => alphabet[x % 32]).join('');
  return `T-${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HASH = /^[0-9a-f]{64}$/;

export interface TakedownInput {
  name: string;
  contact: string;
  work: string;
  target: string;
  statement: boolean;
  signature: string;
}

/** What is missing from a request, if anything (the form says it). */
export function takedownProblem(t: TakedownInput): 'name' | 'contact' | 'work' | 'target' | 'statement' | 'signature' | undefined {
  if (!t.name.trim()) return 'name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.contact.trim())) return 'contact';
  if (!t.work.trim()) return 'work';
  if (!t.target.trim()) return 'target';
  if (!t.statement) return 'statement';
  if (!t.signature.trim()) return 'signature';
  return undefined;
}

/** Files a request: its receipt. A gallery entry's ID in what it names links the request to it. */
export async function fileTakedown(db: Sql, t: TakedownInput, now: Date): Promise<{ id: string; receipt: string }> {
  const entry = UUID.exec(t.target)?.[0];
  const [g] = entry ? await db.query<{ id: string }>('select id from gallery where id = $1', [entry]) : [];
  const r = receipt();
  const [row] = await db.query<{ id: string }>(
    'insert into takedowns (receipt, name, contact, work, target, gallery_id, statement, signature, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id',
    [r, t.name.trim().slice(0, 200), t.contact.trim().slice(0, 254), t.work.trim().slice(0, TAKEDOWN_TEXT_MAX), t.target.trim().slice(0, TAKEDOWN_TEXT_MAX), g?.id ?? null, t.statement, t.signature.trim().slice(0, 200), now],
  );
  return { id: row!.id, receipt: r };
}

/** A request's decision, by its receipt, for the claimant. */
export async function takedownStatus(db: Sql, receiptCode: string): Promise<{ status: 'open' | 'removed' | 'rejected'; note: string; decidedAt: Date | null } | undefined> {
  if (!/^T-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(receiptCode)) return undefined;
  const [r] = await db.query<{ status: 'open' | 'removed' | 'rejected'; note: string; decided_at: Date | null }>('select status, note, decided_at from takedowns where receipt = $1', [receiptCode]);
  return r ? { status: r.status, note: r.note, decidedAt: r.decided_at } : undefined;
}

/** An open request, for the admin page: with the gallery entry it names, if it names one. */
export interface AdminTakedown {
  id: string;
  receipt: string;
  name: string;
  contact: string;
  work: string;
  target: string;
  signature: string;
  createdAt: Date;
  entry: { id: string; kind: string; name: string; publisher: string; live: boolean } | null;
}

export async function takedownQueue(db: Sql): Promise<AdminTakedown[]> {
  const rows = await db.query<{ id: string; receipt: string; name: string; contact: string; work: string; target: string; signature: string; created_at: Date; gallery_id: string | null; kind: string | null; entry_name: string | null; publisher: string | null; live: boolean | null }>(
    `select t.id, t.receipt, t.name, t.contact, t.work, t.target, t.signature, t.created_at, t.gallery_id, g.kind, g.name as entry_name, a.email as publisher,
            (g.withdrawn_at is null and g.removed_at is null) as live
       from takedowns t left join gallery g on g.id = t.gallery_id left join accounts a on a.id = g.publisher_id
      where t.status = 'open' order by t.created_at limit 200`,
  );
  return rows.map((r) => ({
    id: r.id,
    receipt: r.receipt,
    name: r.name,
    contact: r.contact,
    work: r.work,
    target: r.target,
    signature: r.signature,
    createdAt: r.created_at,
    entry: r.gallery_id ? { id: r.gallery_id, kind: r.kind ?? '', name: r.entry_name ?? '', publisher: r.publisher ?? '', live: r.live === true } : null,
  }));
}

/** What a removal took down. */
export interface Removal {
  avatars: number;
  items: number;
  entries: number;
  /** The accounts whose own uploads (not copies taken from the gallery) came down. */
  uploaders: string[];
}

/** Takes an avatar or item down everywhere: by a gallery entry, or by its manifest's SHA-256. */
export async function removeContent(db: Db, target: { gallery?: string; manifest?: string }, reason: string, now: Date): Promise<Removal | undefined> {
  return db.tx(async (t) => {
    let manifest = target.manifest;
    if (target.gallery) {
      if (!UUID.test(target.gallery)) return undefined;
      const [g] = await t.query<{ manifest_sha256: string }>('select manifest_sha256 from gallery where id = $1', [target.gallery]);
      manifest = g?.manifest_sha256;
    }
    if (!manifest || !HASH.test(manifest)) return undefined;
    const why = reason.slice(0, 500);
    const entries = await t.query<{ id: string }>('update gallery set removed_at = $2 where manifest_sha256 = $1 and removed_at is null returning id', [manifest, now]);
    // Every row of it, but never a standard body.
    const avatars = await t.query<{ id: string; owner_id: string; gallery_id: string | null }>(
      "update avatars set status = 'removed', removed_at = $2, removal = $3 where manifest_sha256 = $1 and status = 'ready' and kit is null and deleted_at is null returning id, owner_id, gallery_id",
      [manifest, now, why],
    );
    const items = await t.query<{ id: string; owner_id: string; gallery_id: string | null }>(
      "update items set status = 'removed', removed_at = $2, removal = $3 where manifest_sha256 = $1 and status = 'ready' and deleted_at is null returning id, owner_id, gallery_id",
      [manifest, now, why],
    );
    if (entries.length === 0 && avatars.length === 0 && items.length === 0) return undefined;
    // No one wears it; no outfit holds it.
    await t.query('update accounts set avatar_id = null where avatar_id = any($1::uuid[])', [avatars.map((a) => a.id)]);
    await t.query(
      `update outfits set items = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from jsonb_array_elements(items) with ordinality as x(e, n) where e->>'item' <> $1), updated_at = $2
        where exists (select 1 from jsonb_array_elements(items) e where e->>'item' = $1)`,
      [manifest, now],
    );
    const uploaders = [...new Set([...avatars, ...items].filter((r) => r.gallery_id === null).map((r) => r.owner_id))];
    for (const u of uploaders) await strike(t, u, 'removed', `taken down: ${why}`, now);
    return { avatars: avatars.length, items: items.length, entries: entries.length, uploaders };
  });
}

/** The admin's decision on a request: remove what it names (by its gallery entry, or the manifest
 *  the admin names), or reject it; with a note the claimant reads, and the uploader banned if asked. */
export async function decideTakedown(
  db: Db,
  id: string,
  d: { decision: 'remove' | 'reject'; note: string; manifest?: string; ban?: boolean },
  actor: string,
  now: Date,
): Promise<{ ok: true; removal?: Removal } | { ok: false; why: 'not-found' | 'nothing-to-remove' }> {
  if (!UUID.test(id)) return { ok: false, why: 'not-found' };
  const [r] = await db.query<{ gallery_id: string | null; receipt: string }>("select gallery_id, receipt from takedowns where id = $1 and status = 'open'", [id]);
  if (!r) return { ok: false, why: 'not-found' };
  let removal: Removal | undefined;
  if (d.decision === 'remove') {
    removal = await removeContent(db, d.manifest ? { manifest: d.manifest } : r.gallery_id ? { gallery: r.gallery_id } : {}, `a rights holder's takedown (${r.receipt})${d.note ? `: ${d.note}` : ''}`, now);
    if (!removal) return { ok: false, why: 'nothing-to-remove' };
    if (d.ban) for (const u of removal.uploaders) await moderateAccount(db, u, 'ban', `uploaded what a rights holder had taken down (${r.receipt})`, actor, now);
  }
  await db.query('update takedowns set status = $2, note = $3, decided_by = $4, decided_at = $5 where id = $1', [id, d.decision === 'remove' ? 'removed' : 'rejected', d.note.slice(0, 1000), actor, now]);
  return { ok: true, ...(removal ? { removal } : {}) };
}
