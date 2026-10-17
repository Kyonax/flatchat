// SPDX-License-Identifier: MPL-2.0
// The client's cache of world content (S2.04): files named by their SHA-256 in the app's data
// folder, so a file shared by two worlds, or a world visited again, downloads once. Every file is
// checked against its name before it is kept; the cache keeps at most 2 GB, dropping the files
// used longest ago. Electron-free, so the tests run in plain Node.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HASH = /^[0-9a-f]{64}$/;

export class ContentCache {
  private readonly dir: string;
  private readonly limit: number;

  constructor(dir: string, limitBytes = 2 * 1024 * 1024 * 1024) {
    this.dir = dir;
    this.limit = limitBytes;
    mkdirSync(dir, { recursive: true });
  }

  /** The hashes among `hashes` that are in the cache. */
  has(hashes: readonly unknown[]): string[] {
    return hashes.filter((h): h is string => typeof h === 'string' && HASH.test(h)).filter((h) => {
      try {
        return statSync(join(this.dir, h)).isFile();
      } catch {
        return false;
      }
    });
  }

  get(hash: unknown): Uint8Array | undefined {
    if (typeof hash !== 'string' || !HASH.test(hash)) return undefined;
    try {
      const path = join(this.dir, hash);
      const bytes = new Uint8Array(readFileSync(path));
      const now = new Date();
      utimesSync(path, now, now);
      return bytes;
    } catch {
      return undefined;
    }
  }

  /** Keeps a file if its bytes have that hash; false otherwise. */
  put(hash: unknown, bytes: unknown): boolean {
    if (typeof hash !== 'string' || !HASH.test(hash) || !(bytes instanceof Uint8Array) || bytes.length > 256 * 1024 * 1024) return false;
    if (createHash('sha256').update(bytes).digest('hex') !== hash) return false;
    const path = join(this.dir, hash);
    writeFileSync(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
    this.trim();
    return true;
  }

  /** Drops the least recently used files until the cache fits its limit. */
  trim(): void {
    const files = readdirSync(this.dir)
      .filter((f) => HASH.test(f))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { f, size: st.size, used: st.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) {
      if (total <= this.limit) break;
      rmSync(join(this.dir, x.f), { force: true });
      total -= x.size;
    }
  }
}
