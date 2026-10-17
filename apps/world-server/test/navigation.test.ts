// SPDX-License-Identifier: MPL-2.0
// Where a teleport may land on a built world (S2.06): the converter's navigation mesh.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WalkableSurface } from '../src/world/navigation.ts';
import { testSurface } from './navmesh.ts';

let surface: WalkableSurface;
beforeAll(async () => {
  surface = await testSurface();
});
afterAll(() => surface.dispose());

describe('the walkable surface', () => {
  // Recast's mesh lies within one cell height (0.1 m) of the real surface.
  it('finds the floor under a spot just above it, and the block’s top', () => {
    const floor = surface.nearest({ x: 10, y: 0.2, z: 10 });
    expect(Math.abs(floor!.y)).toBeLessThanOrEqual(0.11);
    expect(Math.hypot(floor!.x - 10, floor!.z - 10)).toBeLessThan(0.5);
    expect(Math.abs(surface.nearest({ x: 20, y: 1.6, z: 20 })!.y - 1.5)).toBeLessThanOrEqual(0.11);
  });

  it('finds nothing in the air, outside the world, or against the block’s side', () => {
    expect(surface.nearest({ x: 10, y: 3, z: 10 })).toBeUndefined();
    expect(surface.nearest({ x: 50, y: 0, z: 50 })).toBeUndefined();
    // Half a metre from the block's wall at floor height: the floor stops a body's radius short of it.
    expect(surface.nearest({ x: 17.95, y: 0.1, z: 20 }, 0.1)).toBeUndefined();
  });
});
