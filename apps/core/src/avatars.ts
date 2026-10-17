// SPDX-License-Identifier: AGPL-3.0-or-later
// Avatars in the core (S4.01 uploads, S4.04 the store and delivery). An account at trust level 1
// or more (or a tester) asks for an upload slot with the file's size and SHA-256; the client sends
// the file to the slot's signed link; the core keeps the source in its store and converts it in a
// separate, sandboxed process (tools/converter/src/avatar-cli.ts under Node.js's permission model:
// it reads only the converter and the upload, writes only its own folder, loads no native addon,
// runs in a network namespace where the system allows one, with a time and a memory limit), one
// conversion at a time. A converted avatar's files go to the store; its manifest's SHA-256 names
// it. An account wears one of its ready avatars; anyone signed in may fetch a worn avatar's levels
// through signed links (they see it in the world anyway); the source is never handed out.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_SOURCE_LIMIT, type AvatarManifest, checkManifest, LEVELS } from '@flatchat/content';
import type { Db, Sql } from './db.ts';
import { checkSignature, type FileStore, HASH, linkKey, sha256, signPath } from './store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAX_AVATARS = 50;
export const SLOT_MS = 15 * 60_000;
export const CONVERT_MS = 10 * 60_000;
export const NAME_MAX = 64;

export type AvatarProblemCode = 'upload-trust' | 'upload-limit' | 'too-large' | 'bad-request' | 'not-found' | 'not-ready' | 'mismatch' | 'slot-expired';

