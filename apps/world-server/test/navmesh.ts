// SPDX-License-Identifier: MPL-2.0
// A navigation mesh for the tests, made by Recast as the converter makes one (tools/converter):
// a 40 m floor with a 4 m block, 1.5 m tall, in the middle.
import { BODY } from '@flatchat/sim';
import { exportNavMesh, init } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { WalkableSurface } from '../src/world/navigation.ts';

function box(min: [number, number, number], max: [number, number, number], positions: number[], indices: number[]): void {
  const base = positions.length / 3;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) positions.push(x, y, z);
  // Corner k = (x?4:0) + (y?2:0) + (z?1:0); each face wound to face outwards.
  const faces = [
    [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
  ];
  for (const [a, b, c, d] of faces) indices.push(base + a!, base + b!, base + c!, base + a!, base + c!, base + d!);
}

export async function testSurface(): Promise<WalkableSurface> {
  await init();
  const positions: number[] = [];
  const indices: number[] = [];
  box([0, -0.2, 0], [40, 0, 40], positions, indices);
  box([18, 0, 18], [22, 1.5, 22], positions, indices);
  const cs = 0.2;
  const ch = 0.1;
  const r = generateSoloNavMesh(new Float32Array(positions), new Uint32Array(indices), {
    cs,
    ch,
    walkableSlopeAngle: 45,
    walkableHeight: Math.ceil(BODY.height / ch),
    walkableClimb: Math.floor(BODY.step / ch),
    walkableRadius: Math.ceil(BODY.radius / cs),
    maxEdgeLen: 12 / cs,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6 * cs,
    detailSampleMaxError: ch,
  });
  if (!r.success) throw new Error(`no navigation mesh: ${r.error}`);
  const bytes = exportNavMesh(r.navMesh);
  r.navMesh.destroy();
  return WalkableSurface.load(bytes);
}
