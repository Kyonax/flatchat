// SPDX-License-Identifier: MPL-2.0
// Writes the animation converter's samples (S5.07) to a folder: wave.bvh and wave.glb (the GLB
// clip), for tools/blender/animation/make-sample-fbx.py to make the FBX fixture from.
//
//   node scripts/animation-samples.ts OUTDIR
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleBvh, sampleClip } from '../src/animation/samples.ts';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: animation-samples.ts OUTDIR\n');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'wave.bvh'), sampleBvh());
writeFileSync(join(out, 'wave.glb'), await sampleClip());
process.stdout.write(`wrote ${join(out, 'wave.bvh')} and ${join(out, 'wave.glb')}\n`);
