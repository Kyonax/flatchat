// SPDX-License-Identifier: MPL-2.0
// Builds a semantic SVG plan (Track P's P.01, docs/svg-plans.md) into a world folder beside it:
// world.toml and scenes/<id>.glb, which the world format's validator and the host tool's converter
// take like any other (S2.01, S2.03). The scene's id is the folder's name. It says what it made:
// triangles, materials (draw calls), solids and parts.
//
//   node tools/converter/scripts/build-plan.ts PLAN.svg [OUT]       OUT defaults to the plan's folder
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { buildPlan } from '../src/plan/build.ts';
import { readPlan } from '../src/plan/plan.ts';
import { PlanError } from '../src/plan/svg.ts';

const [planFile, outArg] = process.argv.slice(2);
if (!planFile) {
  console.error('usage: node tools/converter/scripts/build-plan.ts PLAN.svg [OUT]');
  process.exit(2);
}
const out = resolve(outArg ?? dirname(planFile));
const id = basename(out);
try {
  const plan = readPlan(readFileSync(planFile, 'utf8'));
  const built = buildPlan(plan, id);
  mkdirSync(join(out, 'scenes'), { recursive: true });
  writeFileSync(join(out, 'scenes', `${id}.glb`), built.glb);
  writeFileSync(join(out, 'world.toml'), built.worldToml);
  process.stdout.write(`plan: ${plan.name}: ${plan.floors.length} floors, ${built.triangles} triangles in ${built.materials} materials, ${built.solids} solids, ${built.parts} parts; scenes/${id}.glb ${built.glb.length} bytes\n`);
} catch (err) {
  if (err instanceof PlanError) {
    for (const p of err.problems) console.error(`plan: ${p}`);
    process.exit(1);
  }
  throw err;
}
