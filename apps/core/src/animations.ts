// SPDX-License-Identifier: AGPL-3.0-or-later
// Emotes and dances in the core (S5.07). An animation upload goes the way an avatar's does: an
// account at trust level 1 or more (or a tester) asks for a slot with the file's size, SHA-256 and
// use (an emote or a dance), sends the file to the slot's signed link, and the core converts it in
// a separate, sandboxed process (tools/converter/src/animation-cli.ts; see sandbox.ts) into one
// VRMA. An FBX is first read by headless Blender (tools/blender/animation/fbx2glb.py) in a process
// of its own: no network, an address-space cap, a clean environment, a time limit; a core without
// Blender (FLATCHAT_CORE_BLENDER unset) refuses FBX with that reason. Anyone signed in may fetch a
// ready animation's VRMA through a signed link (they see it played in the world anyway); the
// source is never handed out. A sound may go with it (S5.07): asked for with the animation, sent to
// a slot of its own; the conversion starts once both have arrived, and Rhubarb Lip Sync (in a
// sandbox of its own, FLATCHAT_CORE_RHUBARB) makes its mouth track; a core without Rhubarb keeps
// the sound and says the mouth does not follow it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANIMATION_AUDIO_LIMIT, ANIMATION_SOURCE_LIMIT, ANIMATION_USES, type AnimationManifest, type AnimationUse, checkAnimationManifest } from '@flatchat/content';
import type { Db, Sql } from './db.ts';
import { cleanName, ContentProblem, converterArgs, converterFailure, type ConverterProgram, networkNamespace, runBlender, runConverter, runRhubarb } from './sandbox.ts';
import { checkSignature, type FileStore, HASH, linkKey, sha256, signPath } from './store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MAX_ANIMATIONS = 100;
export const SLOT_MS = 15 * 60_000;
export const CONVERT_MS = 5 * 60_000;
export const BLENDER_MS = 2 * 60_000;
export const RHUBARB_MS = 2 * 60_000;
export const NAME_MAX = 64;

export interface AnimationRow {
  id: string;
  name: string;
  use: AnimationUse;
  status: 'uploading' | 'converting' | 'ready' | 'refused' | 'failed';
  source: string;
  /** It has a sound, and the sound moves the mouth. */
  sound: boolean;
  mouth: boolean;
  duration: number | null;
  loop: boolean;
  problems: string[];
  warnings: string[];
  manifest: string | null;
  createdAt: Date;
}

export interface AnimationsOptions {
  db: Db;
  store: FileStore;
  secret: Uint8Array;
  publicUrl: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The converter program (default: the repository's tools/converter). */
  converter?: ConverterProgram;
  /** Headless Blender for FBX (its executable); without it FBX is refused. */
  blender?: string;
  /** Rhubarb Lip Sync for a sound's mouth track (its executable); without it a sound plays with no mouth. */
  rhubarb?: string;
}

/** What the first bytes say the file is (the converter decides for good). */
function isFbx(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 32));
  return head.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX/.test(head);
}

export class Animations {
  private readonly o: AnimationsOptions;
  private readonly key: Buffer;
  private queue: Promise<void> = Promise.resolve();
  private readonly isolated: boolean;
  private readonly converter: ConverterProgram;
  /** Conversions waiting or running, for tests and a clean shutdown. */
  pending = 0;

  constructor(o: AnimationsOptions) {
    this.o = o;
    this.key = linkKey(o.secret);
    this.isolated = networkNamespace();
    this.converter = o.converter ?? {
      script: join(ROOT, 'tools', 'converter', 'src', 'animation-cli.ts'),
      sandbox: join(ROOT, 'tools', 'converter', 'src', 'sandbox.ts'),
      reads: [join(ROOT, 'node_modules'), join(ROOT, 'tools', 'converter'), join(ROOT, 'packages')],
    };
    o.log?.('animation-converter', { fbx: o.blender ? 'headless Blender' : 'refused (no FLATCHAT_CORE_BLENDER)', mouth: o.rhubarb ? 'Rhubarb Lip Sync' : 'none (no FLATCHAT_CORE_RHUBARB)' });
  }

