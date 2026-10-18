// SPDX-License-Identifier: MPL-2.0
// Audits converted avatars' impostors (S4.12). For each folder of converted avatars (a
// manifest.json and its levels as <sha256>.vrm, as tools/bots/src/avatar-bench.ts makes them), it
// reports the impostor's triangles and how many of them a stride stretches (src/avatar/stride.ts).
// A well-made impostor stretches none.
//
//   node tools/converter/scripts/impostor-audit.ts DIR
//
// One JSON line per avatar, then { event: 'impostor-audit', avatars, withStretched }; exit 0 when
// no impostor stretches.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAvatarLevel } from '../src/avatar/convert.ts';
import { impostorStretch } from '../src/avatar/stride.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: impostor-audit.ts DIR\n');
  process.exit(2);
}
let avatars = 0;
let withStretched = 0;
for (const folder of readdirSync(dir).sort()) {
  const manifest = join(dir, folder, 'manifest.json');
  if (!existsSync(manifest)) continue;
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as { levels: { impostor: { file: string } } };
  const { doc, data } = await readAvatarLevel(new Uint8Array(readFileSync(join(dir, folder, `${m.levels.impostor.file}.vrm`))));
  const r = impostorStretch(doc, data.humanBones());
  avatars += 1;
  if (r.stretched > 0) withStretched += 1;
  process.stdout.write(`${JSON.stringify({ avatar: folder, ...r })}\n`);
}
process.stdout.write(`${JSON.stringify({ event: 'impostor-audit', avatars, withStretched })}\n`);
process.exit(withStretched === 0 ? 0 : 1);
