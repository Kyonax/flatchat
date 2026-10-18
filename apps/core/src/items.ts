// SPDX-License-Identifier: AGPL-3.0-or-later
// Items and outfits in the core (S5.05). An item upload goes the way an avatar's does: an account at
// trust level 1 or more (or a tester) asks for a slot with the file's size and SHA-256, sends the
// file to the slot's signed link, and the core converts it in a separate, sandboxed process
// (tools/converter/src/item-cli.ts; see sandbox.ts) that may also read the standard bodies, for the
// skeleton and clipping checks. Its formats are the avatars' (S5.08): an FBX, an OBJ or a .blend is
// first turned into a GLB by headless Blender; a file that keeps no declaration of its own (an FBX,
// an OBJ, a DAE) is given one with its slot (its name, slot, the regions it hides or the point it
// is worn at), checked then, kept with the upload and handed to the converter, which uses it when
// the file declares nothing. A ready item's files (a fit per body, or an attachment's prop) go to
// the store and its manifest's SHA-256 names it; anyone signed in may fetch a ready item's files
// through signed links (they see it worn in the world anyway); the source is never handed out.
// The starter wardrobe (Track P's P.08, kits/items/) is any account's for the taking, with no upload,
// as a standard body is: converted once per start of the core and reused, never taken for a copy
// (its fingerprints, like the bodies', explain what they match), never published to the gallery.
// An outfit is an account's saved set of its ready items (16 at most, the protocol's OUTFIT_MAX),
// worn together under packages/content's outfitProblems and with each prop's adjustment within
// WORN_LIMITS; the client sends the one it puts on to the world.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AttachPoint, BODY_KITS, checkItemManifest, type Fingerprint, fitWornAdjust, ITEM_SOURCE_LIMIT, type ItemDeclaration, ItemFormatError, type ItemManifest, outfitProblems, readItemDeclaration, type Slot, type WornAdjust } from '@flatchat/content';
import { OUTFIT_MAX } from '@flatchat/protocol';
import type { Db, Sql } from './db.ts';
import { copyOf, readFingerprint, readKitFingerprints, strike } from './copies.ts';
import { cleanName, ContentProblem, converterArgs, converterFailure, type ConverterProgram, networkNamespace, runConverter, throughBlender } from './sandbox.ts';
import { checkSignature, type FileStore, HASH, linkKey, sha256, signPath } from './store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAX_ITEMS = 200;
export const MAX_OUTFITS = 30;
export const SLOT_MS = 15 * 60_000;
export const CONVERT_MS = 10 * 60_000;
export const NAME_MAX = 64;

export interface ItemRow {
  id: string;
  name: string;
  /** `removed`: taken down (S5.09); its problems say why. */
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed' | 'removed';
  slot: Slot | null;
  /** The bodies it fits; empty for an attachment, which goes on any avatar. */
  fits: string[];
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: Date;
  /** Its gallery entry, when the account published it (S5.06); the entry it came from, when taken. */
  published: string | null;
  fromGallery: string | null;
  /** The starter wardrobe's id for it, when it is one (P.08). */
  starter: string | null;
}

/** A starter item as kits/items/wardrobe.json lists it: its name, its file, that file's SHA-256 and size. */
export interface StarterFile {
  id: string;
  name: string;
  file: string;
  sha256: string;
  bytes: number;
}

/** The starter wardrobe in a folder (kits/items/), by id; none when it has no wardrobe.json. */
export function readStarters(dir: string): Map<string, StarterFile> {
  const out = new Map<string, StarterFile>();
  const file = join(dir, 'wardrobe.json');
  if (!existsSync(file)) return out;
  const listed = JSON.parse(readFileSync(file, 'utf8')) as { items?: Array<{ id?: unknown; name?: unknown; file?: unknown; sha256?: unknown; bytes?: unknown }> };
  for (const i of listed.items ?? []) {
    if (typeof i.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(i.id) || typeof i.file !== 'string' || typeof i.sha256 !== 'string' || !HASH.test(i.sha256) || !Number.isInteger(i.bytes)) continue;
    out.set(i.id, { id: i.id, name: typeof i.name === 'string' ? i.name : i.id, file: join(dir, i.file), sha256: i.sha256, bytes: i.bytes as number });
  }
  return out;
}

