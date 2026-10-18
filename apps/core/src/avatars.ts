// SPDX-License-Identifier: AGPL-3.0-or-later
// Avatars in the core (S4.01 uploads, S4.04 the store and delivery, S5.05 the standard bodies). An
// account at trust level 1 or more (or a tester) asks for an upload slot with the file's size and
// SHA-256; the client sends the file to the slot's signed link; the core keeps the source in its
// store and converts it in a separate, sandboxed process (tools/converter/src/avatar-cli.ts; see
// sandbox.ts), one conversion at a time. A converted avatar's files go to the store; its manifest's
// SHA-256 names it. An account wears one of its ready avatars; anyone signed in may fetch a worn
// avatar's levels through signed links (they see it in the world anyway); the source is never
// handed out. The three standard bodies (kits/bodies/, dp-001) are avatars too: any account may
// take one without an upload (`kit`), and an avatar whose source is a kit's exact bytes is that
// body (its delivery says `kit`), so the client knows the items made for it fit. A VRM, a GLB or a
// DAE goes to the converter as it is; an FBX, an OBJ or a .blend is first turned into a GLB by
// headless Blender in a sandbox of its own (S5.08, sandbox.ts); a core without Blender
// (FLATCHAT_CORE_BLENDER unset) refuses those with that reason.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_SOURCE_LIMIT, type AvatarManifest, BODY_KITS, type BodyKit, checkManifest, LEVELS } from '@flatchat/content';
import type { Db, Sql } from './db.ts';
import { cleanName, ContentProblem, converterArgs, converterFailure, type ConverterProgram, networkNamespace, runConverter, throughBlender } from './sandbox.ts';
import { checkSignature, type FileStore, HASH, linkKey, sha256, signPath } from './store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAX_AVATARS = 50;
export const SLOT_MS = 15 * 60_000;
export const CONVERT_MS = 10 * 60_000;
export const NAME_MAX = 64;

export interface AvatarRow {
  id: string;
  name: string;
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed';
  rank: string | null;
  problems: string[];
  manifest: string | null;
  createdAt: Date;
  wearing: boolean;
  /** The standard body it is, when its source is a kit's exact bytes. */
  kit: BodyKit | null;
  /** Its gallery entry, when the account published it (S5.06); the entry it came from, when taken. */
  published: string | null;
  fromGallery: string | null;
}

/** A standard body as kits/bodies/kits.json names it: its VRM and that file's SHA-256 and size. */
export interface KitFile {
  file: string;
  sha256: string;
  bytes: number;
}

/** The standard bodies in a kits folder (kits/bodies/), by name; none when it has no kits.json. */
export function readKits(dir: string): Map<BodyKit, KitFile> {
  const kits = new Map<BodyKit, KitFile>();
  let listed: { kits?: Record<string, { vrm?: string; vrmSha256?: string; vrmBytes?: number }> };
  try {
    listed = JSON.parse(readFileSync(join(dir, 'kits.json'), 'utf8')) as typeof listed;
  } catch {
    return kits;
  }
  for (const body of BODY_KITS) {
    const k = listed.kits?.[body];
    if (k?.vrm && k.vrmSha256 && HASH.test(k.vrmSha256) && Number.isInteger(k.vrmBytes)) kits.set(body, { file: join(dir, body, k.vrm), sha256: k.vrmSha256, bytes: k.vrmBytes! });
  }
  return kits;
}

export interface AvatarsOptions {
  db: Db;
  store: FileStore;
  secret: Uint8Array;
  publicUrl: string;
  /** Encode textures to KTX2 (off in tests: minutes become seconds). */
  ktx2?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The converter program (default: the repository's tools/converter). */
  converter?: ConverterProgram;
  /** The standard bodies' folder (default: the repository's kits/bodies/). */
  kits?: string;
  /** Headless Blender (its executable), for FBX, OBJ and .blend; without it those are refused. */
  blender?: string;
}

export class Avatars {
  private readonly o: AvatarsOptions;
  private readonly key: Buffer;
  private queue: Promise<void> = Promise.resolve();
  private readonly isolated: boolean;
  private readonly converter: ConverterProgram;
  /** The standard bodies, by name and by their VRM's SHA-256. */
  readonly kits: Map<BodyKit, KitFile>;
  private readonly kitBySource: Map<string, BodyKit>;
  /** Conversions made since this start are made by this converter: a body converted once is reused. */
  private readonly startedAt = new Date();
  /** Conversions waiting or running, for tests and a clean shutdown. */
  pending = 0;

