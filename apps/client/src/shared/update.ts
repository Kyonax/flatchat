// SPDX-License-Identifier: MPL-2.0
// The self-update's feed (S7.01): one small JSON file beside the downloads on kyonax.com, signed with
// the owner's Ed25519 key (a detached signature in `flatchat-update.json.sig`), naming the newest
// version and, per platform, its package's address, SHA-256 and size. The client trusts nothing in it
// until the signature checks against the key built into it (main/update.ts). Pure: the format, its
// checks and the version order, shared by the main process, the tests and the release script.

export const UPDATE_FORMAT = 1;
export const UPDATE_FEED_FILE = 'flatchat-update.json';
export const UPDATE_SIGNATURE_FILE = 'flatchat-update.json.sig';
/** The feed and its signature are small; a package is never larger than this. */
export const UPDATE_FEED_LIMIT = 64 * 1024;
export const UPDATE_PACKAGE_LIMIT = 1024 * 1024 * 1024;
/** The packages a feed may name: the client's platforms and architectures. */
export const UPDATE_PLATFORMS = ['linux-x64', 'win32-x64'] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

export interface UpdatePackage {
  url: string;
  sha256: string;
  bytes: number;
}

export interface UpdateManifest {
  format: typeof UPDATE_FORMAT;
  version: string;
  /** The release's date, YYYY-MM-DD. */
  released: string;
  packages: Partial<Record<UpdatePlatform, UpdatePackage>>;
}

const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

/** A version's three numbers; undefined for anything else (no pre-releases, no build tags). */
export function versionParts(v: string): [number, number, number] | undefined {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `a` is a later version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** A package's address: https, or plain http on this machine (tests). */
export function packageUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
  } catch {
    return false;
  }
}

/** The feed read and checked, or every reason it is not one. */
export function readUpdateManifest(raw: unknown): { manifest: UpdateManifest } | { problems: string[] } {
  const problems: string[] = [];
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (m['format'] !== UPDATE_FORMAT) problems.push(`format is ${UPDATE_FORMAT}`);
  const version = typeof m['version'] === 'string' ? m['version'] : '';
  if (!versionParts(version)) problems.push('version is three numbers, like 1.2.3');
  const released = typeof m['released'] === 'string' ? m['released'] : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(released)) problems.push('released is a date, YYYY-MM-DD');
  const given = (typeof m['packages'] === 'object' && m['packages'] !== null ? m['packages'] : {}) as Record<string, unknown>;
  const packages: Partial<Record<UpdatePlatform, UpdatePackage>> = {};
  for (const [key, value] of Object.entries(given)) {
    if (!(UPDATE_PLATFORMS as readonly string[]).includes(key)) {
      problems.push(`packages.${key}: not a platform the client runs on`);
      continue;
    }
    const p = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const url = typeof p['url'] === 'string' ? p['url'] : '';
    const sha256 = typeof p['sha256'] === 'string' ? p['sha256'] : '';
    const bytes = typeof p['bytes'] === 'number' ? p['bytes'] : -1;
    if (!packageUrlOk(url)) problems.push(`packages.${key}.url is an https address`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) problems.push(`packages.${key}.sha256 is 64 hex digits`);
    if (!(Number.isInteger(bytes) && bytes > 0 && bytes <= UPDATE_PACKAGE_LIMIT)) problems.push(`packages.${key}.bytes is 1 to ${UPDATE_PACKAGE_LIMIT}`);
    packages[key as UpdatePlatform] = { url, sha256, bytes };
  }
  if (Object.keys(packages).length === 0 && problems.length === 0) problems.push('packages names no platform');
  return problems.length ? { problems } : { manifest: { format: UPDATE_FORMAT, version, released, packages } };
}

/** This computer's package name in a feed. */
export function updatePlatform(platform: string, arch: string): UpdatePlatform | undefined {
  const key = `${platform}-${arch}`;
  return (UPDATE_PLATFORMS as readonly string[]).includes(key) ? (key as UpdatePlatform) : undefined;
}