export class AvatarProblem extends Error {
  readonly code: AvatarProblemCode;
  constructor(code: AvatarProblemCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AvatarRow {
  id: string;
  name: string;
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed';
  rank: string | null;
  problems: string[];
  manifest: string | null;
  createdAt: Date;
  wearing: boolean;
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
  converter?: { script: string; sandbox: string; reads: string[] };
}

/** The converter's command line: Node.js's permission model with reads of the converter's code
 *  and the upload only, writes of its folder only, no addons, workers or child processes (none is
 *  allowed), a memory ceiling, and the hook that keeps sharp's addon out. */
export function converterArgs(c: { script: string; sandbox: string; reads: string[] }, input: string, out: string, ktx2: boolean): string[] {
  return [
    '--permission',
    ...c.reads.map((r) => `--allow-fs-read=${r}`),
    `--allow-fs-read=${input}`,
    `--allow-fs-write=${out}`,
    '--max-old-space-size=3072',
    '--import',
    c.sandbox,
    c.script,
    input,
    out,
    ...(ktx2 ? [] : ['--no-ktx2']),
  ];
}

/** Whether `unshare -rn` gives a process its own empty network here (Linux user namespaces). */
function networkNamespace(): boolean {
  try {
    return spawnSync('unshare', ['-rn', 'true'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export class Avatars {
  private readonly o: AvatarsOptions;
  private readonly key: Buffer;
  private queue: Promise<void> = Promise.resolve();
  private readonly isolated: boolean;
  private readonly converter: { script: string; sandbox: string; reads: string[] };
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
    o.log?.('avatar-converter', { sandbox: this.isolated ? 'files, addons and network' : 'files and addons (no network namespace on this system)' });
  }

  /** An upload slot: checked against the account's trust, its avatars and the size limit. */
  async slot(account: { id: string; trust: number; tester: boolean; status: string }, req: { name: string; bytes: number; sha256: string }, now: Date): Promise<{ id: string; url: string; method: 'PUT'; expires: Date }> {
    if (account.status !== 'active') throw new AvatarProblem('upload-trust', 'this account cannot upload');
    if (account.trust < 1 && !account.tester) throw new AvatarProblem('upload-trust', 'uploading needs trust level 1: an account a few days old with a verified email');
    if (!Number.isInteger(req.bytes) || req.bytes < 20 || !HASH.test(req.sha256)) throw new AvatarProblem('bad-request', 'the size and the SHA-256 of the file');
    if (req.bytes > AVATAR_SOURCE_LIMIT) throw new AvatarProblem('too-large', `an avatar file is ${AVATAR_SOURCE_LIMIT / 1048576} MB at most`);
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from avatars where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_AVATARS) throw new AvatarProblem('upload-limit', `${MAX_AVATARS} avatars at most: delete one first`);
    const name = cleanName(req.name);
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
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AvatarProblem('not-found', 'no such upload');
    const check = checkSignature(this.key, `/api/v1/avatars/${id}/source`, query.e, query.s, now);
    if (check !== 'ok') throw new AvatarProblem(check === 'expired' ? 'slot-expired' : 'not-found', check === 'expired' ? 'the upload slot expired: ask for a new one' : 'no such upload');
    const [row] = await this.o.db.query<{ source_sha256: string; source_bytes: number }>("select source_sha256, source_bytes from avatars where id = $1 and status = 'uploading'", [id]);
    if (!row) throw new AvatarProblem('not-found', 'no such upload');
    if (bytes.length !== row.source_bytes || sha256(bytes) !== row.source_sha256) throw new AvatarProblem('mismatch', 'the file is not the one the slot was asked for');
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
    const dir = mkdtempSync(join(tmpdir(), 'fcavatar-'));
    const input = join(dir, 'upload');
    const out = join(dir, 'out');
    const started = Date.now();
    try {
      writeFileSync(input, this.o.store.read(source)!);
      mkdirSync(out);
      const args = converterArgs(this.converter, input, out, this.o.ktx2 !== false);
      const [cmd, argv] = this.isolated ? ['unshare', ['-rn', '--', process.execPath, ...args]] : [process.execPath, args];
      const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        const timer = setTimeout(() => child.kill('SIGKILL'), CONVERT_MS);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, stderr: err });
        });
      });
      let result: { ok: boolean; id?: string; manifest?: unknown; problems?: string[] } | undefined;
      try {
        result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) as typeof result;
      } catch {
        result = undefined;
      }
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
        await this.o.db.query("update avatars set status = 'ready', manifest_sha256 = $2, rank = $3, converted_at = $4, name = case when name = '' then $5 else name end where id = $1", [id, manifestHash, manifest.rank, new Date(), cleanName(manifest.name)]);
        this.o.log?.('avatar-ready', { rank: manifest.rank, ms: Date.now() - started });
      } else if (result && !result.ok) {
        await this.o.db.query("update avatars set status = 'refused', problems = $2, converted_at = $3 where id = $1", [id, (result.problems ?? []).join('\n').slice(0, 4000), new Date()]);
        this.o.log?.('avatar-refused', { problems: (result.problems ?? []).length, ms: Date.now() - started });
      } else {
        throw new Error(code === null ? 'the converter ran out of time' : `the converter stopped (${code}): ${stderr.split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? ''}`);
      }
    } catch (err) {
      await this.o.db.query("update avatars set status = 'failed', problems = $2, converted_at = $3 where id = $1", [id, err instanceof Error ? err.message.slice(0, 500) : 'failed', new Date()]);
      this.o.log?.('avatar-failed', { why: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(db: Sql, accountId: string): Promise<AvatarRow[]> {
    const rows = await db.query<{ id: string; name: string; status: AvatarRow['status']; rank: string | null; problems: string; manifest_sha256: string | null; created_at: Date; wearing: boolean }>(
      'select v.id, v.name, v.status, v.rank, v.problems, v.manifest_sha256, v.created_at, a.avatar_id = v.id as wearing from avatars v join accounts a on a.id = v.owner_id where v.owner_id = $1 and v.deleted_at is null order by v.created_at desc limit 100',
      [accountId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, rank: r.rank, problems: r.problems ? r.problems.split('\n') : [], manifest: r.manifest_sha256, createdAt: r.created_at, wearing: r.wearing === true }));
  }

  /** Wears one of the account's ready avatars (or none). */
  async wear(db: Sql, accountId: string, avatarId: string | null): Promise<void> {
    if (avatarId !== null) {
      if (!/^[0-9a-f-]{36}$/i.test(avatarId)) throw new AvatarProblem('not-found', 'no such avatar');
      const [r] = await db.query<{ status: string }>('select status from avatars where id = $1 and owner_id = $2 and deleted_at is null', [avatarId, accountId]);
      if (!r) throw new AvatarProblem('not-found', 'no such avatar');
      if (r.status !== 'ready') throw new AvatarProblem('not-ready', 'that avatar is not ready');
    }
    await db.query('update accounts set avatar_id = $2 where id = $1', [accountId, avatarId]);
  }

  async remove(db: Sql, accountId: string, avatarId: string, now: Date): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(avatarId)) return false;
    const done = await db.query('update avatars set deleted_at = $3 where id = $1 and owner_id = $2 and deleted_at is null returning id', [avatarId, accountId, now]);
    if (done.length === 0) return false;
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
  async delivery(db: Sql, manifestHash: string, now: Date): Promise<{ manifest: AvatarManifest; links: Record<string, string> } | undefined> {
    if (!HASH.test(manifestHash)) return undefined;
    const [r] = await db.query("select 1 from avatars where manifest_sha256 = $1 and status = 'ready' and deleted_at is null limit 1", [manifestHash]);
    const bytes = r ? this.o.store.read(manifestHash) : undefined;
    if (!bytes) return undefined;
    const manifest = checkManifest(JSON.parse(new TextDecoder().decode(bytes)));
    const links: Record<string, string> = { manifest: this.o.store.link(manifestHash, now) };
    for (const l of LEVELS) links[l] = this.o.store.link(manifest.levels[l].file, now);
    if (manifest.thumbnail) links['thumbnail'] = this.o.store.link(manifest.thumbnail, now);
    return { manifest, links };
  }
}

function cleanName(name: unknown): string {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, NAME_MAX);
}