  constructor(o: AvatarsOptions) {
    this.o = o;
    this.key = linkKey(o.secret);
    this.isolated = networkNamespace();
    this.converter = o.converter ?? {
      script: join(ROOT, 'tools', 'converter', 'src', 'avatar-cli.ts'),
      sandbox: join(ROOT, 'tools', 'converter', 'src', 'sandbox.ts'),
      reads: [join(ROOT, 'node_modules'), join(ROOT, 'tools', 'converter'), join(ROOT, 'packages')],
    };
    this.kits = readKits(o.kits ?? join(ROOT, 'kits', 'bodies'));
    this.kitBySource = new Map([...this.kits].map(([body, k]) => [k.sha256, body]));
    o.log?.('avatar-converter', { sandbox: this.isolated ? 'files, addons and network' : 'files and addons (no network namespace on this system)', kits: this.kits.size });
  }

  /** A standard body for an account (S5.05): any active account may take one, no upload and no
   *  trust level needed (it is the platform's). The account's own copy when it has one; else one
   *  converted by this start of the core is reused; else the kit is converted like an upload. */
  async kit(account: { id: string; status: string }, body: string, now: Date): Promise<{ id: string; status: 'converting' | 'ready' }> {
    if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot choose an avatar');
    const k = this.kits.get(body as BodyKit);
    if (!k) throw new ContentProblem('not-found', 'no such standard body');
    const [mine] = await this.o.db.query<{ id: string; status: 'converting' | 'ready' }>(
      "select id, status from avatars where owner_id = $1 and kit = $2 and source_sha256 = $3 and status in ('converting', 'ready') and deleted_at is null order by created_at desc limit 1",
      [account.id, body, k.sha256],
    );
    if (mine) return mine;
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from avatars where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_AVATARS) throw new ContentProblem('upload-limit', `${MAX_AVATARS} avatars at most: delete one first`);
    const done = await this.converted(body as BodyKit, k.sha256);
    if (done) {
      const [row] = await this.o.db.query<{ id: string }>(
        "insert into avatars (owner_id, name, status, source_sha256, source_bytes, manifest_sha256, rank, kit, created_at, converted_at) values ($1, $2, 'ready', $3, $4, $5, $6, $7, $8, $9) returning id",
        [account.id, done.name, k.sha256, k.bytes, done.manifest, done.rank, body, now, new Date()],
      );
      return { id: row!.id, status: 'ready' };
    }
    const bytes = new Uint8Array(readFileSync(k.file));
    if (bytes.length !== k.bytes || sha256(bytes) !== k.sha256) throw new Error(`the ${body} body is not the one kits.json names`);
    this.o.store.put(bytes);
    const [row] = await this.o.db.query<{ id: string }>(
      "insert into avatars (owner_id, name, status, source_sha256, source_bytes, kit, created_at) values ($1, '', 'converting', $2, $3, $4, $5) returning id",
      [account.id, k.sha256, k.bytes, body, now],
    );
    this.enqueue(row!.id, k.sha256);
    return { id: row!.id, status: 'converting' };
  }

  /** A standard body this start of the core already converted, with its files in the store. */
  private async converted(body: BodyKit, source: string): Promise<{ manifest: string; rank: string; name: string } | undefined> {
    const [r] = await this.o.db.query<{ manifest_sha256: string; rank: string; name: string }>(
      "select manifest_sha256, rank, name from avatars where kit = $1 and source_sha256 = $2 and status = 'ready' and converted_at >= $3 order by converted_at desc limit 1",
      [body, source, this.startedAt],
    );
    return r && this.o.store.has(r.manifest_sha256) ? { manifest: r.manifest_sha256, rank: r.rank, name: r.name } : undefined;
  }