/** A worn item as an outfit keeps it and the protocol carries it. */
export interface OutfitItem {
  item: string;
  adjust?: WornAdjust;
}

export interface OutfitRow {
  id: string;
  name: string;
  items: OutfitItem[];
  updatedAt: Date;
}

export interface ItemsOptions {
  db: Db;
  store: FileStore;
  secret: Uint8Array;
  publicUrl: string;
  /** Encode textures to KTX2 (off in tests: minutes become seconds). */
  ktx2?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The converter program (default: the repository's tools/converter). */
  converter?: ConverterProgram;
  /** The standard bodies' folder the converter reads (default: the repository's kits/bodies/). */
  kits?: string;
  /** The starter wardrobe's folder (default: the repository's kits/items/). */
  wardrobe?: string;
  /** Headless Blender (its executable), for FBX, OBJ and .blend; without it those are refused. */
  blender?: string;
}

export class Items {
  private readonly o: ItemsOptions;
  private readonly key: Buffer;
  private queue: Promise<void> = Promise.resolve();
  private readonly isolated: boolean;
  private readonly converter: ConverterProgram;
  private readonly kits: string;
  /** The standard bodies' and the starter items' fingerprints (S5.09): what they explain is no
   *  evidence of a copy. */
  private readonly kitPrints: Fingerprint[];
  /** The starter wardrobe (P.08), by id. */
  readonly starters: Map<string, StarterFile>;
  private readonly startedAt = new Date();
  /** Conversions waiting or running, for tests and a clean shutdown. */
  pending = 0;

  constructor(o: ItemsOptions) {
    this.o = o;
    // The same key as the avatars' slots: each slot's path names its kind and its upload.
    this.key = linkKey(o.secret);
    this.isolated = networkNamespace();
    this.converter = o.converter ?? {
      script: join(ROOT, 'tools', 'converter', 'src', 'item-cli.ts'),
      sandbox: join(ROOT, 'tools', 'converter', 'src', 'sandbox.ts'),
      reads: [join(ROOT, 'node_modules'), join(ROOT, 'tools', 'converter'), join(ROOT, 'packages')],
    };
    this.kits = o.kits ?? join(ROOT, 'kits', 'bodies');
    const wardrobe = o.wardrobe ?? join(ROOT, 'kits', 'items');
    this.starters = readStarters(wardrobe);
    this.kitPrints = [...readKitFingerprints(this.kits), ...readKitFingerprints(wardrobe)];
  }

  /** A starter item for an account (P.08), with no upload: the one it took already, or one this
   *  start of the core converted (ready at once), or the wardrobe's file converted like an upload. */
  async starter(account: { id: string; status: string }, id: string, now: Date): Promise<{ id: string; status: 'converting' | 'ready' }> {
    if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot take items');
    const s = this.starters.get(id);
    if (!s) throw new ContentProblem('not-found', 'no such starter item');
    const [mine] = await this.o.db.query<{ id: string; status: 'converting' | 'ready' }>(
      "select id, status from items where owner_id = $1 and starter = $2 and source_sha256 = $3 and status in ('converting', 'ready') and deleted_at is null order by created_at desc limit 1",
      [account.id, id, s.sha256],
    );
    if (mine) return mine;
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from items where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_ITEMS) throw new ContentProblem('upload-limit', `${MAX_ITEMS} items at most: delete one first`);
    const [done] = await this.o.db.query<{ manifest_sha256: string; slot: Slot; fits: string; warnings: string; name: string; fingerprint: unknown }>(
      "select manifest_sha256, slot, fits, warnings, name, fingerprint from items where starter = $1 and source_sha256 = $2 and status = 'ready' and converted_at >= $3 order by converted_at desc limit 1",
      [id, s.sha256, this.startedAt],
    );
    if (done && this.o.store.has(done.manifest_sha256)) {
      const [row] = await this.o.db.query<{ id: string }>(
        "insert into items (owner_id, name, status, source_sha256, source_bytes, manifest_sha256, slot, fits, warnings, fingerprint, starter, created_at, converted_at) values ($1, $2, 'ready', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id",
        [account.id, done.name, s.sha256, s.bytes, done.manifest_sha256, done.slot, done.fits, done.warnings, done.fingerprint === null ? null : JSON.stringify(done.fingerprint), id, now, new Date()],
      );
      return { id: row!.id, status: 'ready' };
    }
    const bytes = new Uint8Array(readFileSync(s.file));
    if (bytes.length !== s.bytes || sha256(bytes) !== s.sha256) throw new Error(`the starter item ${id} is not the one wardrobe.json names`);
    this.o.store.put(bytes);
    const [row] = await this.o.db.query<{ id: string }>(
      "insert into items (owner_id, name, status, source_sha256, source_bytes, starter, created_at) values ($1, $2, 'converting', $3, $4, $5, $6) returning id",
      [account.id, cleanName(s.name, NAME_MAX), s.sha256, s.bytes, id, now],
    );
    this.pending += 1;
    this.queue = this.queue.then(() => this.convert(row!.id, s.sha256)).finally(() => (this.pending -= 1));
    return { id: row!.id, status: 'converting' };
  }

