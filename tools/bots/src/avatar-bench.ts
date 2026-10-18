// SPDX-License-Identifier: MPL-2.0
// The avatar bench (S4.05, S4.12): real avatars through the real converter, then the client's
// converted crowd (--crowd-converted) drawing them with the world's own avatar layer, to measure the
// plan's lines: 55 avatars in view at 30 fps and 200 present with impostors, at 1280×720. On the
// reference laptop (or its stand-in, `npm run standin -- run …`) these are the owner's runs; on any
// PC this measures that PC.
//
//   node tools/bots/src/avatar-bench.ts --from DIR --out DIR [--no-ktx2]
//        [--client CLIENT [--seconds 60] [--present 200] [--in-view 55] [--tier low|medium|high]
//                         [--report FILE] [--headroom 1]]
//
// --from: a folder of .vrm and .glb files (subfolders included); each converted once into --out
// (a folder per avatar: manifest.json and its levels as <sha256>.vrm), kept for the next run.
// With --client: the packaged client runs the converted crowd and the report's pass lines print.
// Without --tier the policy is 12 full, 20 lower, springs on 6 and every rank drawn in full (harsher
// than any tier); with it, that tier's policy as it ships (avatar-policy.ts TIER_POLICY).
import { readdirSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { AvatarError, convertAvatar } from '@flatchat/converter/avatar';
import { run } from './procs.ts';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    out: { type: 'string' },
    'no-ktx2': { type: 'boolean', default: false },
    client: { type: 'string' },
    seconds: { type: 'string', default: '60' },
    present: { type: 'string', default: '200' },
    'in-view': { type: 'string', default: '55' },
    tier: { type: 'string' },
    report: { type: 'string' },
    headroom: { type: 'string', default: '1' },
  },
});
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
if (!values.from || !values.out) {
  process.stderr.write('usage: avatar-bench.ts --from DIR --out DIR [--no-ktx2] [--client CLIENT …]\n');
  process.exit(2);
}

const files: string[] = [];
const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else if (/\.(vrm|glb)$/i.test(e.name)) files.push(join(d, e.name));
  }
};
walk(values.from);
files.sort();
mkdirSync(values.out, { recursive: true });
let converted = 0;
let refused = 0;
for (const [i, f] of files.entries()) {
  const folder = join(values.out, `${String(i).padStart(3, '0')}-${basename(f).replace(/\.(vrm|glb)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`);
  if (existsSync(join(folder, 'manifest.json'))) {
    converted += 1;
    continue;
  }
  const t0 = performance.now();
  try {
    const r = await convertAvatar(new Uint8Array(readFileSync(f)), { ktx2: !values['no-ktx2'] });
    mkdirSync(folder, { recursive: true });
    for (const level of ['lod0', 'lod1', 'lod2', 'impostor'] as const) writeFileSync(join(folder, `${r.manifest.levels[level].file}.vrm`), r.files.get(r.manifest.levels[level].file)!);
    writeFileSync(join(folder, 'manifest.json'), r.manifestBytes);
    converted += 1;
    say('converted', { file: basename(f), ms: Math.round(performance.now() - t0), rank: r.manifest.rank, triangles: r.manifest.levels.lod0.triangles, shape: r.manifest.shape });
  } catch (err) {
    refused += 1;
    say('refused', { file: basename(f), why: err instanceof AvatarError ? err.problems.slice(0, 2) : String(err).slice(0, 200) });
  }
}
say('converted-all', { files: files.length, converted, refused, out: values.out });

if (values.client) {
  const report = values.report ?? join(values.out, 'crowd-report.json');
  await run([
    values.client,
    `--crowd=${values.seconds}`,
    `--avatars=${values.out}`,
    '--crowd-converted=1',
    `--crowd-present=${values.present}`,
    `--crowd-in-view=${values['in-view']}`,
    ...(values.tier ? [`--crowd-tier=${values.tier}`] : []),
    `--crowd-headroom=${values.headroom}`,
    `--crowd-out=${report}`,
    '--bench-size=1280x720',
  ]).catch((e: Error) => say('client', { error: e.message.slice(0, 300) }));
  const r = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>;
  say('avatar-bench', { backend: r['backend'], policy: r['policy'], summary: r['summary'], levels: r['levels'], render: r['render'], loadMs: r['loadMs'], failures: r['failures'], pass: r['pass'] });
}
