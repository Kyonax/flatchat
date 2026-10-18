// SPDX-License-Identifier: MPL-2.0
// The animation converter as a program of its own (S5.07): the core runs it on each emote or dance
// upload the way it runs avatar-cli.ts, in a separate process under Node.js's permission model,
// reading only the converter and the upload, writing only its output folder. An FBX reaches it
// already turned into a GLB by headless Blender (tools/blender/animation/fbx2glb.py, which the core
// runs first); `--from fbx` and the original's SHA-256 and size then go in the manifest.
//
//   node src/animation-cli.ts UPLOAD OUTDIR [--use emote|dance] [--from fbx --source SHA256:BYTES]
//
// Writes OUTDIR/<sha256> (the VRMA), OUTDIR/manifest.json, and last OUTDIR/result.json:
// { ok: true, id, manifest } or { ok: false, problems }. Exit 0 when converted, 1 when refused, 2 on
// a usage error.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ANIMATION_USES, type AnimationUse } from '@flatchat/content';
import { AnimationError, convertAnimation } from './animation/convert.ts';

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { use: { type: 'string', default: 'emote' }, from: { type: 'string' }, source: { type: 'string' } } });
} catch {
  parsed = undefined;
}
const [input, out] = parsed?.positionals ?? [];
const use = parsed?.values.use as AnimationUse | undefined;
const source = /^([0-9a-f]{64}):(\d{1,12})$/.exec(parsed?.values.source ?? '');
if (!parsed || !input || !out || parsed.positionals.length !== 2 || !(ANIMATION_USES as readonly unknown[]).includes(use) || (parsed.values.from !== undefined && (parsed.values.from !== 'fbx' || !source))) {
  process.stderr.write('usage: animation-cli.ts UPLOAD OUTDIR [--use emote|dance] [--from fbx --source SHA256:BYTES]\n');
  process.exit(2);
}
const write = (name: string, bytes: Uint8Array | string): void => writeFileSync(join(out, name), bytes, { flag: 'wx' });
try {
  const r = await convertAnimation(new Uint8Array(readFileSync(input)), { use: use!, ...(source ? { from: 'fbx' as const, source: { sha256: source[1]!, bytes: Number(source[2]) } } : {}) });
  for (const [hash, bytes] of r.files) write(hash, bytes);
  write('manifest.json', r.manifestBytes);
  write('result.json', JSON.stringify({ ok: true, id: r.id, manifest: r.manifest }));
  process.exit(0);
} catch (err) {
  const problems = err instanceof AnimationError ? err.problems : [`the converter failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`];
  write('result.json', JSON.stringify({ ok: false, problems }));
  process.exit(1);
}
