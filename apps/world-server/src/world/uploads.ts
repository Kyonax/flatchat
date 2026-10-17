// SPDX-License-Identifier: MPL-2.0
// New builds of a world from the people allowed to build it (S3.06, Q-M7, protocol version 5): a
// builder, an admin or the owner sends the build's files over the world connection (`put`, each
// piece acknowledged with `got`), then names its world.json (`publish`). The world stages the files
// beside its built folder (DIR.incoming), assembles the new build (DIR.next: the uploaded files and
// the ones it already holds), checks it exactly as it checks a build at start (loadBuiltWorld),
// puts it in place of the old one and restarts on it. One upload at a time; the world format's
// sizes (256 MB a file, 512 MB a build).
import { createHash, type Hash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseBuiltWorld } from '@flatchat/content';
import { toHex } from '@flatchat/protocol';
import { loadBuiltWorld } from './content.ts';

export const UPLOAD_LIMITS = { file: 256 * 1024 * 1024, build: 512 * 1024 * 1024, files: 4097 };

/** Why an upload stopped: the uploader reads it in `published`. */
export class UploadError extends Error {}

interface Staged {
  size: number;
  total: number;
  done: boolean;
  hash: Hash;
}

export class BuildUploads {
  /** The world's built folder, which a publish replaces. */
  readonly dir: string;
  private uploader: number | undefined;
  private readonly files = new Map<string, Staged>();
  private bytes = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  get incoming(): string {
    return `${this.dir}.incoming`;
  }

  /** Removes what an unfinished upload or a replaced build left beside the built folder. */
  tidy(): void {
    for (const d of [this.incoming, `${this.dir}.next`, `${this.dir}.old`]) rmSync(d, { recursive: true, force: true });
  }

  /** Who is uploading now, if anyone. */
  get busy(): number | undefined {
    return this.uploader;
  }

  /** Takes a piece of a file; answers how many bytes of it the world holds. */
  put(entity: number, hash: Uint8Array, offset: number, total: number, data: Uint8Array): number {
    if (this.uploader !== undefined && this.uploader !== entity) throw new UploadError('another build is uploading');
    if (this.uploader === undefined) {
      rmSync(this.incoming, { recursive: true, force: true });
      mkdirSync(this.incoming, { recursive: true });
      this.uploader = entity;
    }
    const hex = toHex(hash);
    let f = this.files.get(hex);
    if (!f) {
      if (this.files.size >= UPLOAD_LIMITS.files) throw new UploadError('a build of more files than a world may hold');
      if (total > UPLOAD_LIMITS.file) throw new UploadError(`a file over ${UPLOAD_LIMITS.file / 1024 / 1024} MB`);
      f = { size: 0, total, done: false, hash: createHash('sha256') };
      this.files.set(hex, f);
    }
    if (f.done) return f.size;
    if (total !== f.total || offset !== f.size || f.size + data.length > f.total) throw new UploadError(`${hex.slice(0, 12)}: a piece out of place`);
    if (this.bytes + data.length > UPLOAD_LIMITS.build) throw new UploadError(`a build over ${UPLOAD_LIMITS.build / 1024 / 1024} MB`);
    appendFileSync(join(this.incoming, hex), data);
    f.hash.update(data);
    f.size += data.length;
    this.bytes += data.length;
    if (f.size === f.total) {
      f.done = true;
      if (f.hash.digest('hex') !== hex) throw new UploadError(`${hex.slice(0, 12)} does not match its hash`);
    }
    return f.size;
  }

  /** Checks the uploaded build named by its world.json's hash and puts it in place of the built
   *  folder. Resolves with the new world's name; a build that does not check throws UploadError. */
  async publish(entity: number, world: Uint8Array): Promise<{ name: string; files: number }> {
    if (this.uploader !== entity) throw new UploadError('nothing was uploaded');
    const hex = toHex(world);
    if (!this.files.get(hex)?.done) throw new UploadError('its world.json was not uploaded');
    const next = `${this.dir}.next`;
    rmSync(next, { recursive: true, force: true });
    mkdirSync(join(next, 'content'), { recursive: true });
    copyFileSync(join(this.incoming, hex), join(next, 'world.json'));
    let parsed: ReturnType<typeof parseBuiltWorld>;
    try {
      parsed = parseBuiltWorld(JSON.parse(readFileSync(join(next, 'world.json'), 'utf8')));
    } catch {
      throw new UploadError('world.json is not JSON');
    }
    if ('error' in parsed) throw new UploadError(`world.json: ${parsed.error}`.slice(0, 160));
    for (const f of parsed.world.files) {
      const sent = this.files.get(f.hash)?.done ? join(this.incoming, f.hash) : undefined;
      const held = join(this.dir, 'content', f.hash);
      const from = sent ?? (existsSync(held) ? held : undefined);
      if (!from) throw new UploadError(`content/${f.hash.slice(0, 12)} was neither uploaded nor already here`);
      place(from, join(next, 'content', f.hash));
    }
    let loaded: Awaited<ReturnType<typeof loadBuiltWorld>>;
    try {
      loaded = await loadBuiltWorld(next);
    } catch (err) {
      throw new UploadError((err instanceof Error ? err.message : String(err)).slice(0, 160));
    }
    rmSync(`${this.dir}.old`, { recursive: true, force: true });
    if (existsSync(this.dir)) renameSync(this.dir, `${this.dir}.old`);
    renameSync(next, this.dir);
    this.forget(entity);
    return { name: loaded.world.manifest.name, files: loaded.files.size };
  }

  /** The uploader left or failed: what it sent is dropped. */
  forget(entity: number): void {
    if (this.uploader !== entity) return;
    rmSync(this.incoming, { recursive: true, force: true });
    this.uploader = undefined;
    this.files.clear();
    this.bytes = 0;
  }
}

/** A hard link when the folders share a disk, a copy otherwise. */
function place(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}
