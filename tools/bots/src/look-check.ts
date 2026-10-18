// SPDX-License-Identifier: MPL-2.0
// The look check (S6.03, S6.04) with the real client: the reference avatars (VRM 1.0 and VRM 0.x in
// MToon, a plain GLB in PBR) and the avatar with a creator shader, each converted by the platform's
// converter (no KTX2: this checks the materials, not texture compression) with the uploaded file
// kept beside it. The client's look mode (apps/client/src/renderer/src/crowd/look.ts) then draws each
// as a world draws it and as a VRM viewer draws the upload, compares the pictures, and draws the
// creator shader.
//
//   node tools/bots/src/look-check.ts CLIENT [--out DIR] [--report FILE]
//
// One JSON line: { event: 'look-check', ok, backend, avatars } ; exit 0 when every check passed.
// FLATCHAT_HEADLESS=1 runs the client without a window (procs.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { convertAvatar } from '@flatchat/converter/avatar';
import { sampleAvatar, sampleShaderAvatar } from '@flatchat/converter/samples';
import { headless, run } from './procs.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, report: { type: 'string' } } });
const client = positionals[0];
if (!client) {
  process.stderr.write('usage: node tools/bots/src/look-check.ts CLIENT [--out DIR] [--report FILE]\n');
  process.exit(2);
}
const dir = values.out ?? mkdtempSync(join(tmpdir(), 'fclook-'));
const report = values.report ?? join(dir, 'look.json');
const avatars: Array<[string, () => Promise<Uint8Array>]> = [
  ['vrm1', () => sampleAvatar('vrm1')],
  ['vrm0', () => sampleAvatar('vrm0')],
  ['glb', () => sampleAvatar('glb')],
  ['shader', () => sampleShaderAvatar()],
];
for (const [name, make] of avatars) {
  const source = await make();
  const r = await convertAvatar(source, { ktx2: false });
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  for (const level of ['lod0', 'lod1', 'lod2', 'impostor'] as const) writeFileSync(join(folder, `${r.manifest.levels[level].file}.vrm`), r.files.get(r.manifest.levels[level].file)!);
  writeFileSync(join(folder, 'manifest.json'), r.manifestBytes);
  writeFileSync(join(folder, 'source.vrm'), source);
}
let line: Record<string, unknown> = { event: 'look-check', ok: false };
try {
  await run([client, '--crowd=120', `--avatars=${dir}`, '--crowd-converted=1', '--crowd-look=1', `--crowd-out=${report}`, ...(process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []), ...headless()]).catch(() => undefined);
  const r = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>;
  line = { event: 'look-check', ok: r['error'] === undefined && (r['backend'] === 'WebGPU' || r['backend'] === 'WebGL2'), backend: r['backend'], avatars: r['avatars'], ...(r['error'] ? { error: r['error'] } : {}) };
} catch (err) {
  line['error'] = err instanceof Error ? err.message.slice(0, 300) : String(err);
} finally {
  if (!values.out) rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(line)}\n`);
process.exit(line['ok'] ? 0 : 1);