  /** An upload slot: checked against the account's trust, its animations and the size limit. */
  async slot(account: { id: string; trust: number; tester: boolean; status: string }, req: { name: string; bytes: number; sha256: string; use: unknown; audio?: { bytes: number; sha256: string } | undefined }, now: Date): Promise<{ id: string; url: string; method: 'PUT'; expires: Date; audio?: string }> {
    if (account.status !== 'active') throw new ContentProblem('upload-trust', 'this account cannot upload');
    if (account.trust < 1 && !account.tester) throw new ContentProblem('upload-trust', 'uploading needs trust level 1: an account a few days old with a verified email');
    if (!Number.isInteger(req.bytes) || req.bytes < 20 || !HASH.test(req.sha256)) throw new ContentProblem('bad-request', 'the size and the SHA-256 of the file');
    if (!(ANIMATION_USES as readonly unknown[]).includes(req.use)) throw new ContentProblem('bad-request', `use: ${ANIMATION_USES.join(' or ')}`);
    if (req.bytes > ANIMATION_SOURCE_LIMIT) throw new ContentProblem('too-large', `an animation file is ${ANIMATION_SOURCE_LIMIT / 1048576} MB at most`);
    if (req.audio && (!Number.isInteger(req.audio.bytes) || req.audio.bytes < 20 || !HASH.test(req.audio.sha256))) throw new ContentProblem('bad-request', 'the sound\'s size and SHA-256');
    if (req.audio && req.audio.bytes > ANIMATION_AUDIO_LIMIT) throw new ContentProblem('too-large', `a sound is ${ANIMATION_AUDIO_LIMIT / 1048576} MB at most`);
    const [n] = await this.o.db.query<{ n: string }>('select count(*) as n from animations where owner_id = $1 and deleted_at is null', [account.id]);
    if (Number(n?.n ?? 0) >= MAX_ANIMATIONS) throw new ContentProblem('upload-limit', `${MAX_ANIMATIONS} animations at most: delete one first`);
    const [row] = await this.o.db.query<{ id: string }>(
      "insert into animations (owner_id, name, use, status, source_sha256, source_bytes, audio_sha256, audio_bytes, created_at) values ($1, $2, $3, 'uploading', $4, $5, $6, $7, $8) returning id",
      [account.id, cleanName(req.name, NAME_MAX), req.use, req.sha256, req.bytes, req.audio?.sha256 ?? null, req.audio?.bytes ?? null, now],
    );
    const expires = Math.floor((now.getTime() + SLOT_MS) / 1000);
    const link = (part: 'source' | 'audio'): string => {
      const path = `/api/v1/animations/${row!.id}/${part}`;
      return `${this.o.publicUrl}${path}?e=${expires}&s=${signPath(this.key, path, expires)}`;
    };
    return { id: row!.id, url: link('source'), method: 'PUT', expires: new Date(expires * 1000), ...(req.audio ? { audio: link('audio') } : {}) };
  }

