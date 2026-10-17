// SPDX-License-Identifier: MPL-2.0
// host push (S3.06): a build sent piece by piece within its window to a real world server, which
// takes it from the owner and refuses it from a visitor.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeColliders } from '@flatchat/content';
import { newWorldKey, sealToken } from '@flatchat/protocol';
import { ContentServer, loadBuiltWorld } from '@flatchat/world-server/content';
import { connectUdp, UdpServer } from '@flatchat/world-server/net';
import { builtOptions, DEFAULT_SERVER, WorldServer } from '@flatchat/world-server/server';
import { BuildUploads } from '@flatchat/world-server/uploads';
import { afterAll, describe, expect, it } from 'vitest';
import { pushBuild, WINDOW } from '../src/push.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A built world as the converter lays it out, named `name`, its scene `scene`. */
function built(name: string, scene: Uint8Array): { dir: string; files: Map<string, Uint8Array> } {
  const dir = mkdtempSync(join(tmpdir(), 'fc-push-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'content'));
  const collision = encodeColliders([{ type: 'box', position: [10, -0.5, 10], rotation: [0, 0, 0, 1], half: [10, 0.5, 10] }]);
  const parts = [
    { bytes: scene, kind: 'scene' },
    { bytes: collision, kind: 'collision' },
  ];
  const files = new Map<string, Uint8Array>();
  for (const f of parts) {
    writeFileSync(join(dir, 'content', sha(f.bytes)), f.bytes);
    files.set(`content/${sha(f.bytes)}`, f.bytes);
  }
  const world = {
    format: 1,
    manifest: { format: 1, name, description: '', capacity: { recommended: 4, maximum: 6 }, persistence: 'reset', flying: false, avatars: { minHeight: 0.5, maxHeight: 3 }, voice: { range: 25 }, scenes: [{ id: 'main', file: 'main.glb' }] },
    scenes: [{ id: 'main', glb: sha(scene), spawns: [{ position: [5, 0, 6], yaw: 1, title: '', group: '' }], seats: [], portals: [], zones: [], emitters: [], triangles: 2 }],
    collision: sha(collision),
    bounds: { min: [0, -100, 0], max: [20, 500, 20] },
    files: parts.map((f) => ({ hash: sha(f.bytes), size: f.bytes.length, kind: f.kind })),
  };
  const json = new TextEncoder().encode(JSON.stringify(world));
  writeFileSync(join(dir, 'world.json'), json);
  files.set('world.json', json);
  return { dir, files };
}

async function token(owner: boolean): Promise<Uint8Array> {
  return sealToken(
    { account: randomUUID(), name: owner ? 'Owner' : 'Vi', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 9, owner, contact: 'everyone', friends: [], blocks: [] },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
}

describe('host push', () => {
  it('sends a build larger than its window to the world, which takes it from the owner and refuses it from a visitor', async () => {
    const before = built('Before', new Uint8Array(1000).fill(1));
    const loaded = await loadBuiltWorld(before.dir);
    const published: string[] = [];
    const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
    const server = new WorldServer(
      { ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, ...builtOptions(loaded, new ContentServer(loaded)), uploads: new BuildUploads(before.dir), onPublished: (w) => published.push(w.name) },
      [udp],
    );
    server.start();
    try {
      const big = new Uint8Array(4 * WINDOW + 123).map((_, i) => (i * 31) & 255);
      const after = built('After', big);

      const visitor = await connectUdp({ host: '127.0.0.1', port: udp.port });
      expect(await pushBuild(visitor, await token(false), after.files)).toEqual({ ok: false, detail: 'only a builder, an admin or the owner may change this world' });
      visitor.close('done');

      const owner = await connectUdp({ host: '127.0.0.1', port: udp.port });
      const seen: number[] = [];
      const r = await pushBuild(owner, await token(true), after.files, { progress: (sent) => seen.push(sent) });
      owner.close('done');
      expect(r).toEqual({ ok: true, detail: '' });
      expect(seen.at(-1)).toBe([...after.files.values()].reduce((n, b) => n + b.length, 0));
      expect(published).toEqual(['After']);
      const now = await loadBuiltWorld(before.dir);
      expect(now.world.manifest.name).toBe('After');
      expect(now.files.has(sha(big))).toBe(true);
    } finally {
      await server.stop('test over');
    }
    // Two megabytes over raw UDP within a window: seconds on a loaded machine (the harness runs
    // every workspace's tests at once).
  }, 30_000);
});