  /** An upload slot: checked against the account's trust, its avatars and the size limit. */
  async slot(account: { id: string; trust: number; tester: boolean; status: string }, req: { name: string; bytes: number; sha256: string }, now: Date): Promise<{ id: string; url: string; method: 'PUT'; expires: Date }> {
    if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot upload');
    if (account.trust < 1 && !account.tester) throw new ContentProblem('upload-trust', 'uploading needs trust level 1: an account a few days old with a verified email');
    if (!Number.isInteger(req.bytes) || req.bytes < 20 || !HASH.test(req.sha256)) throw new ContentProblem('bad-request', 'the size and the SHA-256 of the file');
    if (req.bytes > AVATAR_SOURCE_LIMIT) throw new ContentProblem('too-large', `an avatar file is ${AVATAR_SOURCE_LIMIT / 1048576} MB at most`);
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from avatars where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_AVATARS) throw new ContentProblem('upload-limit', `${MAX_AVATARS} avatars at most: delete one first`);
    const name = cleanName(req.name, NAME_MAX);
    const [row] = await this.o.db.query<{ id: string }>(
      "insert into avatars (owner_id, name, status, source_sha256, source_bytes, created_at) values ($1, $2, 'uploading', $3, $4, $5) returning id",
      [account.id, name, req.sha256, req.bytes, now],
    );
    const expires = Math.floor((now.getTime() + SLOT_MS) / 1000);
    const path = `/api/v1/avatars/${row!.id}/source`;
    return { id: row!.id, url: `${this.o.publicUrl}${path}?e=${expires}&s=${signPath(this.key, path, expires)}`, method: 'PUT', expires: new Date(expires * 1000) };
  }

  /** The file sent to a slot: it must be what the slot was asked for. Starts the conversion. */
  async receive(id: string, query: { e: string; s: string }, bytes: Uint8Array, now: Date): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContentProblem('not-found', 'no such upload');
    const check = checkSignature(this.key, `/api/v1/avatars/${id}/source`, query.e, query.s, now);
    if (check !== 'ok') throw new ContentProblem(check === 'expired' ? 'slot-expired' : 'not-found', check === 'expired' ? 'the upload slot expired: ask for a new one' : 'no such upload');
    const [row] = await this.o.db.query<{ source_sha256: string; source_bytes: number }>("select source_sha256, source_bytes from avatars where id = $1 and status = 'uploading'", [id]);
    if (!row) throw new ContentProblem('not-found', 'no such upload');
    if (bytes.length !== row.source_bytes || sha256(bytes) !== row.source_sha256) throw new ContentProblem('mismatch', 'the file is not the one the slot was asked for');
    this.o.store.put(bytes);
    await this.o.db.query("update avatars set status = 'converting' where id = $1", [id]);
    this.enqueue(id, row.source_sha256);
  }

  private enqueue(id: string, source: string): void {
    this.pending += 1;
    this.queue = this.queue.then(() => this.convert(id, source)).finally(() => (this.pending -= 1));
  }

  /** Waits for every conversion asked for so far (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  private async convert(id: string, source: string): Promise<void> {
    const kit = this.kitBySource.get(source) ?? null;
    // Two accounts that took the same body while it converted: the second reuses the first's.
    const done = kit ? await this.converted(kit, source) : undefined;
    if (done) {
      await this.o.db.query("update avatars set status = 'ready', manifest_sha256 = $2, rank = $3, kit = $4, converted_at = $5, name = case when name = '' then $6 else name end where id = $1", [id, done.manifest, done.rank, kit, new Date(), done.name]);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'fcavatar-'));
    const input = join(dir, 'upload');
    const out = join(dir, 'out');
    const started = Date.now();
    const refuse = async (problems: string[]): Promise<void> => {
      await this.o.db.query("update avatars set status = 'refused', problems = $2, converted_at = $3 where id = $1", [id, problems.join('\n').slice(0, 4000), new Date()]);
      this.o.log?.('avatar-refused', { problems: problems.length, ms: Date.now() - started });
    };
    try {
      const upload = this.o.store.read(source)!;
      writeFileSync(input, upload);
      mkdirSync(out);
      // An FBX, OBJ or .blend: the GLB Blender makes of it, and what it was.
      const blended = await throughBlender(this.o.blender, upload, input, { dir, source: { sha256: source, bytes: upload.length }, isolated: this.isolated });
      if (blended && 'refused' in blended) {
        await refuse([blended.refused]);
        return;
      }
      const run = await runConverter(converterArgs(this.converter, blended?.input ?? input, out, this.o.ktx2 !== false, { args: blended?.args ?? [] }), out, { isolated: this.isolated, timeoutMs: CONVERT_MS });
      const { code, result } = run;
      if (result?.ok && code === 0) {
        const manifest = checkManifest(result.manifest);
        // Every file the manifest names, checked against its name, into the store.
        const names = new Set([...LEVELS.map((l) => manifest.levels[l].file), ...(manifest.thumbnail ? [manifest.thumbnail] : [])]);
        for (const name of readdirSync(out)) {
          if (!HASH.test(name)) continue;
          const bytes = new Uint8Array(readFileSync(join(out, name)));
          if (!names.has(name) || sha256(bytes) !== name) throw new Error(`the converter wrote an unexpected file ${name.slice(0, 12)}`);
          this.o.store.put(bytes);
        }
        for (const name of names) if (!this.o.store.has(name)) throw new Error('the converter left out a level');
        const manifestHash = this.o.store.put(readFileSync(join(out, 'manifest.json')));
        if (manifestHash !== result.id) throw new Error('the manifest is not the one the converter named');
        await this.o.db.query("update avatars set status = 'ready', manifest_sha256 = $2, rank = $3, kit = $4, converted_at = $5, name = case when name = '' then $6 else name end where id = $1", [id, manifestHash, manifest.rank, kit, new Date(), cleanName(manifest.name, NAME_MAX)]);
        this.o.log?.('avatar-ready', { rank: manifest.rank, ...(kit ? { kit } : {}), ms: Date.now() - started });
      } else if (result && !result.ok) {
        await refuse(result.problems ?? []);
      } else {
        throw new Error(converterFailure(run));
      }
    } catch (err) {
      await this.o.db.query("update avatars set status = 'failed', problems = $2, converted_at = $3 where id = $1", [id, err instanceof Error ? err.message.slice(0, 500) : 'failed', new Date()]);
      this.o.log?.('avatar-failed', { why: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(db: Sql, accountId: string): Promise<AvatarRow[]> {
    const rows = await db.query<{ id: string; name: string; status: AvatarRow['status']; rank: string | null; problems: string; manifest_sha256: string | null; created_at: Date; wearing: boolean; kit: BodyKit | null; published: string | null; gallery_id: string | null }>(
      `select v.id, v.name, v.status, v.rank, v.problems, v.manifest_sha256, v.created_at, a.avatar_id = v.id as wearing, v.kit, v.gallery_id,
         (select g.id from gallery g where g.avatar_id = v.id and g.withdrawn_at is null and g.removed_at is null limit 1) as published
       from avatars v join accounts a on a.id = v.owner_id where v.owner_id = $1 and v.deleted_at is null order by v.created_at desc limit 100`,
      [accountId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, rank: r.rank, problems: r.problems ? r.problems.split('\n') : [], manifest: r.manifest_sha256, createdAt: r.created_at, wearing: r.wearing === true, kit: r.kit, published: r.published, fromGallery: r.gallery_id }));
  }

  /** Wears one of the account's ready avatars (or none). */
  async wear(db: Sql, accountId: string, avatarId: string | null): Promise<void> {
    if (avatarId !== null) {
      if (!/^[0-9a-f-]{36}$/i.test(avatarId)) throw new ContentProblem('not-found', 'no such avatar');
      const [r] = await db.query<{ status: string }>('select status from avatars where id = $1 and owner_id = $2 and deleted_at is null', [avatarId, accountId]);
      if (!r) throw new ContentProblem('not-found', 'no such avatar');
      if (r.status !== 'ready') throw new ContentProblem('not-ready', 'that avatar is not ready');
    }
    await db.query('update accounts set avatar_id = $2 where id = $1', [accountId, avatarId]);
  }

  async remove(db: Sql, accountId: string, avatarId: string, now: Date): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(avatarId)) return false;
    const done = await db.query('update avatars set deleted_at = $3 where id = $1 and owner_id = $2 and deleted_at is null returning id', [avatarId, accountId, now]);
    if (done.length === 0) return false;
    // Its gallery entry goes with it (S5.06); copies already taken stay.
    await db.query('update gallery set withdrawn_at = $2 where avatar_id = $1 and withdrawn_at is null', [avatarId, now]);
    await db.query('update accounts set avatar_id = null where id = $1 and avatar_id = $2', [accountId, avatarId]);
    return true;
  }

  /** The manifest hash of the avatar an account wears, if any: what its connect token names. */
  async worn(db: Sql, accountId: string): Promise<string | undefined> {
    const [r] = await db.query<{ manifest_sha256: string | null }>(
      "select v.manifest_sha256 from accounts a join avatars v on v.id = a.avatar_id where a.id = $1 and v.status = 'ready' and v.deleted_at is null",
      [accountId],
    );
    return r?.manifest_sha256 ?? undefined;
  }

  /** A converted avatar's manifest and signed links to its files, for any signed-in account: only
   *  avatars that are ready and not deleted are delivered, and never their source. */
  async delivery(db: Sql, manifestHash: string, now: Date): Promise<{ manifest: AvatarManifest; links: Record<string, string>; kit?: BodyKit } | undefined> {
    if (!HASH.test(manifestHash)) return undefined;
    const [r] = await db.query<{ kit: BodyKit | null }>("select kit from avatars where manifest_sha256 = $1 and status = 'ready' and deleted_at is null order by kit nulls last limit 1", [manifestHash]);
    const bytes = r ? this.o.store.read(manifestHash) : undefined;
    if (!bytes) return undefined;
    const manifest = checkManifest(JSON.parse(new TextDecoder().decode(bytes)));
    const links: Record<string, string> = { manifest: this.o.store.link(manifestHash, now) };
    for (const l of LEVELS) links[l] = this.o.store.link(manifest.levels[l].file, now);
    if (manifest.thumbnail) links['thumbnail'] = this.o.store.link(manifest.thumbnail, now);
    return { manifest, links, ...(r?.kit ? { kit: r.kit } : {}) };
  }
}

