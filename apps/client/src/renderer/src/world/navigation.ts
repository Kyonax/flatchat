// SPDX-License-Identifier: MPL-2.0
// Paths for click to move (S2.06, DR-13): the built world's navigation mesh (the converter's Recast
// mesh, downloaded and hash-checked with the rest of the world) answers a walkable path between
// two points. recast-navigation carries its WebAssembly inside its module, loaded only when a world
// has a mesh; the page's policy already allows WebAssembly for Rapier.
import type { NavMesh, NavMeshQuery } from 'recast-navigation';
import type { PathPoint } from './walker';

export class Navigation {
  private readonly mesh: NavMesh;
  private readonly query: NavMeshQuery;

  private constructor(mesh: NavMesh, query: NavMeshQuery) {
    this.mesh = mesh;
    this.query = query;
  }

  static async load(bytes: Uint8Array): Promise<Navigation> {
    const recast = await import('recast-navigation');
    await recast.init();
    const { navMesh } = recast.importNavMesh(bytes);
    return new Navigation(navMesh, new recast.NavMeshQuery(navMesh));
  }

  /** The walkable path from one point to another (corners only), or undefined when there is none. */
  path(from: PathPoint, to: PathPoint): PathPoint[] | undefined {
    const r = this.query.computePath(from, to, { halfExtents: { x: 1, y: 2, z: 1 } });
    return r.success && r.path.length > 0 ? r.path.map((p) => ({ x: p.x, y: p.y, z: p.z })) : undefined;
  }

  dispose(): void {
    this.query.destroy();
    this.mesh.destroy();
  }
}
