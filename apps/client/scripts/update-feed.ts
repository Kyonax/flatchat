// SPDX-License-Identifier: MPL-2.0
// Writes a release's update feed (S7.01): flatchat-update.json naming the version and each
// package's address, SHA-256 and size, and flatchat-update.json.sig, its Ed25519 signature with the
// owner's key. Upload both beside the packages; a client trusts the feed only when the signature
// checks against the key built into it.
//
//   node apps/client/scripts/update-feed.ts --version 1.2.3 --key ~/.flatchat-release/update-key.pem
//        [--base https://kyonax.com/flatchat/updates/] [--linux FlatChat.AppImage] [--windows FlatChat-setup.exe]
//        [--out apps/client/release/feed]
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readUpdateManifest, UPDATE_FEED_FILE, UPDATE_SIGNATURE_FILE, type UpdatePackage } from '../src/shared/update.ts';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    key: { type: 'string' },
    base: { type: 'string', default: 'https://kyonax.com/flatchat/updates/' },
    linux: { type: 'string' },
    windows: { type: 'string' },
    out: { type: 'string', default: 'apps/client/release/feed' },
    released: { type: 'string', default: new Date().toISOString().slice(0, 10) },
  },
});
if (!values.version || !values.key || (!values.linux && !values.windows) || !values.base.endsWith('/')) {
  process.stderr.write('usage: update-feed.ts --version X.Y.Z --key PRIVATE.pem [--base URL/] (--linux FILE | --windows FILE)… [--out DIR]\n');
  process.exit(2);
}
const entry = (file: string): UpdatePackage => {
  const bytes = readFileSync(file);
  return { url: new URL(encodeURIComponent(basename(file)), values.base).href, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
};
const feed = {
  format: 1,
  version: values.version,
  released: values.released,
  packages: { ...(values.linux ? { 'linux-x64': entry(values.linux) } : {}), ...(values.windows ? { 'win32-x64': entry(values.windows) } : {}) },
};
const read = readUpdateManifest(feed);
if ('problems' in read) {
  process.stderr.write(`the feed would not read: ${read.problems.join('; ')}\n`);
  process.exit(1);
}
const bytes = Buffer.from(`${JSON.stringify(feed, null, 2)}\n`);
const signature = sign(null, bytes, createPrivateKey(readFileSync(values.key))).toString('base64');
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, UPDATE_FEED_FILE), bytes);
writeFileSync(join(values.out, UPDATE_SIGNATURE_FILE), `${signature}\n`);
process.stdout.write(`${JSON.stringify({ event: 'update-feed', out: values.out, version: values.version, packages: Object.keys(feed.packages) })}\n`);
