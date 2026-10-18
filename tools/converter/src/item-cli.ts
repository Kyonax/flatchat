// SPDX-License-Identifier: MPL-2.0
// The item converter as a program of its own (S5.05): the core runs it on each item upload the way
// it runs avatar-cli.ts, in a separate process under Node.js's permission model, reading only the
// converter, the upload and the standard bodies (for the skeleton and clipping checks), writing
// only its output folder, with a time and memory limit.
//
//   node src/item-cli.ts UPLOAD OUTDIR KITS [--no-ktx2]
//
// KITS is kits/bodies/: each body's VRM, checked against kits.json's SHA-256 before it is used.
// Writes OUTDIR/<sha256> for each fit (or the prop), OUTDIR/manifest.json, and last
// OUTDIR/result.json: { ok: true, id, manifest } or { ok: false, problems }. Exit 0 when converted,
// 1 when refused, 2 on a usage error. Nothing else is promised on stdout (the KTX2 encoder talks).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_KITS, type BodyKit } from '@flatchat/content';
import { readAvatarLevel } from './avatar/convert.ts';
import { type KitBody, kitBody } from './item/clipping.ts';
import { convertItem, ItemError } from './item/convert.ts';

const [input, out, kitsDir, flag] = process.argv.slice(2);
if (!input || !out || !kitsDir || (flag !== undefined && flag !== '--no-ktx2')) {
  process.stderr.write('usage: item-cli.ts UPLOAD OUTDIR KITS [--no-ktx2]\n');
  process.exit(2);
}
const write = (name: string, bytes: Uint8Array | string): void => writeFileSync(join(out, name), bytes, { flag: 'wx' });

/** The three standard bodies, each the one kits.json names. */
async function readKits(dir: string): Promise<Partial<Record<BodyKit, KitBody>>> {
  const listed = JSON.parse(readFileSync(join(dir, 'kits.json'), 'utf8')) as { kits?: Record<string, { vrm?: string; vrmSha256?: string }> };
  const kits: Partial<Record<BodyKit, KitBody>> = {};
  for (const body of BODY_KITS) {
    const k = listed.kits?.[body];
    if (!k?.vrm || !k.vrmSha256) throw new Error(`kits.json lists no ${body} body`);
    const bytes = new Uint8Array(readFileSync(join(dir, body, k.vrm)));
    if (createHash('sha256').update(bytes).digest('hex') !== k.vrmSha256) throw new Error(`the ${body} body is not the one kits.json names`);
    const { doc, data } = await readAvatarLevel(bytes);
    kits[body] = kitBody(body, doc, data);
  }
  return kits;
}

try {
  const kits = await readKits(kitsDir);
  const r = await convertItem(new Uint8Array(readFileSync(input)), { ktx2: flag !== '--no-ktx2', kits });
  for (const [hash, bytes] of r.files) write(hash, bytes);
  write('manifest.json', r.manifestBytes);
  write('result.json', JSON.stringify({ ok: true, id: r.id, manifest: r.manifest }));
  process.exit(0);
} catch (err) {
  const problems = err instanceof ItemError ? err.problems : [`the converter failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`];
  write('result.json', JSON.stringify({ ok: false, problems }));
  process.exit(1);
}
