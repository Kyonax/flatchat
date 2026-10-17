// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's content-addressed file store (S4.04, DR-06, DR-16): every file named by its SHA-256,
// written once, never changed; avatars' levels, thumbnails and manifests, and the uploads they came
// from (which are never handed out). Clients fetch files through signed links that expire, and
// cache them by hash (a hit needs no check: the name is the content's).
//
// This is the local store: files on the core's disk, served by the core itself, for tests, a LAN
// and the closed test. Behind the Cloudflare Tunnel large files must not cross it (DR-16): the R2
// store (Cloudflare's free object storage, the same interface with presigned links) takes over
// there once the owner has made its bucket.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HASH = /^[0-9a-f]{64}$/;
export const LINK_MS = 60 * 60_000;

export interface FileStore {
  readonly kind: 'local';
  put(bytes: Uint8Array): string;
  has(hash: string): boolean;
  read(hash: string): Uint8Array | undefined;
  size(hash: string): number | undefined;
  /** A link anyone holding it may fetch the file with until it expires. */
  link(hash: string, now: Date, ms?: number): string;
  /** Whether a link's query (`e`, `s`) is genuine and still valid for this file. */
  verify(hash: string, expires: string, signature: string, now: Date): 'ok' | 'expired' | 'forged';
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The key that signs file links, derived from the core's secret (never the secret itself). */
export function linkKey(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'flatchat core: file links v1', 32));
}

/** A signature over a path and an expiry: what file links and upload slots carry. */
export function signPath(key: Buffer, path: string, expires: number): string {
  return createHmac('sha256', key).update(`${path}\n${expires}`).digest('base64url');
}

export function checkSignature(key: Buffer, path: string, expires: string, signature: string, now: Date): 'ok' | 'expired' | 'forged' {
  if (!/^\d{1,12}$/.test(expires) || signature.length > 64) return 'forged';
  const want = Buffer.from(signPath(key, path, Number(expires)));
  const given = Buffer.from(signature);
  if (want.length !== given.length || !timingSafeEqual(want, given)) return 'forged';
  return Number(expires) * 1000 < now.getTime() ? 'expired' : 'ok';
}

export function localStore(dir: string, secret: Uint8Array, publicUrl: string): FileStore {
  mkdirSync(dir, { recursive: true });
  const key = linkKey(secret);
  const pathOf = (hash: string): string => join(dir, hash.slice(0, 2), hash);
  return {
    kind: 'local',
    put(bytes) {
      const hash = sha256(bytes);
      const path = pathOf(hash);
      if (!existsSync(path)) {
        mkdirSync(join(dir, hash.slice(0, 2)), { recursive: true });
        // Written beside, then renamed: a reader never sees half a file.
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, bytes, { mode: 0o600 });
        renameSync(tmp, path);
      }
      return hash;
    },
    has: (hash) => HASH.test(hash) && existsSync(pathOf(hash)),
    read: (hash) => (HASH.test(hash) && existsSync(pathOf(hash)) ? new Uint8Array(readFileSync(pathOf(hash))) : undefined),
    size: (hash) => (HASH.test(hash) && existsSync(pathOf(hash)) ? statSync(pathOf(hash)).size : undefined),
    link(hash, now, ms = LINK_MS) {
      const expires = Math.floor((now.getTime() + ms) / 1000);
      return `${publicUrl}/api/v1/files/${hash}?e=${expires}&s=${signPath(key, `/api/v1/files/${hash}`, expires)}`;
    },
    verify: (hash, expires, signature, now) => (HASH.test(hash) ? checkSignature(key, `/api/v1/files/${hash}`, expires, signature, now) : 'forged'),
  };
}
