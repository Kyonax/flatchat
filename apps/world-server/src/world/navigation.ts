// SPDX-License-Identifier: MPL-2.0
// A built world's navigation mesh on the server (S2.06): where a teleport may land. The converter
// built it with Recast from the world's solids (the surfaces a player can stand on, with room above
// them); a clicked spot must lie within half a metre across and a metre up or down of it, and the
// player lands on the nearest walkable point.
import { importNavMesh, init, type NavMesh, NavMeshQuery } from 'recast-navigation';

let ready: Promise<void> | undefined;

export interface Point {
  x: number;
  y: number;
  z: number;
}

export class WalkableSurface {
  private readonly mesh: NavMesh;
  private readonly query: NavMeshQuery;

  private constructor(mesh: NavMesh) {
    this.mesh = mesh;
    this.query = new NavMeshQuery(mesh);
  }

  /** Reads the converter's navigation mesh (Recast's own format). */
  static async load(bytes: Uint8Array): Promise<WalkableSurface> {
    await (ready ??= init());
    return new WalkableSurface(importNavMesh(bytes).navMesh);
  }

  /** The walkable point nearest `p` within `across` metres in x and z and `updown` in y, if any. */
  nearest(p: Point, across = 0.5, updown = 1): Point | undefined {
    const r = this.query.findClosestPoint(p, { halfExtents: { x: across, y: updown, z: across } });
    if (!r.success || r.polyRef === 0) return undefined;
    if (Math.hypot(r.point.x - p.x, r.point.z - p.z) > across || Math.abs(r.point.y - p.y) > updown) return undefined;
    return { x: r.point.x, y: r.point.y, z: r.point.z };
  }

  dispose(): void {
    this.query.destroy();
    this.mesh.destroy();
  }
}
