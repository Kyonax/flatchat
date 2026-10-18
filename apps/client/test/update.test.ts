// SPDX-License-Identifier: MPL-2.0
// The self-update (S7.01), without a network: the feed's format and the version order; the owner's
// signature (good, the feed changed after signing, another key, garbage); a later version downloaded
// and checked, the same version left alone, a package that is not the one the feed names refused
// and deleted, one larger than it says cut off; and how a package goes in on each platform.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyPlan, checkForUpdate, verifyFeed } from '../src/main/update';
import { isNewer, readUpdateManifest, UPDATE_FEED_FILE, UPDATE_SIGNATURE_FILE, updatePlatform } from '../src/shared/update';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A throwaway signing key: the private key and the public key's raw 32 bytes in base64. */
function keyPair(): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(der.subarray(der.length - 32)).toString('base64') };
}

const PACKAGE = new Uint8Array(Array.from({ length: 50_000 }, (_, i) => (i * 7) % 251));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const feedOf = (over: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ format: 1, version: '9.1.0', released: '2026-10-18', packages: { 'linux-x64': { url: 'https://kyonax.com/flatchat/updates/FlatChat-9.1.0.AppImage', sha256: sha(PACKAGE), bytes: PACKAGE.length } }, ...over }));

/** A fetch that serves the feed, its signature and the package from memory. */
function server(files: Record<string, Uint8Array | string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const name = url.slice(url.lastIndexOf('/') + 1);
    const body = files[name];
    if (body === undefined) return new Response('not here', { status: 404 });
    return new Response(typeof body === 'string' ? body : body.slice());
  }) as typeof fetch;
}

const check = (get: typeof fetch, publicKey: string, version = '9.0.0'): ReturnType<typeof checkForUpdate> => {
  const dir = mkdtempSync(join(tmpdir(), 'flatchat-update-'));
  dirs.push(dir);
  return checkForUpdate({ feed: 'https://kyonax.com/flatchat/updates/', publicKey, version, platform: 'linux', arch: 'x64', dir, fetch: get });
};

describe('the feed', () => {
  it('reads a good feed, and every reason a bad one is not', () => {
    expect(readUpdateManifest(JSON.parse(new TextDecoder().decode(feedOf())))).toMatchObject({ manifest: { version: '9.1.0', packages: { 'linux-x64': { bytes: 50_000 } } } });
    const bad = readUpdateManifest({ format: 2, version: '9.1', released: 'today', packages: { 'darwin-arm64': {}, 'win32-x64': { url: 'http://evil.example/x.exe', sha256: 'abc', bytes: 0 } } });
    expect('problems' in bad && bad.problems).toEqual([
      'format is 1',
      'version is three numbers, like 1.2.3',
      'released is a date, YYYY-MM-DD',
      'packages.darwin-arm64: not a platform the client runs on',
      'packages.win32-x64.url is an https address',
      'packages.win32-x64.sha256 is 64 hex digits',
      'packages.win32-x64.bytes is 1 to 1073741824',
    ]);
  });

  it('orders versions by their numbers, and knows this computer\'s package', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.2', '1.2.3')).toBe(false);
    expect(isNewer('1.2.3-beta', '1.2.2')).toBe(false);
    expect(updatePlatform('linux', 'x64')).toBe('linux-x64');
    expect(updatePlatform('darwin', 'arm64')).toBeUndefined();
  });
});

describe('the owner\'s signature', () => {
  it('holds for the feed as signed, and for nothing else', () => {
    const { privateKey, publicKey } = keyPair();
    const feed = feedOf();
    const signature = sign(null, feed, privateKey).toString('base64');
    expect(verifyFeed(feed, signature, publicKey)).toBe(true);
    expect(verifyFeed(feedOf({ version: '9.2.0' }), signature, publicKey)).toBe(false);
    expect(verifyFeed(feed, signature, keyPair().publicKey)).toBe(false);
    expect(verifyFeed(feed, 'not a signature', publicKey)).toBe(false);
    expect(verifyFeed(feed, signature, '')).toBe(false);
  });
});

