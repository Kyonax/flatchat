// SPDX-License-Identifier: MPL-2.0
// The world's database (S2.08): state kept across restarts in a persistent world, cleared in a
// reset one, the limits, and a returning player put back where they left.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMessage, encodeMessage, type Message, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';
import { STORE_LIMITS, WorldStore } from '../src/world/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'fc-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the world database', () => {
  it('keeps state across a restart in a persistent world, and clears it in a reset one', () => {
    const path = join(dir, 'w1.db');
    const a = WorldStore.open(path, 'persistent');
    expect(a.set('world', 'door', bytes('open'))).toBe(true);
    a.savePlace('acct', { x: 1, y: 2, z: 3, yaw: 0.5 });
    a.close();
    const b = WorldStore.open(path, 'persistent');
    expect(new TextDecoder().decode(b.get('world', 'door'))).toBe('open');
    expect(b.place('acct')).toEqual({ x: 1, y: 2, z: 3, yaw: 0.5 });
    b.close();
    const c = WorldStore.open(path, 'reset');
    expect(c.get('world', 'door')).toBeUndefined();
    expect(c.place('acct')).toBeUndefined();
    expect(c.meta('mode')).toBe('reset');
    c.close();
  });

  it('holds each scope to its limits', () => {
    const s = WorldStore.open(':memory:', 'persistent');
    expect(s.set('p', 'big', new Uint8Array(STORE_LIMITS.value + 1))).toBe(false);
    expect(s.set('p', '', bytes('x'))).toBe(false);
    for (let i = 0; i < STORE_LIMITS.keys; i++) s.set('p', `k${i}`, bytes('x'));
    expect(s.set('p', 'one-more', bytes('x'))).toBe(false);
    expect(s.set('p', 'k0', bytes('replaced'))).toBe(true);
    expect(s.keys('other')).toEqual([]);
    s.delete('p', 'k0');
    expect(s.get('p', 'k0')).toBeUndefined();
    s.close();
  });
});

describe('a persistent world', () => {
  it('puts a returning player where they left, after the server restarts', async () => {
    const key = newWorldKey();
    const world = randomUUID();
    const account = randomUUID();
    const path = join(dir, 'w2.db');
    const session = async (move?: { x: number; z: number }): Promise<{ x: number; z: number }> => {
      const store = WorldStore.open(path, 'persistent');
      const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
      const server = new WorldServer({ ...DEFAULT_SERVER, worldId: world, worldKey: key, metricsEverySec: 0, log: () => {}, world: { size: 64 }, spawn: { x: 32, z: 32, r: 0 }, store }, [udp]);
      server.start();
      const link = await connectUdp({ host: '127.0.0.1', port: udp.port });
      const got: Message[] = [];
      link.onMessage((_c, b) => got.push(decodeMessage(b, 'server')));
      const token = await sealToken({ account, name: 'back', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 1, owner: false, contact: 'everyone', friends: [], blocks: [] }, { key, world, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      link.send('reliable', encodeMessage({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 't', token, spawn: '', height: 0 }));
      for (let i = 0; i < 200 && !got.some((m) => m.type === 'snapshot' && m.correction?.seq === 0); i++) await new Promise((r) => setTimeout(r, 10));
      const spawn = (got.find((m) => m.type === 'snapshot' && m.correction?.seq === 0) as Extract<Message, { type: 'snapshot' }>).correction!.position;
      if (move) {
        // Walk there in small steps the server accepts.
        let at = { x: spawn.x, z: spawn.z };
        for (let seq = 1; seq < 200 && (Math.abs(at.x - move.x) > 0.1 || Math.abs(at.z - move.z) > 0.1); seq++) {
          at = { x: at.x + Math.max(-0.3, Math.min(0.3, move.x - at.x)), z: at.z + Math.max(-0.3, Math.min(0.3, move.z - at.z)) };
          link.send('unreliable', encodeMessage({ type: 'pose', seq, position: { x: at.x, y: 0, z: at.z }, yaw: 0, look: 0, stance: 'standing' }));
          await new Promise((r) => setTimeout(r, 55));
        }
      }
      link.send('reliable', encodeMessage({ type: 'leave', reason: 'quit', detail: '' }));
      await new Promise((r) => setTimeout(r, 200));
      await server.stop('test');
      store.close();
      return { x: spawn.x, z: spawn.z };
    };
    const first = await session({ x: 36, z: 30 });
    expect(first).toEqual({ x: 32, z: 32 });
    const second = await session();
    expect(second.x).toBeCloseTo(36, 1);
    expect(second.z).toBeCloseTo(30, 1);
  }, 30_000);
});
