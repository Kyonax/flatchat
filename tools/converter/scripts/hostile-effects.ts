// SPDX-License-Identifier: MPL-2.0
// A host that does not play fair (S6.01's Verify: a fuzzed effect corpus never crashes the client).
// After a world is built, broken effects are put into it as its host could, past the converter,
// each at a marker beside the world's first effect, with numbers the host made up (a particle each).
// A client must refuse every one and play the world's own effect on:
//   - fuzz case 270, a broken trail whose single update takes about 32 s: the client's measuring
//     worker is ended at the deadline;
//   - fuzz case 12, a laser that stops the runtime, and case 0, one the runtime cannot read;
//   - fuzz case 1, a laser cut short, which the reader refuses;
//   - the laser "saved by a newer editor" (its version raised past the runtime's);
//   - an effect that names a material file, a creator shader, with the file beside it.
// The fuzz cases are src/effect/fuzz.ts's corpus.
//
//   node tools/converter/scripts/hostile-effects.ts BUILT_DIR
//
// Rewrites BUILT_DIR/world.json and adds the bundles to BUILT_DIR/content. One JSON line: what it added.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuiltWorld, type EffectBundle, parseBuiltWorld, writeBundle } from '@flatchat/content';
import { effectBody, fuzzCorpus } from '../src/effect/fuzz.ts';
import { sampleBundle } from '../src/effect/samples.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: hostile-effects.ts BUILT_DIR\n');
  process.exit(2);
}

const main = (rel: string): Uint8Array => {
  const b = sampleBundle(rel);
  return b.files.get(b.main)!;
};
/** A sample's bundle with its effect file replaced. */
const replaced = (rel: string, bytes: Uint8Array): EffectBundle => {
  const b = sampleBundle(rel);
  const files = new Map(b.files);
  files.set(b.main, bytes);
  return { main: b.main, files };
};

const hostile: Array<{ name: string; bundle: EffectBundle }> = [];
const wanted = new Map([
  [270, 'deadline'],
  [12, 'runtime-stopped'],
  [0, 'runtime-unread'],
  [1, 'reader'],
]);
for (const c of fuzzCorpus(main)) if (wanted.has(c.index)) hostile.push({ name: `fuzz-${c.index}-${wanted.get(c.index)}`, bundle: replaced(c.sample, c.bytes) });
const newer = main('00_Basic/Laser01.efkefc').slice();
new DataView(newer.buffer).setInt32(new TextDecoder('latin1').decode(newer).indexOf('SKFE') + 4, 1900, true);
hostile.push({ name: 'newer-editor', bundle: replaced('00_Basic/Laser01.efkefc', newer) });
hostile.push({
  name: 'material-file',
  bundle: {
    main: 'Glow.efk',
    files: new Map([
      ['Glow.efk', effectBody(1810, [[], [], [], [], [], ['Glow.efkmat'], []])],
      ['Glow.efkmat', new TextEncoder().encode('EFKM a node graph')],
    ]),
  },
});

const raw = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as BuiltWorld;
const parsed = parseBuiltWorld(raw);
if ('error' in parsed) throw new Error(`world.json: ${parsed.error}`);
const scene = raw.scenes.find((s) => s.effects.length > 0) ?? raw.scenes[raw.scenes.length - 1]!;
const base = scene.effects[0]?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const [i, h] of hostile.entries()) {
  const bytes = writeBundle(h.bundle);
  const hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'content', hash), bytes);
  if (!raw.files.some((f) => f.hash === hash)) raw.files.push({ hash, size: bytes.length, kind: 'effect' });
  const matrix = base.slice();
  matrix[12] = base[12]! + 1.5 * (i + 1);
  scene.effects.push({ file: hash, matrix, scale: 1, peak: { instances: 1, quads: 1, triangles: 0 } });
}
const check = parseBuiltWorld(raw);
if ('error' in check) throw new Error(`the hostile world.json does not parse: ${check.error}`);
writeFileSync(join(dir, 'world.json'), `${JSON.stringify(raw)}\n`);
process.stdout.write(`${JSON.stringify({ event: 'hostile-effects', added: hostile.map((h) => h.name) })}\n`);
