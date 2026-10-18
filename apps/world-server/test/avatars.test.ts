// SPDX-License-Identifier: MPL-2.0
// Avatars in the world server (S4.05, S4.07, S4.10): the roster carries the avatar a player's
// connect token names, their face and their proportions fitted into the platform's range; `wear`
// swaps the avatar with a fresh token of the same account (a replay or another account's is
// refused); `face` and `appearance` change the roster for everyone.
import { randomUUID } from 'node:crypto';
import { decodeMessage, encodeMessage, type Message, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { DEFAULT_SERVER, fitOutfit, fitProportions, WorldServer } from '../src/server.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const AVATAR_A = new Uint8Array(32).fill(0xaa);
const AVATAR_B = new Uint8Array(32).fill(0xbb);

let running: WorldServer[] = [];
afterEach(async () => {
  for (const s of running) await s.stop('test over');
  running = [];
});

async function start(): Promise<UdpServer> {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {} }, [udp]);
  server.start();
  running.push(server);
  return udp;
}

const token = (account: string, avatar?: Uint8Array): Promise<Uint8Array> =>
  sealToken(
    { account, name: 'P', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 9, owner: false, contact: 'everyone', friends: [], blocks: [], ...(avatar ? { avatar } : {}) },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );

class Client {
  readonly got: Message[] = [];
  entity = -1;
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>) {
    this.link = link;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
  }
  send(m: Message): void {
    this.link.send(messageDef(m.type).channel, encodeMessage(m));
  }
  /** The latest roster entry for an entity. */
  player(entity: number): MessageOf<'roster'>['players'][number] | undefined {
    for (let i = this.got.length - 1; i >= 0; i--) {
      const m = this.got[i]!;
      if (m.type === 'roster') {
        const p = m.players.find((x) => x.entity === entity);
        if (p) return p;
      }
    }
    return undefined;
  }
}

async function enter(udp: UdpServer, account: string, avatar?: Uint8Array, proportions?: { width: number; arms: number; legs: number; head: number }): Promise<Client> {
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }));
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token: await token(account, avatar), spawn: '', height: 0, ...(proportions ? { proportions } : {}) });
  for (let i = 0; i < 200 && c.entity < 0; i++) {
    const w = c.got.find((m): m is MessageOf<'welcome'> => m.type === 'welcome');
    if (w) c.entity = w.entity;
    else await new Promise((r) => setTimeout(r, 10));
  }
  return c;
}

const until = async (what: string, probe: () => boolean): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}`);
};

describe('avatars, faces and proportions in the roster', () => {
  it('fits proportions into 80 to 125 percent, as made when left out', () => {
    expect(fitProportions(undefined)).toEqual({ width: 100, arms: 100, legs: 100, head: 100 });
    expect(fitProportions({ width: 10, arms: 200, legs: 101.4, head: 125 })).toEqual({ width: 80, arms: 125, legs: 101, head: 125 });
  });

  it('carries the token’s avatar, swaps it on `wear`, and refuses a replayed or foreign token', async () => {
    const udp = await start();
    const account = randomUUID();
    const a = await enter(udp, account, AVATAR_A, { width: 70, arms: 100, legs: 130, head: 110 });
    const b = await enter(udp, randomUUID());
    await until('b sees a', () => b.player(a.entity) !== undefined);
    expect([...b.player(a.entity)!.avatar!]).toEqual([...AVATAR_A]);
    expect(b.player(a.entity)!.proportions).toEqual({ width: 80, arms: 100, legs: 125, head: 110 });
    expect(b.player(a.entity)!.face).toEqual({ expression: 'neutral', left: 'relaxed', right: 'relaxed' });

    const fresh = await token(account, AVATAR_B);
    a.send({ type: 'wear', token: fresh });
    await until('the new avatar', () => b.player(a.entity)!.avatar?.[0] === 0xbb);
    // Someone else's token, and the same token again, change nothing (and wait out the 2 s pace).
    await new Promise((r) => setTimeout(r, 2100));
    a.send({ type: 'wear', token: await token(randomUUID(), AVATAR_A) });
    await new Promise((r) => setTimeout(r, 2100));
    a.send({ type: 'wear', token: fresh });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.player(a.entity)!.avatar?.[0]).toBe(0xbb);
  }, 15_000);

  it('announces faces and new proportions to everyone', async () => {
    const udp = await start();
    const a = await enter(udp, randomUUID());
    const b = await enter(udp, randomUUID());
    a.send({ type: 'face', expression: 'happy', left: 'peace', right: 'thumbsUp' });
    await until('the face', () => b.player(a.entity)?.face.expression === 'happy');
    expect(b.player(a.entity)!.face).toEqual({ expression: 'happy', left: 'peace', right: 'thumbsUp' });
    a.send({ type: 'appearance', height: 180, proportions: { width: 90, arms: 110, legs: 95, head: 120 } });
    await until('the proportions', () => b.player(a.entity)?.proportions.head === 120);
    expect(b.player(a.entity)!.proportions).toEqual({ width: 90, arms: 110, legs: 95, head: 120 });
  });

  it('fits an outfit: each item once, every adjustment within the limits', () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(fitOutfit([{ item: a }, { item: b, adjust: { x: 50, y: -50, z: 3, rx: 90, ry: -90, rz: 10, scale: 200 } }, { item: a }])).toEqual([
      { item: a },
      { item: b, adjust: { x: 10, y: -10, z: 3, rx: 45, ry: -45, rz: 10, scale: 125 } },
    ]);
  });

  it('announces an outfit to everyone, and takes at most one change a second (S5.05)', async () => {
    const udp = await start();
    const a = await enter(udp, randomUUID());
    const b = await enter(udp, randomUUID());
    await until('b sees a', () => b.player(a.entity) !== undefined);
    expect(b.player(a.entity)!.outfit).toEqual([]);
    a.send({ type: 'outfit', items: [{ item: AVATAR_A }, { item: AVATAR_B, adjust: { x: 0, y: 2, z: 0, rx: 0, ry: 0, rz: 0, scale: 100 } }] });
    await until('the outfit', () => b.player(a.entity)!.outfit.length === 2);
    expect(b.player(a.entity)!.outfit[1]!.adjust).toEqual({ x: 0, y: 2, z: 0, rx: 0, ry: 0, rz: 0, scale: 100 });
    // A second change straight away is dropped; after the pace it lands.
    a.send({ type: 'outfit', items: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(b.player(a.entity)!.outfit).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 900));
    a.send({ type: 'outfit', items: [] });
    await until('the outfit off', () => b.player(a.entity)!.outfit.length === 0);
  });
});

