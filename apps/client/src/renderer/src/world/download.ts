// SPDX-License-Identifier: MPL-2.0
// Downloading a world over its connection (S2.04, protocol version 2). The world server names its
// built world by the SHA-256 of world.json; the client takes from its cache what it has, fetches
// the rest one file at a time, puts the chunks together in order, checks each file's hash before it
// is used or kept, and reads world.json as untrusted data (packages/content). Pure: the connection,
// the cache and the hash function are handed in, so tests run it in plain Node.
import { type BuiltWorld, parseBuiltWorld } from '@flatchat/content';
import { fromHex, type Message, toHex } from '@flatchat/protocol';

export interface ContentCache {
  has(hashes: string[]): Promise<string[]>;
  get(hash: string): Promise<Uint8Array | undefined>;
  put(hash: string, bytes: Uint8Array): Promise<boolean>;
}

export interface Progress {
  /** Bytes in hand and bytes in all, counting what the cache had. */
  done: number;
  total: number;
}

export class DownloadError extends Error {}

const MAX_FILE = 256 * 1024 * 1024;
const STALL_MS = 30_000;

interface Pending {
  hash: string;
  buffer: Uint8Array | undefined;
  next: number;
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

export class Downloader {
  private readonly send: (m: Message) => void;
  private readonly cache: ContentCache;
  private readonly onProgress: (p: Progress) => void;
  private readonly pending = new Map<string, Pending>();
  private progress: Progress = { done: 0, total: 0 };

  constructor(send: (m: Message) => void, cache: ContentCache, onProgress: (p: Progress) => void = () => undefined) {
    this.send = send;
    this.cache = cache;
    this.onProgress = onProgress;
  }

  /** Feed every message from the world; true when it was a download's. */
  message(m: Message): boolean {
    if (m.type === 'chunk') {
      this.chunk(toHex(m.hash), m.offset, m.total, m.data);
      return true;
    }
    if (m.type === 'notFound') {
      const p = this.pending.get(toHex(m.hash));
      if (p) this.fail(p, new DownloadError('the world does not have a file it listed'));
      return true;
    }
    return false;
  }

  /** The built world named by `hash`, with every file it needs. */
  async world(hash: string, size: number): Promise<{ world: BuiltWorld; files: Map<string, Uint8Array> }> {
    this.progress = { done: 0, total: size };
    const json = await this.file(hash);
    let parsed: ReturnType<typeof parseBuiltWorld>;
    try {
      parsed = parseBuiltWorld(JSON.parse(new TextDecoder().decode(json)));
    } catch {
      throw new DownloadError('world.json is not JSON');
    }
    if ('error' in parsed) throw new DownloadError(`world.json: ${parsed.error}`);
    const world = parsed.world;
    const wanted = new Set<string>([world.collision, ...world.scenes.map((s) => s.glb), ...(world.navmesh ? [world.navmesh] : []), ...world.scenes.flatMap((s) => s.emitters.map((e) => e.audio)), ...world.scenes.flatMap((s) => s.effects.map((e) => e.file))]);
    const sizes = new Map(world.files.map((f) => [f.hash, f.size]));
    this.progress = { done: size, total: size + [...wanted].reduce((n, h) => n + (sizes.get(h) ?? 0), 0) };
    this.onProgress(this.progress);
    const files = new Map<string, Uint8Array>();
    for (const h of wanted) files.set(h, await this.file(h));
    return { world, files };
  }

  /** One file: from the cache, or fetched, checked and kept. */
  async file(hash: string): Promise<Uint8Array> {
    if ((await this.cache.has([hash])).includes(hash)) {
      const cached = await this.cache.get(hash);
      if (cached && (await sha256Hex(cached)) === hash) {
        this.advance(cached.length);
        return cached;
      }
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const p: Pending = { hash, buffer: undefined, next: 0, resolve, reject, timer: undefined };
      this.pending.set(hash, p);
      this.arm(p);
      this.send({ type: 'fetch', hash: fromHex(hash), from: 0 });
    });
    if ((await sha256Hex(bytes)) !== hash) throw new DownloadError('a file did not match its hash');
    await this.cache.put(hash, bytes);
    return bytes;
  }

  /** Stops every download (the player left the world). */
  cancel(): void {
    for (const p of [...this.pending.values()]) {
      this.send({ type: 'unfetch', hash: fromHex(p.hash) });
      this.fail(p, new DownloadError('cancelled'));
    }
  }

  private arm(p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.fail(p, new DownloadError('the world stopped sending')), STALL_MS);
  }

  private fail(p: Pending, e: Error): void {
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(p.hash);
    p.reject(e);
  }

  private advance(bytes: number): void {
    this.progress = { done: this.progress.done + bytes, total: Math.max(this.progress.total, this.progress.done + bytes) };
    this.onProgress(this.progress);
  }

  private chunk(hash: string, offset: number, total: number, data: Uint8Array): void {
    const p = this.pending.get(hash);
    if (!p) return;
    if (total > MAX_FILE) return this.fail(p, new DownloadError('a file over 256 MB'));
    p.buffer ??= new Uint8Array(total);
    if (p.buffer.length !== total || offset !== p.next || offset + data.length > total) return this.fail(p, new DownloadError('chunks out of order'));
    p.buffer.set(data, offset);
    p.next += data.length;
    this.arm(p);
    this.advance(data.length);
    if (p.next === total) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(hash);
      p.resolve(p.buffer);
    }
  }
}