describe('an update', () => {
  const { privateKey, publicKey } = keyPair();
  const signed = (feed: Uint8Array): Record<string, Uint8Array | string> => ({ [UPDATE_FEED_FILE]: feed, [UPDATE_SIGNATURE_FILE]: sign(null, feed, privateKey).toString('base64') });

  it('is downloaded and checked when the feed names a later version', async () => {
    const r = await check(server({ ...signed(feedOf()), 'FlatChat-9.1.0.AppImage': PACKAGE }), publicKey);
    expect(r).toMatchObject({ status: 'downloaded', version: '9.1.0' });
    expect(new Uint8Array(readFileSync((r as { file: string }).file))).toEqual(PACKAGE);
  });

  it('is left alone when the version is not later, or the feed has no package for this computer', async () => {
    expect(await check(server({ ...signed(feedOf()), 'FlatChat-9.1.0.AppImage': PACKAGE }), publicKey, '9.1.0')).toEqual({ status: 'current', version: '9.1.0' });
    const windowsOnly = feedOf({ packages: { 'win32-x64': { url: 'https://kyonax.com/flatchat/updates/FlatChat-9.1.0-setup.exe', sha256: sha(PACKAGE), bytes: PACKAGE.length } } });
    expect((await check(server(signed(windowsOnly)), publicKey)).status).toBe('current');
  });

  it('is refused when the feed is not signed by the key built in, or changed after signing', async () => {
    expect(await check(server({ ...signed(feedOf()), 'FlatChat-9.1.0.AppImage': PACKAGE }), keyPair().publicKey)).toEqual({ status: 'refused', why: 'the feed is not signed with the key FlatChat trusts' });
    const tampered = { ...signed(feedOf()), [UPDATE_FEED_FILE]: feedOf({ version: '9.9.9' }) };
    expect((await check(server(tampered), publicKey)).status).toBe('refused');
  });

  it('is refused, and nothing kept, when the package is not the one the feed names', async () => {
    const other = PACKAGE.map((b) => b ^ 1);
    const r = await check(server({ ...signed(feedOf()), 'FlatChat-9.1.0.AppImage': other }), publicKey);
    expect(r.status).toBe('refused');
    expect((r as { why: string }).why).toMatch(/not the one the feed names/);
    const longer = new Uint8Array(PACKAGE.length + 10);
    expect((await check(server({ ...signed(feedOf()), 'FlatChat-9.1.0.AppImage': longer }), publicKey)).status).toBe('refused');
    expect(dirs.every((d) => !existsSync(join(d, '9.1.0', 'FlatChat-9.1.0.AppImage')) || readFileSync(join(d, '9.1.0', 'FlatChat-9.1.0.AppImage')).length === PACKAGE.length)).toBe(true);
  });

  it('fails quietly when the feed is not there', async () => {
    expect((await check(server({}), publicKey)).status).toBe('failed');
  });
});

describe('putting it in', () => {
  it('replaces a running AppImage, runs the installer FlatChat came with, and leaves the rest to the player', () => {
    expect(applyPlan('linux', { APPIMAGE: '/home/a/FlatChat.AppImage' }, '/tmp/.mount/flatchat', '/u/FlatChat-9.1.0.AppImage')).toEqual({ how: 'appimage', target: '/home/a/FlatChat.AppImage' });
    expect(applyPlan('linux', {}, '/opt/flatchat/flatchat', '/u/FlatChat-9.1.0.AppImage')).toEqual({ how: 'manual' });
    expect(applyPlan('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a\\AppData\\Local\\Programs\\flatchat\\FlatChat.exe', 'C:\\u\\FlatChat-9.1.0-setup.exe')).toEqual({ how: 'installer' });
    expect(applyPlan('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'D:\\Games\\FlatChat\\FlatChat.exe', 'C:\\u\\FlatChat-9.1.0-setup.exe')).toEqual({ how: 'manual' });
  });
});