  /** An upload slot: checked against the account's trust, its items and the size limit. */
  async slot(account: { id: string; trust: number; tester: boolean; status: string }, req: { name: string; bytes: number; sha256: string; declaration?: unknown }, now: Date): Promise<{ id: string; url: string; method: 'PUT'; expires: Date }> {
    if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot upload');
    if (account.trust < 1 && !account.tester) throw new ContentProblem('upload-trust', 'uploading needs trust level 1: an account a few days old with a verified email');
    if (!Number.isInteger(req.bytes) || req.bytes < 20 || !HASH.test(req.sha256)) throw new ContentProblem('bad-request', 'the size and the SHA-256 of the file');
    if (req.bytes > ITEM_SOURCE_LIMIT) throw new ContentProblem('too-large', `an item file is ${ITEM_SOURCE_LIMIT / 1048576} MB at most`);
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from items where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_ITEMS) throw new ContentProblem('upload-limit', `${MAX_ITEMS} items at most: delete one first`);
    // The declaration given with the upload (S5.08), checked now: what the file cannot carry.
    let declaration: ItemDeclaration | null = null;
    if (req.declaration !== undefined && req.declaration !== null) {
      try {
        declaration = readItemDeclaration(req.declaration);
      } catch (err) {
        throw new ContentProblem('bad-request', err instanceof ItemFormatError ? err.problems.join('; ') : 'the declaration does not read');
      }
    }
    const [row] = await this.o.db.query<{ id: string }>(
      "insert into items (owner_id, name, status, source_sha256, source_bytes, declaration, created_at) values ($1, $2, 'uploading', $3, $4, $5, $6) returning id",
      [account.id, cleanName(req.name, NAME_MAX), req.sha256, req.bytes, declaration === null ? null : JSON.stringify(declaration), now],
    );
    const expires = Math.floor((now.getTime() + SLOT_MS) / 1000);
    const path = `/api/v1/items/${row!.id}/source`;
    return { id: row!.id, url: `${this.o.publicUrl}${path}?e=${expires}&s=${signPath(this.key, path, expires)}`, method: 'PUT', expires: new Date(expires * 1000) };
  }

  /** The file sent to a slot: it must be what the slot was asked for. Starts the conversion. */
  async receive(id: string, query: { e: string; s: string }, bytes: Uint8Array, now: Date): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContentProblem('not-found', 'no such upload');
    const check = checkSignature(this.key, `/api/v1/items/${id}/source`, query.e, query.s, now);
    if (check !== 'ok') throw new ContentProblem(check === 'expired' ? 'slot-expired' : 'not-found', check === 'expired' ? 'the upload slot expired: ask for a new one' : 'no such upload');
    const [row] = await this.o.db.query<{ source_sha256: string; source_bytes: number }>("select source_sha256, source_bytes from items where id = $1 and status = 'uploading'", [id]);
    if (!row) throw new ContentProblem('not-found', 'no such upload');
    if (bytes.length !== row.source_bytes || sha256(bytes) !== row.source_sha256) throw new ContentProblem('mismatch', 'the file is not the one the slot was asked for');
    this.o.store.put(bytes);
    await this.o.db.query("update items set status = 'converting' where id = $1", [id]);
    this.pending += 1;
    this.queue = this.queue.then(() => this.convert(id, row.source_sha256)).finally(() => (this.pending -= 1));
  }

  /** Waits for every conversion asked for so far (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  private async convert(id: string, source: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'fcitem-'));
    const input = join(dir, 'upload');
    const out = join(dir, 'out');
    const started = Date.now();
    const refuse = async (problems: string[]): Promise<void> => {
      await this.o.db.query("update items set status = 'refused', problems = $2, converted_at = $3 where id = $1", [id, problems.join('\n').slice(0, 4000), new Date()]);
      this.o.log?.('item-refused', { problems: problems.length, ms: Date.now() - started });
    };
    try {
      const upload = this.o.store.read(source)!;
      writeFileSync(input, upload);
      mkdirSync(out);
      const more: string[] = [this.kits];
      const reads: string[] = [this.kits];
      const [row] = await this.o.db.query<{ declaration: unknown; owner_id: string; starter: string | null }>('select declaration, owner_id, starter from items where id = $1', [id]);
      if (row?.declaration) {
        const declared = join(dir, 'declaration.json');
        writeFileSync(declared, JSON.stringify(row.declaration));
        more.push('--declare', declared);
        reads.push(declared);
      }
      // An FBX, OBJ or .blend: the GLB Blender makes of it, and what it was.
      const blended = await throughBlender(this.o.blender, upload, input, { dir, source: { sha256: source, bytes: upload.length }, isolated: this.isolated });
      if (blended && 'refused' in blended) {
        await refuse([blended.refused]);
        return;
      }
      if (blended) more.push(...blended.args);
      const args = converterArgs(this.converter, blended?.input ?? input, out, this.o.ktx2 !== false, { reads, args: more });
      const run = await runConverter(args, out, { isolated: this.isolated, timeoutMs: CONVERT_MS });
      const { code, result } = run;
      if (result?.ok && code === 0) {
        const manifest = checkItemManifest(result.manifest);
        // A copy of something taken down, or of another's closed gallery entry, goes no further
        // (S5.09); a starter item is everyone's.
        const fingerprint = readFingerprint(result.fingerprint);
        const caught = fingerprint && row && !row.starter ? await copyOf(this.o.db, fingerprint, row.owner_id, this.kitPrints) : undefined;
        if (caught) {
          if (caught.of === 'removed') await strike(this.o.db, row!.owner_id, 'copy', caught.detail, new Date());
          this.o.log?.('item-copy', { of: caught.of });
          await refuse([caught.reason]);
          return;
        }
        // Every file the manifest names, checked against its name, into the store.
        const names = new Set([...Object.values(manifest.fits).map((f) => f!.file), ...(manifest.prop ? [manifest.prop.file] : [])]);
        for (const name of readdirSync(out)) {
          if (!HASH.test(name)) continue;
          const bytes = new Uint8Array(readFileSync(join(out, name)));
          if (!names.has(name) || sha256(bytes) !== name) throw new Error(`the converter wrote an unexpected file ${name.slice(0, 12)}`);
          this.o.store.put(bytes);
        }
        for (const name of names) if (!this.o.store.has(name)) throw new Error('the converter left out a fit');
        const manifestHash = this.o.store.put(readFileSync(join(out, 'manifest.json')));
        if (manifestHash !== result.id) throw new Error('the manifest is not the one the converter named');
        const fits = BODY_KITS.filter((b) => manifest.fits[b]).join(',');
        await this.o.db.query(
          "update items set status = 'ready', manifest_sha256 = $2, slot = $3, fits = $4, warnings = $5, converted_at = $6, name = case when name = '' then $7 else name end, fingerprint = $8 where id = $1",
          [id, manifestHash, manifest.slot, fits, manifest.warnings.join('\n').slice(0, 4000), new Date(), cleanName(manifest.name, NAME_MAX), fingerprint ? JSON.stringify(fingerprint) : null],
        );
        this.o.log?.('item-ready', { slot: manifest.slot, fits: fits || 'any avatar', ms: Date.now() - started });
      } else if (result && !result.ok) {
        await refuse(result.problems ?? []);
      } else {
        throw new Error(converterFailure(run));
      }
    } catch (err) {
      await this.o.db.query("update items set status = 'failed', problems = $2, converted_at = $3 where id = $1", [id, err instanceof Error ? err.message.slice(0, 500) : 'failed', new Date()]);
      this.o.log?.('item-failed', { why: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(db: Sql, accountId: string): Promise<ItemRow[]> {
    const rows = await db.query<{ id: string; name: string; status: ItemRow['status']; slot: Slot | null; fits: string; problems: string; warnings: string; manifest_sha256: string | null; created_at: Date; published: string | null; gallery_id: string | null; starter: string | null }>(
      `select i.id, i.name, i.status, i.slot, i.fits, case when i.status = 'removed' then i.removal else i.problems end as problems, i.warnings, i.manifest_sha256, i.created_at, i.gallery_id, i.starter,
         (select g.id from gallery g where g.item_id = i.id and g.withdrawn_at is null and g.removed_at is null limit 1) as published
       from items i where i.owner_id = $1 and i.deleted_at is null order by i.created_at desc limit 500`,
      [accountId],
    );
    const lines = (t: string): string[] => (t ? t.split('\n') : []);
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, slot: r.slot, fits: r.fits ? r.fits.split(',') : [], problems: lines(r.problems), warnings: lines(r.warnings), manifest: r.manifest_sha256, createdAt: r.created_at, published: r.published, fromGallery: r.gallery_id, starter: r.starter }));
  }

  /** Deletes an item; outfits that held it keep the rest. */
  async remove(db: Sql, accountId: string, itemId: string, now: Date): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) return false;
    const [done] = await db.query<{ manifest_sha256: string | null }>('update items set deleted_at = $3 where id = $1 and owner_id = $2 and deleted_at is null returning manifest_sha256', [itemId, accountId, now]);
    if (!done) return false;
    // Its gallery entry goes with it (S5.06); copies already taken stay.
    await db.query('update gallery set withdrawn_at = $2 where item_id = $1 and withdrawn_at is null', [itemId, now]);
    if (done.manifest_sha256) {
      await db.query(
        "update outfits set items = coalesce((select jsonb_agg(e) from jsonb_array_elements(items) e where e->>'item' <> $2), '[]'::jsonb), updated_at = $3 where owner_id = $1 and items @> jsonb_build_array(jsonb_build_object('item', $2::text))",
        [accountId, done.manifest_sha256, now],
      );
    }
    return true;
  }

  /** A ready item's manifest and signed links to its files (each fit by body, or the prop), for
   *  any signed-in account: only items that are ready and not deleted, and never their source. */
  async delivery(db: Sql, manifestHash: string, now: Date): Promise<{ manifest: ItemManifest; links: Record<string, string> } | undefined> {
    if (!HASH.test(manifestHash)) return undefined;
    const [r] = await db.query("select 1 from items where manifest_sha256 = $1 and status = 'ready' and deleted_at is null limit 1", [manifestHash]);
    const bytes = r ? this.o.store.read(manifestHash) : undefined;
    if (!bytes) return undefined;
    const manifest = checkItemManifest(JSON.parse(new TextDecoder().decode(bytes)));
    const links: Record<string, string> = { manifest: this.o.store.link(manifestHash, now) };
    for (const body of BODY_KITS) {
      const fit = manifest.fits[body];
      if (fit) links[body] = this.o.store.link(fit.file, now);
    }
    if (manifest.prop) links['prop'] = this.o.store.link(manifest.prop.file, now);
    return { manifest, links };
  }

  // ---------------------------------------------------------------- outfits

  async outfits(db: Sql, accountId: string): Promise<OutfitRow[]> {
    const rows = await db.query<{ id: string; name: string; items: OutfitItem[]; updated_at: Date }>('select id, name, items, updated_at from outfits where owner_id = $1 order by updated_at desc limit $2', [accountId, MAX_OUTFITS]);
    return rows.map((r) => ({ id: r.id, name: r.name, items: r.items, updatedAt: r.updated_at }));
  }

  /** Saves an outfit, new (`id` null) or in place of one of the account's own. Its items are the
   *  account's ready items, each once, wearable together, a prop's adjustment within the limits. */
  async saveOutfit(db: Sql, accountId: string, id: string | null, body: { name: unknown; items: unknown }, now: Date): Promise<OutfitRow> {
    const name = cleanName(body.name, NAME_MAX);
    if (!name) throw new ContentProblem('bad-request', 'an outfit has a name');
    const items = await this.checkOutfit(db, accountId, body.items);
    if (id === null) {
      const [n] = await db.query<{ n: string }>('select count(*) as n from outfits where owner_id = $1', [accountId]);
      if (Number(n?.n ?? 0) >= MAX_OUTFITS) throw new ContentProblem('outfit-limit', `${MAX_OUTFITS} outfits at most: delete one first`);
      const [row] = await db.query<{ id: string }>('insert into outfits (owner_id, name, items, created_at, updated_at) values ($1, $2, $3, $4, $4) returning id', [accountId, name, JSON.stringify(items), now]);
      return { id: row!.id, name, items, updatedAt: now };
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContentProblem('not-found', 'no such outfit');
    const done = await db.query('update outfits set name = $3, items = $4, updated_at = $5 where id = $1 and owner_id = $2 returning id', [id, accountId, name, JSON.stringify(items), now]);
    if (done.length === 0) throw new ContentProblem('not-found', 'no such outfit');
    return { id, name, items, updatedAt: now };
  }

  async removeOutfit(db: Sql, accountId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    return (await db.query('delete from outfits where id = $1 and owner_id = $2 returning id', [id, accountId])).length > 0;
  }

  private async checkOutfit(db: Sql, accountId: string, value: unknown): Promise<OutfitItem[]> {
    if (!Array.isArray(value) || value.length > OUTFIT_MAX) throw new ContentProblem('bad-request', `an outfit is a list of ${OUTFIT_MAX} items at most`);
    const items: OutfitItem[] = [];
    for (const v of value as unknown[]) {
      const e = (v ?? {}) as { item?: unknown; adjust?: unknown };
      if (typeof e.item !== 'string' || !HASH.test(e.item)) throw new ContentProblem('bad-request', 'each item is its manifest\'s SHA-256');
      if (items.some((i) => i.item === e.item)) throw new ContentProblem('bad-request', 'an item is in an outfit once');
      let adjust: WornAdjust | undefined;
      if (e.adjust !== undefined) {
        const a = e.adjust as Record<string, unknown>;
        const keys = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'] as const;
        if (typeof a !== 'object' || a === null || keys.some((k) => !Number.isInteger(a[k]))) throw new ContentProblem('bad-request', 'an adjustment is x, y, z (cm), rx, ry, rz (degrees) and scale (percent), whole numbers');
        adjust = Object.fromEntries(keys.map((k) => [k, a[k] as number])) as unknown as WornAdjust;
        if (JSON.stringify(fitWornAdjust(adjust)) !== JSON.stringify(adjust)) throw new ContentProblem('bad-request', 'an adjustment is within 10 cm, 45 degrees and 80 to 125 percent');
      }
      items.push({ item: e.item, ...(adjust ? { adjust } : {}) });
    }
    if (items.length === 0) return items;
    const rows = await db.query<{ manifest_sha256: string; slot: Slot }>(
      "select manifest_sha256, slot from items where owner_id = $1 and manifest_sha256 = any($2::text[]) and status = 'ready' and deleted_at is null",
      [accountId, items.map((i) => i.item)],
    );
    const slots = new Map(rows.map((r) => [r.manifest_sha256, r.slot]));
    const missing = items.filter((i) => !slots.has(i.item)).length;
    if (missing > 0) throw new ContentProblem('not-found', `${missing} of the outfit's items are not among this account's ready items`);
    const worn: Array<{ slot: Slot; attach?: AttachPoint }> = [];
    for (const i of items) {
      const slot = slots.get(i.item)!;
      if (slot !== 'attachment' && i.adjust) throw new ContentProblem('bad-request', 'only an attachment takes an adjustment');
      worn.push(slot === 'attachment' ? { slot, attach: (await this.pointOf(i.item)) ?? 'hips' } : { slot });
    }
    const problems = outfitProblems(worn);
    if (problems.length > 0) throw new ContentProblem('bad-request', `these items cannot be worn together: ${problems.join('; ')}`);
    return items;
  }

  /** An attachment's point, from its manifest in the store. */
  private async pointOf(manifestHash: string): Promise<AttachPoint | undefined> {
    const bytes = this.o.store.read(manifestHash);
    return bytes ? checkItemManifest(JSON.parse(new TextDecoder().decode(bytes))).attach : undefined;
  }
}
