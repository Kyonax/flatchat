// SPDX-License-Identifier: MPL-2.0
// The avatar converter as a program of its own (S4.02, R-18): the core runs it on each upload in a
// separate process with Node.js's permission model, reading only the upload and writing only its
// output folder, with a time and memory limit; a crash or a hostile file costs that process alone.
//
//   node src/avatar-cli.ts UPLOAD OUTDIR [--no-ktx2]
//
// Writes OUTDIR/<sha256> for each level and the thumbnail, OUTDIR/manifest.json, and last
// OUTDIR/result.json: { ok: true, id, manifest } or { ok: false, problems }. Exit 0 when converted,
// 1 when refused, 2 on a usage error. Nothing else is promised on stdout (the KTX2 encoder talks).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AvatarError, convertAvatar } from './avatar/convert.ts';

const [input, out, flag] = process.argv.slice(2);
if (!input || !out || (flag !== undefined && flag !== '--no-ktx2')) {
  process.stderr.write('usage: avatar-cli.ts UPLOAD OUTDIR [--no-ktx2]\n');
  process.exit(2);
}
const write = (name: string, bytes: Uint8Array | string): void => writeFileSync(join(out, name), bytes, { flag: 'wx' });
try {
  const r = await convertAvatar(new Uint8Array(readFileSync(input)), { ktx2: flag !== '--no-ktx2' });
  for (const [hash, bytes] of r.files) write(hash, bytes);
  write('manifest.json', r.manifestBytes);
  write('result.json', JSON.stringify({ ok: true, id: r.id, manifest: r.manifest }));
  process.exit(0);
} catch (err) {
  const problems = err instanceof AvatarError ? err.problems : [`the converter failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`];
  write('result.json', JSON.stringify({ ok: false, problems }));
  process.exit(1);
}
