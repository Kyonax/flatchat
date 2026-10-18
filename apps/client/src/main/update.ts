// SPDX-License-Identifier: MPL-2.0
// The self-update (S7.01). A few seconds after a packaged client starts, it fetches the feed and its
// signature from kyonax.com (update-key.ts), checks the signature against the owner's Ed25519 key
// built into it, reads the feed, and when it names a later version with a package for this platform,
// downloads it, checking its size as it comes and its SHA-256 at the end. Nothing in the feed is
// trusted before the signature checks, and nothing downloaded is kept unless its hash matches. The
// player then chooses when to restart: an AppImage replaces itself, the Windows installer runs
// silently and starts FlatChat again, and anything else (the .tar.gz, the portable zip, a folder)
// says where the new version is. No key built in: no updates.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, win32 } from 'node:path';
import { isNewer, readUpdateManifest, UPDATE_FEED_FILE, UPDATE_FEED_LIMIT, UPDATE_SIGNATURE_FILE, updatePlatform, type UpdatePackage } from '../shared/update';

/** The DER prefix of an Ed25519 public key (SPKI); the key's raw 32 bytes follow it. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Whether `feed` is signed by the key whose raw 32 bytes `publicKey` holds (base64). */
export function verifyFeed(feed: Uint8Array, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64');
    const sig = Buffer.from(signature.trim(), 'base64');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    return verify(null, feed, key, sig);
  } catch {
    return false;
  }
}

export type UpdateResult =
  | { status: 'current'; version: string }
  | { status: 'downloaded'; version: string; file: string }
  | { status: 'refused'; why: string }
  | { status: 'failed'; why: string };

class Refused extends Error {}

/** A response's body, refused past `limit` bytes. */
async function readLimited(r: Response, limit: number): Promise<Uint8Array> {
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Refused(`the feed is larger than ${limit} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Downloads a package to `file`, checking its size as it comes and its SHA-256 at the end. */
async function download(pkg: UpdatePackage, file: string, get: typeof fetch, timeoutMs: number): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const r = await get(pkg.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok || !r.body) throw new Error(`the package answered ${r.status}`);
  const hash = createHash('sha256');
  const out = await open(file, 'w');
  let size = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > pkg.bytes) {
        await reader.cancel();
        throw new Refused(`the package is larger than the feed says (${pkg.bytes} bytes)`);
      }
      hash.update(value);
      await out.write(value);
    }
  } catch (err) {
    await out.close();
    rmSync(file, { force: true });
    throw err;
  }
  await out.close();
  const sha256 = hash.digest('hex');
  if (size !== pkg.bytes || sha256 !== pkg.sha256) {
    rmSync(file, { force: true });
    throw new Refused(`the package is not the one the feed names (${size} bytes, SHA-256 ${sha256.slice(0, 12)}…)`);
  }
}

export interface UpdaterOptions {
  /** The feed's folder, ending in a slash. */
  feed: string;
  /** The owner's Ed25519 public key, its raw 32 bytes in base64. */
  publicKey: string;
  /** The running version. */
  version: string;
  platform: string;
  arch: string;
  /** Where packages are downloaded, each in a folder named by its version. */
  dir: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Looks for a later version and downloads its package for this platform. */
export async function checkForUpdate(o: UpdaterOptions): Promise<UpdateResult> {
  const get = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;
  try {
    const at = (name: string): string => new URL(name, o.feed).href;
    const [feedAnswer, sigAnswer] = await Promise.all([get(at(UPDATE_FEED_FILE), { signal: AbortSignal.timeout(timeoutMs) }), get(at(UPDATE_SIGNATURE_FILE), { signal: AbortSignal.timeout(timeoutMs) })]);
    if (!feedAnswer.ok || !sigAnswer.ok) return { status: 'failed', why: `the feed answered ${feedAnswer.status} and its signature ${sigAnswer.status}` };
    const feed = await readLimited(feedAnswer, UPDATE_FEED_LIMIT);
    const signature = new TextDecoder().decode(await readLimited(sigAnswer, 1024));
    if (!verifyFeed(feed, signature, o.publicKey)) return { status: 'refused', why: 'the feed is not signed with the key FlatChat trusts' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(feed));
    } catch {
      return { status: 'refused', why: 'the feed is not JSON' };
    }
    const read = readUpdateManifest(parsed);
    if ('problems' in read) return { status: 'refused', why: `the feed does not read: ${read.problems.join('; ')}` };
    const m = read.manifest;
    const platform = updatePlatform(o.platform, o.arch);
    const pkg = platform ? m.packages[platform] : undefined;
    if (!pkg || !isNewer(m.version, o.version)) return { status: 'current', version: o.version };
    const file = join(o.dir, m.version, basename(new URL(pkg.url).pathname) || 'flatchat-update');
    await download(pkg, file, get, timeoutMs * 40);
    return { status: 'downloaded', version: m.version, file };
  } catch (err) {
    if (err instanceof Refused) return { status: 'refused', why: err.message };
    return { status: 'failed', why: err instanceof Error ? err.message : String(err) };
  }
}

/** How a downloaded package goes in: an AppImage over the running one, the installer FlatChat came
 *  with, or by hand (a .tar.gz, the portable zip, a development folder). */
export type ApplyPlan = { how: 'appimage'; target: string } | { how: 'installer' } | { how: 'manual' };

export function applyPlan(platform: string, env: Readonly<Record<string, string | undefined>>, exePath: string, file: string): ApplyPlan {
  const appImage = env['APPIMAGE'];
  const local = env['LOCALAPPDATA'];
  if (platform === 'linux' && appImage && file.endsWith('.AppImage')) return { how: 'appimage', target: appImage };
  // The per-user installer puts FlatChat under %LOCALAPPDATA%\Programs; a zip can be anywhere else.
  if (platform === 'win32' && local && exePath.toLowerCase().startsWith(`${win32.join(local, 'Programs')}${win32.sep}`.toLowerCase()) && file.toLowerCase().endsWith('.exe')) return { how: 'installer' };
  return { how: 'manual' };
}

/** Writes the result of an --update-check run for the tests. */
export function writeUpdateReport(file: string | undefined, report: Record<string, unknown>): void {
  if (file) writeFileSync(file, `${JSON.stringify(report)}\n`);
}
