// SPDX-License-Identifier: MPL-2.0
// The self-update end to end (S7.01), with the packaged client: given a feed on this machine and a
// throwaway key (--update-feed and --update-key, which only a feed on this machine may bring), it
// finds a later version, checks the feed's signature and downloads the package, checking its hash;
// a feed changed after it was signed, a package that is not the one the feed names, and a feed
// signed with another key are each refused, nothing kept.
//
//   node tools/bots/src/update-check.ts CLIENT
//
// One JSON line: { event: 'update-check-test', ok, cases }; exit 0 when every case went as it should.
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headless } from './procs.ts';

const client = process.argv[2];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/update-check.ts CLIENT\n');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'fcupdate-'));
const key = (): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(der.subarray(der.length - 32)).toString('base64') };
};
const owner = key();
const stranger = key();
const PACKAGE = randomBytes(2 * 1024 * 1024);
const platform = `${process.platform}-${process.arch}`;

/** What the server hands out now: the feed, its signature, the package. */
let files: Record<string, Buffer> = {};
const server = createServer((req, res) => {
  const name = (req.url ?? '').split('/').pop() ?? '';
  const body = files[name];
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/updates/`;
const feedOf = (version: string): Buffer =>
  Buffer.from(JSON.stringify({ format: 1, version, released: '2026-10-18', packages: { [platform]: { url: `${base}FlatChat-${version}.AppImage`, sha256: createHash('sha256').update(PACKAGE).digest('hex'), bytes: PACKAGE.length } } }));

/** One run of the client's --update-check, with the files served and the key it is given. */
async function run(name: string, served: Record<string, Buffer>, publicKey: string): Promise<Record<string, unknown>> {
  files = served;
  const out = join(dir, `${name}.json`);
  const proc = spawn(client!, ['--update-check', `--update-feed=${base}`, `--update-key=${publicKey}`, `--update-out=${out}`, ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []), ...headless()], { stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
  } catch {
    return { status: 'no report', exit: proc.exitCode };
  }
}

const feed = feedOf('99.0.0');
const signature = Buffer.from(sign(null, feed, owner.privateKey).toString('base64'));
const pkg = { 'FlatChat-99.0.0.AppImage': PACKAGE };
const cases: Record<string, { got: Record<string, unknown>; right: boolean }> = {};
try {
  const good = await run('good', { 'flatchat-update.json': feed, 'flatchat-update.json.sig': signature, ...pkg }, owner.publicKey);
  cases['good'] = { got: good, right: good['status'] === 'downloaded' && good['version'] === '99.0.0' };
  const changed = await run('changed', { 'flatchat-update.json': feedOf('99.0.1'), 'flatchat-update.json.sig': signature, ...pkg }, owner.publicKey);
  cases['feed changed after signing'] = { got: changed, right: changed['status'] === 'refused' && /not signed/.test(String(changed['why'])) };
  const swapped = await run('swapped', { 'flatchat-update.json': feed, 'flatchat-update.json.sig': signature, 'FlatChat-99.0.0.AppImage': randomBytes(PACKAGE.length) }, owner.publicKey);
  cases['package not the one named'] = { got: swapped, right: swapped['status'] === 'refused' && /not the one the feed names/.test(String(swapped['why'])) };
  const other = await run('other', { 'flatchat-update.json': feed, 'flatchat-update.json.sig': signature, ...pkg }, stranger.publicKey);
  cases['another key'] = { got: other, right: other['status'] === 'refused' };
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
const ok = Object.keys(cases).length === 4 && Object.values(cases).every((c) => c.right);
process.stdout.write(`${JSON.stringify({ event: 'update-check-test', ok, cases })}\n`);
process.exit(ok ? 0 : 1);