  /** A file sent to a slot (the animation, or its sound): it must be what the slot was asked for.
   *  Once every part is in, the conversion starts. */
  async receive(id: string, query: { e: string; s: string }, bytes: Uint8Array, now: Date, part: 'source' | 'audio' = 'source'): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ContentProblem('not-found', 'no such upload');
    const check = checkSignature(this.key, `/api/v1/animations/${id}/${part}`, query.e, query.s, now);
    if (check !== 'ok') throw new ContentProblem(check === 'expired' ? 'slot-expired' : 'not-found', check === 'expired' ? 'the upload slot expired: ask for a new one' : 'no such upload');
    const [row] = await this.o.db.query<{ source_sha256: string; source_bytes: number; audio_sha256: string | null; audio_bytes: number | null }>(
      "select source_sha256, source_bytes, audio_sha256, audio_bytes from animations where id = $1 and status = 'uploading'",
      [id],
    );
    if (!row || (part === 'audio' && !row.audio_sha256)) throw new ContentProblem('not-found', 'no such upload');
    const [want, size] = part === 'source' ? [row.source_sha256, row.source_bytes] : [row.audio_sha256!, row.audio_bytes!];
    if (bytes.length !== size || sha256(bytes) !== want) throw new ContentProblem('mismatch', 'the file is not the one the slot was asked for');
    this.o.store.put(bytes);
    await this.o.db.query(part === 'source' ? 'update animations set source_received = true where id = $1' : 'update animations set audio_received = true where id = $1', [id]);
    const [ready] = await this.o.db.query<{ source_sha256: string; source_bytes: number; use: AnimationUse; audio_sha256: string | null }>(
      "update animations set status = 'converting' where id = $1 and status = 'uploading' and source_received and (audio_sha256 is null or audio_received) returning source_sha256, source_bytes, use, audio_sha256",
      [id],
    );
    if (!ready) return;
    this.pending += 1;
    this.queue = this.queue.then(() => this.convert(id, ready.source_sha256, ready.source_bytes, ready.use, ready.audio_sha256)).finally(() => (this.pending -= 1));
  }

  /** Waits for every conversion asked for so far (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  private async refuse(id: string, problems: string[], started: number): Promise<void> {
    await this.o.db.query("update animations set status = 'refused', problems = $2, converted_at = $3 where id = $1", [id, problems.join('\n').slice(0, 4000), new Date()]);
    this.o.log?.('animation-refused', { problems: problems.length, ms: Date.now() - started });
  }

  private async convert(id: string, source: string, bytes: number, use: AnimationUse, audio: string | null): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'fcanim-'));
    const out = join(dir, 'out');
    const started = Date.now();
    try {
      const upload = this.o.store.read(source)!;
      let input = join(dir, 'upload');
      writeFileSync(input, upload);
      mkdirSync(out);
      const more: string[] = ['--use', use];
      const reads: string[] = [];
      // Its sound, and the sound's mouth track from Rhubarb where the core has it.
      if (audio) {
        const heard = this.o.store.read(audio)!;
        // Rhubarb knows a sound by its name's extension.
        const sound = join(dir, new TextDecoder('latin1').decode(heard.subarray(0, 4)) === 'OggS' ? 'sound.ogg' : 'sound.wav');
        writeFileSync(sound, heard);
        more.push('--audio', sound);
        reads.push(sound);
        if (this.o.rhubarb) {
          const cues = join(dir, 'cues.json');
          const run = await runRhubarb(this.o.rhubarb, sound, cues, { isolated: this.isolated, timeoutMs: RHUBARB_MS, home: dir });
          if (run.code === 0) {
            more.push('--cues', cues);
            reads.push(cues);
          } else this.o.log?.('animation-mouth-failed', { why: run.code === null ? 'out of time' : run.stderr.split('\n').filter(Boolean).at(-1)?.slice(0, 160) ?? '' });
        }
      }
      if (isFbx(upload)) {
        if (!this.o.blender) {
          await this.refuse(id, ['FBX needs headless Blender on the core, which this one does not have: export a GLB or a BVH instead'], started);
          return;
        }
        const glb = join(dir, 'from-fbx.glb');
        const run = await runBlender(this.o.blender, join(ROOT, 'tools', 'blender', 'animation', 'fbx2glb.py'), [join(dir, 'upload'), glb], { isolated: this.isolated, timeoutMs: BLENDER_MS, home: dir });
        if (run.code !== 0) {
          await this.refuse(id, [run.code === null ? 'Blender ran out of time reading the FBX' : run.stderr.split('\n').find((l) => l.startsWith('fbx2glb:'))?.replace(/^fbx2glb: /, '') ?? 'Blender could not read the FBX'], started);
          return;
        }
        input = glb;
        more.push('--from', 'fbx', '--source', `${source}:${bytes}`);
      }
      // KTX2 is the converters' default flag pair; an animation has no textures, so none is passed.
      const run = await runConverter(converterArgs(this.converter, input, out, true, { args: more, reads }), out, { isolated: this.isolated, timeoutMs: CONVERT_MS });
      const { code, result } = run;
      if (result?.ok && code === 0) {
        const manifest = checkAnimationManifest(result.manifest);
        const names = new Set([manifest.file, ...(manifest.audio ? [manifest.audio.file] : [])]);
        for (const name of readdirSync(out)) {
          if (!HASH.test(name)) continue;
          const file = new Uint8Array(readFileSync(join(out, name)));
          if (!names.has(name) || sha256(file) !== name) throw new Error(`the converter wrote an unexpected file ${name.slice(0, 12)}`);
          this.o.store.put(file);
        }
        for (const name of names) if (!this.o.store.has(name)) throw new Error('the converter left out a file');
        const manifestHash = this.o.store.put(readFileSync(join(out, 'manifest.json')));
        if (manifestHash !== result.id) throw new Error('the manifest is not the one the converter named');
        await this.o.db.query(
          "update animations set status = 'ready', manifest_sha256 = $2, source_format = $3, duration = $4, loop = $5, warnings = $6, converted_at = $7 where id = $1",
          [id, manifestHash, manifest.source.format, manifest.duration, manifest.loop, manifest.warnings.join('\n').slice(0, 4000), new Date()],
        );
        this.o.log?.('animation-ready', { format: manifest.source.format, seconds: manifest.duration, ms: Date.now() - started });
      } else if (result && !result.ok) {
        await this.refuse(id, result.problems ?? [], started);
      } else {
        throw new Error(converterFailure(run));
      }
    } catch (err) {
      await this.o.db.query("update animations set status = 'failed', problems = $2, converted_at = $3 where id = $1", [id, err instanceof Error ? err.message.slice(0, 500) : 'failed', new Date()]);
      this.o.log?.('animation-failed', { why: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async list(db: Sql, accountId: string): Promise<AnimationRow[]> {
    const rows = await db.query<{ id: string; name: string; use: AnimationUse; status: AnimationRow['status']; source_format: string | null; duration: number | null; loop: boolean | null; problems: string; warnings: string; manifest_sha256: string | null; created_at: Date; audio_sha256: string | null }>(
      'select id, name, use, status, source_format, duration, loop, problems, warnings, manifest_sha256, created_at, audio_sha256 from animations where owner_id = $1 and deleted_at is null order by created_at desc limit 200',
      [accountId],
    );
    const lines = (t: string): string[] => (t ? t.split('\n') : []);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      use: r.use,
      status: r.status,
      source: r.source_format ?? '',
      sound: r.audio_sha256 !== null,
      mouth: r.status === 'ready' && r.audio_sha256 !== null && !lines(r.warnings).some((w) => w.startsWith('no mouth track')),
      duration: r.duration === null ? null : Number(r.duration),
      loop: r.loop === true,
      problems: lines(r.problems),
      warnings: lines(r.warnings),
      manifest: r.manifest_sha256,
      createdAt: r.created_at,
    }));
  }

  async remove(db: Sql, accountId: string, id: string, now: Date): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    return (await db.query('update animations set deleted_at = $3 where id = $1 and owner_id = $2 and deleted_at is null returning id', [id, accountId, now])).length > 0;
  }

  /** A ready animation's manifest and a signed link to its VRMA, for any signed-in account. */
  async delivery(db: Sql, manifestHash: string, now: Date): Promise<{ manifest: AnimationManifest; links: Record<string, string> } | undefined> {
    if (!HASH.test(manifestHash)) return undefined;
    const [r] = await db.query("select 1 from animations where manifest_sha256 = $1 and status = 'ready' and deleted_at is null limit 1", [manifestHash]);
    const bytes = r ? this.o.store.read(manifestHash) : undefined;
    if (!bytes) return undefined;
    const manifest = checkAnimationManifest(JSON.parse(new TextDecoder().decode(bytes)));
    return { manifest, links: { manifest: this.o.store.link(manifestHash, now), vrma: this.o.store.link(manifest.file, now), ...(manifest.audio ? { audio: this.o.store.link(manifest.audio.file, now) } : {}) } };
  }
}
