// SPDX-License-Identifier: MPL-2.0
// Converts a world folder into a built world, ready for a world server (S2.03):
//
//   npm run convert -w @flatchat/converter -- WORLD_DIR OUT_DIR [--no-ktx2]
//
// One JSON line at the end; every problem of a refused world on stderr.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConvertError, convertWorld, readFolder, writeBuilt } from './world.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'no-ktx2': { type: 'boolean', default: false } } });
const [from, to] = positionals;
if (!from || !to) {
  process.stderr.write('usage: convert WORLD_DIR OUT_DIR [--no-ktx2]\n');
  process.exit(2);
}
try {
  const started = performance.now();
  const { world, out, warnings } = await convertWorld(readFolder(resolve(from)), { ktx2: !values['no-ktx2'] });
  writeBuilt(resolve(to), out);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'converted', name: world.manifest.name, scenes: world.scenes.length, files: world.files.length, bytes: world.files.reduce((n, f) => n + f.size, 0), warnings: warnings.length, ms: Math.round(performance.now() - started) })}\n`);
} catch (err) {
  if (err instanceof ConvertError) {
    for (const p of err.report.problems) process.stderr.write(`${p.severity}: ${p.code} ${p.file} ${p.at}: ${p.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`convert: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
