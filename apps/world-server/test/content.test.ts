// SPDX-License-Identifier: MPL-2.0
// World downloads (S2.04): a built world loaded and checked, announced at the join, fetched in
// chunks from any offset over a real connection, and refused when a file does not match.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeColliders } from '@flatchat/content';
import { decodeMessage, encodeMessage, type Message, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken, toHex } from '@flatchat/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { builtOptions, DEFAULT_SERVER, WorldServer } from '../src/server.ts';
import { boundsOf, ContentServer, loadBuiltWorld } from '../src/world/content.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function builtWorld(): { dir: string; big: Uint8Array; glb: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fc-built-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'content'));
  const big = new Uint8Array(40_000).map((_, i) => (i * 7) & 255);
  const collision = encodeColliders([{ type: 'box', position: [10, -0.5, 10], rotation: [0, 0, 0, 1], half: [10, 0.5, 10] }]);
  const files = [
    { bytes: big, kind: 'scene' },
    { bytes: collision, kind: 'collision' },
  ];
  for (const f of files) writeFileSync(join(dir, 'content', sha(f.bytes)), f.bytes);
  const world = {
    format: 1,
    manifest: { format: 1, name: 'Built', description: '', capacity: { recommended: 4, maximum: 6 }, persistence: 'reset', flying: false, avatars: { minHeight: 0.5, maxHeight: 3 }, voice: { range: 25 }, scenes: [{ id: 'main', file: 'main.glb' }] },
    scenes: [{ id: 'main', glb: sha(big), spawns: [{ position: [5, 0, 6], yaw: 1, title: '', group: '' }], seats: [], portals: [], zones: [], emitters: [], triangles: 2 }],
    collision: sha(collision),
    bounds: { min: [0, -100, 0], max: [20, 500, 20] },
    files: files.map((f) => ({ hash: sha(f.bytes), size: f.bytes.length, kind: f.kind })),
  };
  writeFileSync(join(dir, 'world.json'), JSON.stringify(world));
  return { dir, big, glb: sha(big) };
}

describe('a built world on disk', () => {
  it('loads with its hashes checked, and gives the server its solids and spawn points', async () => {
    const { dir } = builtWorld();
    const loaded = await loadBuiltWorld(dir);
    expect(loaded.files.size).toBe(3);
    expect(boundsOf(loaded.colliders)).toEqual([{ min: { x: 0, y: -1, z: 0 }, max: { x: 20, y: 0, z: 20 } }]);
    const o = builtOptions(loaded, new ContentServer(loaded));
    expect(o.spawnPoints).toEqual([{ x: 5, y: 0, z: 6, yaw: 1, group: '', main: true }]);
    expect(o.portals).toEqual([]);
    expect(o.capacity).toBe(6);
    expect(o.world?.size).toBe(20);
  });

  it('refuses a file that does not match world.json', async () => {
    const { dir, glb } = builtWorld();
    writeFileSync(join(dir, 'content', glb), new Uint8Array(40_000));
    await expect(loadBuiltWorld(dir)).rejects.toThrow(/does not match/);
  });
});

describe('downloads over the world connection', () => {
  it('announces the world, sends files in chunks from any offset, and stops when asked', async () => {
    const { dir, big, glb } = builtWorld();
    const loaded = await loadBuiltWorld(dir);
    const key = newWorldKey();
    const world = randomUUID();
    const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
    const server = new WorldServer({ ...DEFAULT_SERVER, worldId: world, worldKey: key, metricsEverySec: 0, log: () => {}, ...builtOptions(loaded, new ContentServer(loaded)) }, [udp]);
    server.start();
    try {
      const link = await connectUdp({ host: '127.0.0.1', port: udp.port });
      const got: Message[] = [];
      link.onMessage((_ch, bytes) => got.push(decodeMessage(bytes, 'server')));
      const send = (m: Message, ch: 'reliable' | 'unreliable' = 'reliable'): void => link.send(ch, encodeMessage(m));
      const token = await sealToken({ account: randomUUID(), name: 'dl', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 1 }, { key, world, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '' });
      const until = async (pred: () => boolean): Promise<void> => {
        for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      };
      await until(() => got.some((m) => m.type === 'content'));
      const content = got.find((m) => m.type === 'content');
      expect(content && content.type === 'content' && toHex(content.world)).toBe(loaded.hash);
      // The spawn is the world's spawn point.
      await until(() => got.some((m) => m.type === 'snapshot' && m.correction?.seq === 0));
      const spawn = got.find((m) => m.type === 'snapshot' && m.correction?.seq === 0);
      expect(spawn?.type === 'snapshot' && spawn.correction?.position).toMatchObject({ x: 5, z: 6 });

      const reassemble = async (hash: string, from: number): Promise<Uint8Array> => {
        got.length = 0;
        send({ type: 'fetch', hash: Buffer.from(hash, 'hex'), from });
        await until(() => got.some((m) => m.type === 'chunk' && toHex(m.hash) === hash && m.offset + m.data.length === m.total));
        const chunks = got.filter((m): m is Extract<Message, { type: 'chunk' }> => m.type === 'chunk' && toHex(m.hash) === hash);
        const out = new Uint8Array(chunks[0]!.total);
        for (const c of chunks) out.set(c.data, c.offset);
        expect(chunks.every((c) => c.data.length <= 16_384)).toBe(true);
        return out.subarray(from);
      };
      expect(sha(await reassemble(loaded.hash, 0))).toBe(loaded.hash);
      expect(await reassemble(glb, 0)).toEqual(big);
      // Resuming: from 30,000 only the rest comes.
      expect(await reassemble(glb, 30_000)).toEqual(big.subarray(30_000));
      got.length = 0;
      send({ type: 'fetch', hash: Buffer.alloc(32, 1), from: 0 });
      await until(() => got.some((m) => m.type === 'notFound'));
      expect(got.some((m) => m.type === 'notFound')).toBe(true);
      link.close('done');
    } finally {
      await server.stop('test over');
    }
  });
});
