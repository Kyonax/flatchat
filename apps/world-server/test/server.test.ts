// SPDX-License-Identifier: MPL-2.0
// The world server end to end on loopback raw UDP: joins with real connect tokens, every refusal,
// snapshots that carry the players, corrections, voice bundles, chat and pings.
import { randomUUID } from 'node:crypto';
import {
  decodeCellBlock,
  decodeMessage,
  encodeMessage,
  type Message,
  type MessageName,
  type MessageOf,
  newWorldKey,
  PROTOCOL_VERSION,
  SCHEMA_FINGERPRINT,
  sealToken,
} from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Link } from '../src/net/types.ts';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { PLAZA } from '@flatchat/sim';
import { cleanChat, DEFAULT_SERVER, type EntryRule, mapOptions, WorldServer } from '../src/server.ts';
import { testSurface } from './navmesh.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const NOW = 1_800_000_000;
const mouth = { aa: 1, ih: 2, ou: 3, ee: 4, oh: 5, level: 9 };

let running: { server: WorldServer; udp: UdpServer } | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.link.close('test over');
  if (running) await running.server.stop('test over');
  running = undefined;
});

async function start(overrides: Partial<ConstructorParameters<typeof WorldServer>[0]> = {}): Promise<UdpServer> {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, unixNow: () => NOW, ...overrides }, [udp]);
  server.start();
  running = { server, udp };
  return udp;
}

class Client {
  readonly link: Link;
  readonly got: Message[] = [];
  private waiters: Array<() => void> = [];

  constructor(link: Link) {
    this.link = link;
    link.onMessage((_channel, bytes) => {
      this.got.push(decodeMessage(bytes, 'server'));
      for (const w of this.waiters.splice(0)) w();
    });
  }

  send(message: Message): void {
    const bytes = encodeMessage(message);
    this.link.send(message.type === 'pose' || message.type === 'voice' || message.type === 'ping' ? 'unreliable' : 'reliable', bytes);
  }

  async next<K extends MessageName>(type: K, where: (m: MessageOf<K>) => boolean = () => true, ms = 2000): Promise<MessageOf<K>> {
    const end = performance.now() + ms;
    for (;;) {
      const found = this.got.find((m): m is MessageOf<K> => m.type === type && where(m as MessageOf<K>));
      if (found) return found;
      const left = end - performance.now();
      if (left <= 0) throw new Error(`no ${type} within ${ms} ms; got ${this.got.map((m) => m.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function token(options: { world?: string; expiresAt?: number; nonce?: Uint8Array; name?: string; account?: string; trust?: number } = {}): Promise<Uint8Array> {
  return sealToken(
    { account: options.account ?? randomUUID(), name: options.name ?? 'bot', trust: options.trust ?? 1, tester: true, emailVerified: true, under18: false, ageDays: 3 },
    { key: KEY, world: options.world ?? WORLD, expiresAt: options.expiresAt ?? NOW + 60, ...(options.nonce ? { nonce: options.nonce } : {}) },
  );
}

async function connect(udp: UdpServer, hello: Partial<MessageOf<'hello'>> = {}): Promise<Client> {
  const client = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }));
  clients.push(client);
  client.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token: hello.token ?? (await token()), spawn: '', height: 0, ...hello });
  return client;
}

describe('joining', () => {
  it('welcomes a valid token, sends the roster, then the join snapshot with the spawn', async () => {
    const udp = await start();
    const c = await connect(udp);
    const welcome = await c.next('welcome');
    expect(welcome).toMatchObject({ protocol: PROTOCOL_VERSION, world: WORLD, tickHz: 20 });
    const roster = await c.next('roster');
    expect(roster.full).toBe(true);
    expect(roster.players.map((p) => p.entity)).toEqual([welcome.entity]);
    const snap = await c.next('snapshot', (s) => s.correction !== undefined);
    expect(snap.correction?.seq).toBe(0);
    const ids = snap.blocks.flatMap((b) => decodeCellBlock(b).full.map((e) => e.id));
    expect(ids).toContain(welcome.entity);
  });

  it.each([
    ['server-outdated', { protocol: PROTOCOL_VERSION + 1 }],
    ['schema-mismatch', { fingerprint: (SCHEMA_FINGERPRINT + 1) >>> 0 }],
  ] as const)('refuses %s', async (reason, hello) => {
    const udp = await start();
    const c = await connect(udp, hello);
    expect((await c.next('refuse')).reason).toBe(reason);
  });

  it('refuses everyone when the core requires a newer protocol than it speaks', async () => {
    const udp = await start({ coreMinimum: PROTOCOL_VERSION + 1 });
    expect((await (await connect(udp)).next('refuse')).reason).toBe('server-outdated');
  });

  it('refuses tokens for another world, expired, forged or replayed', async () => {
    const udp = await start();
    const other = await connect(udp, { token: await token({ world: randomUUID() }) });
    expect((await other.next('refuse')).reason).toBe('wrong-world');
    const old = await connect(udp, { token: await token({ expiresAt: NOW }) });
    expect((await old.next('refuse')).reason).toBe('token-expired');
    const forged = await token();
    forged[forged.length - 1]! ^= 1;
    const bad = await connect(udp, { token: forged });
    expect((await bad.next('refuse')).reason).toBe('token-invalid');
    const once = await token();
    const first = await connect(udp, { token: once });
    await first.next('welcome');
    const again = await connect(udp, { token: once });
    expect((await again.next('refuse')).reason).toBe('token-replayed');
  });

  it('refuses joins beyond its capacity', async () => {
    const udp = await start({ capacity: 1 });
    await (await connect(udp)).next('welcome');
    expect((await (await connect(udp)).next('refuse')).reason).toBe('full');
  });
});

describe('a joined player', () => {
  it('moves, is seen by a neighbour, hears and is heard, chats and gets pongs', async () => {
    // In a 16 m world every spawn is within the 25 m voice range of every other.
    const udp = await start({ world: { size: 16 } });
    const a = await connect(udp, { token: await token({ name: 'a' }) });
    const b = await connect(udp, { token: await token({ name: 'b' }) });
    const wa = await a.next('welcome');
    const wb = await b.next('welcome');
    const spawn = (await a.next('snapshot', (s) => s.correction !== undefined)).correction!.position;
    a.send({ type: 'pose', seq: 1, position: { x: spawn.x, y: 0, z: spawn.z }, yaw: 0, look: 0, stance: 'sitting' });
    const seenByB = await b.next('snapshot', (s) => s.blocks.some((blk) => decodeCellBlock(blk).full.some((e) => e.id === wa.entity && e.stance === 'sitting')));
    expect(seenByB.tick).toBeGreaterThan(0);
    expect((await a.next('snapshot', (s) => s.ack === 1)).ack).toBe(1);

    a.send({ type: 'voice', seq: 5, start: true, mouth, opus: new Uint8Array(60).fill(7) });
    const bundle = await b.next('voiceBundle');
    expect(bundle.frames).toEqual([{ from: wa.entity, seq: 5, start: true, mouth, opus: new Uint8Array(60).fill(7) }]);

    b.send({ type: 'say', text: 'hola' });
    expect(await a.next('chat')).toMatchObject({ from: wb.entity, text: 'hola' });

    a.send({ type: 'ping', id: 9, time: 1234 });
    expect(await a.next('pong')).toMatchObject({ id: 9, time: 1234 });
  });

  it('is corrected when a pose moves too fast', async () => {
    const udp = await start();
    const a = await connect(udp);
    await a.next('welcome');
    const spawn = (await a.next('snapshot', (s) => s.correction !== undefined)).correction!.position;
    a.send({ type: 'pose', seq: 1, position: { x: (spawn.x + 100) % 256, y: 0, z: spawn.z }, yaw: 0, look: 0, stance: 'standing' });
    const fixed = await a.next('snapshot', (s) => s.correction?.seq === 1);
    expect(fixed.correction?.position.x).toBeCloseTo(spawn.x, 1);
  });

  it('leaves, and the others see it in a roster change', async () => {
    const udp = await start();
    const a = await connect(udp);
    const b = await connect(udp);
    const wa = await a.next('welcome');
    await b.next('welcome');
    a.send({ type: 'leave', reason: 'quit', detail: '' });
    const change = await b.next('roster', (r) => !r.full && r.left.includes(wa.entity));
    expect(change.left).toEqual([wa.entity]);
    expect(running?.server.players).toBe(1);
  });
});

describe('Stage 1: entry rules, one session per account, world-wide chat, the plaza', () => {
  it('refuses a player an entry rule turns away, with its reason', async () => {
    const trusted: EntryRule = (claims) => (claims.trust >= 2 ? { admit: true } : { admit: false, detail: 'testers only' });
    const udp = await start({ entryRules: [trusted] });
    const low = await connect(udp, { token: await token({ trust: 1 }) });
    expect(await low.next('refuse')).toMatchObject({ reason: 'rule', detail: 'testers only' });
    const high = await connect(udp, { token: await token({ trust: 2 }) });
    await high.next('welcome');
  });

  it('ends the older connection when an account joins again', async () => {
    const udp = await start();
    const account = randomUUID();
    const first = await connect(udp, { token: await token({ account, name: 'ana' }) });
    const firstWelcome = await first.next('welcome');
    const second = await connect(udp, { token: await token({ account, name: 'ana' }) });
    const secondWelcome = await second.next('welcome');
    expect(await first.next('leave')).toMatchObject({ reason: 'kicked' });
    expect(running?.server.players).toBe(1);
    // The new entity is never the one just freed, so no roster names two players with one id.
    expect(secondWelcome.entity).not.toBe(firstWelcome.entity);
  });

  it('lets 50 players join and leave in a loop, and frees their places', async () => {
    const udp = await start({ capacity: 10 });
    for (let round = 0; round < 5; round++) {
      const batch = await Promise.all(Array.from({ length: 10 }, () => connect(udp)));
      await Promise.all(batch.map((c) => c.next('welcome', () => true, 4000)));
      expect(running?.server.players).toBe(10);
      for (const c of batch) c.send({ type: 'leave', reason: 'quit', detail: '' });
      for (let i = 0; i < 100 && (running?.server.players ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(running?.server.players).toBe(0);
      // Let the roster announce the leaves before the next batch takes their ids.
      await new Promise((r) => setTimeout(r, 120));
    }
  });

  it('sends chat to everyone in the world, cleaned and limited', async () => {
    const udp = await start({ world: { size: 1024 } });
    const a = await connect(udp, { token: await token({ name: 'ana' }) });
    const b = await connect(udp, { token: await token({ name: 'bea' }) });
    const aw = await a.next('welcome');
    await b.next('welcome');
    // Far apart: chat is not by distance.
    a.send({ type: 'pose', seq: 1, position: { x: 10, y: 0, z: 10 }, yaw: 0, look: 0, stance: 'standing' });
    a.send({ type: 'say', text: 'hola\u202e  a todos\u0007' });
    const line = await b.next('chat');
    expect(line).toEqual({ type: 'chat', from: aw.entity, text: 'hola a todos' });
    for (let i = 0; i < 10; i++) a.send({ type: 'say', text: `line ${i}` });
    await new Promise((r) => setTimeout(r, 300));
    // The burst of 5, the first included.
    expect(b.got.filter((m) => m.type === 'chat').length).toBe(5);
    expect(cleanChat('x'.repeat(400))).toHaveLength(280);
    expect(cleanChat('   ')).toBe('');
  });

  it('serves the plaza: its spawn, its size, and corrects a player rising beyond a jump', async () => {
    const udp = await start(mapOptions(PLAZA));
    const a = await connect(udp);
    const spawn = (await a.next('snapshot', (s) => s.correction?.seq === 0)).correction!;
    expect(Math.hypot(spawn.position.x - PLAZA.spawn.x, spawn.position.z - PLAZA.spawn.z)).toBeLessThanOrEqual(PLAZA.spawn.radius + 0.01);
    expect(spawn.position.y).toBeCloseTo(PLAZA.spawn.y, 1);
    expect(spawn.yaw).toBeCloseTo(0, 2);
    // A jump is fine; floating 5 m up is not.
    a.send({ type: 'pose', seq: 1, position: { ...spawn.position, y: spawn.position.y + 0.8 }, yaw: 0, look: 0, stance: 'jumping' });
    await new Promise((r) => setTimeout(r, 120));
    a.send({ type: 'pose', seq: 2, position: { ...spawn.position, y: spawn.position.y + 5 }, yaw: 0, look: 0, stance: 'jumping' });
    const fixed = await a.next('snapshot', (s) => s.correction?.seq === 2);
    expect(fixed.correction!.position.y).toBeCloseTo(spawn.position.y + 0.8, 1);
  });
});

describe('portals and spawn groups (S2.11)', () => {
  const portal = { center: [20, 1.4, 30] as [number, number, number], half: [2, 1.5, 1] as [number, number, number], yaw: 0, world: '00000000-0000-4000-8000-0000000000b2', spawn: 'arrival' };
  const spawnPoints = [
    { x: 20, y: 0, z: 20, yaw: 0, group: 'start', main: true },
    { x: 26, y: 0, z: 24, yaw: Math.PI, group: 'arrival', main: false },
  ];

  it('lands a hello that names a group on that group, and anyone else on the main spawn points', async () => {
    const udp = await start({ world: { size: 64 }, spawnPoints, portals: [portal] });
    const arriving = await connect(udp, { spawn: 'arrival' });
    const there = (await arriving.next('snapshot', (s) => s.correction?.seq === 0)).correction!;
    expect([there.position.x, there.position.z]).toEqual([26, 24]);
    const walkIn = await connect(udp);
    const here = (await walkIn.next('snapshot', (s) => s.correction?.seq === 0)).correction!;
    expect([here.position.x, here.position.z]).toEqual([20, 20]);
    // A group the world does not have: the main spawn points.
    const lost = await connect(udp, { spawn: 'nowhere' });
    expect((await lost.next('snapshot', (s) => s.correction?.seq === 0)).correction!.position.z).toBe(20);
  });

  it('sends portal once on entering its box, and again only after leaving it', async () => {
    const udp = await start({ world: { size: 64 }, spawnPoints, portals: [portal] });
    const c = await connect(udp);
    await c.next('snapshot', (s) => s.correction?.seq === 0);
    let seq = 0;
    const walk = async (z: number): Promise<void> => {
      for (let step = 0; step < 6; step++) {
        c.send({ type: 'pose', seq: (seq += 1), position: { x: 20, y: 0, z }, yaw: 0, look: 0, stance: 'standing' });
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    // Walk south in short steps, as a player would, into the box at z 29 to 31.
    for (let z = 20.5; z <= 29.5; z += 0.25) {
      c.send({ type: 'pose', seq: (seq += 1), position: { x: 20, y: 0, z }, yaw: 0, look: 0, stance: 'standing' });
      await new Promise((r) => setTimeout(r, 55));
    }
    await walk(29.5);
    expect(await c.next('portal')).toEqual({ type: 'portal', world: portal.world, spawn: 'arrival' });
    expect(c.got.filter((m) => m.type === 'portal')).toHaveLength(1);
    // Out and back in: a second one.
    for (let z = 29.25; z >= 27.5; z -= 0.25) {
      c.send({ type: 'pose', seq: (seq += 1), position: { x: 20, y: 0, z }, yaw: 0, look: 0, stance: 'standing' });
      await new Promise((r) => setTimeout(r, 55));
    }
    for (let z = 27.75; z <= 29.5; z += 0.25) {
      c.send({ type: 'pose', seq: (seq += 1), position: { x: 20, y: 0, z }, yaw: 0, look: 0, stance: 'standing' });
      await new Promise((r) => setTimeout(r, 55));
    }
    await c.next('portal', () => c.got.filter((m) => m.type === 'portal').length >= 2);
    expect(c.got.filter((m) => m.type === 'portal')).toHaveLength(2);
  });

  it('does not send a player arriving inside a portal straight back', async () => {
    const udp = await start({ world: { size: 64 }, spawnPoints: [{ x: 20, y: 0, z: 30, yaw: 0, group: 'start', main: true }], portals: [portal] });
    const c = await connect(udp);
    await c.next('snapshot', (s) => s.correction?.seq === 0);
    for (let i = 1; i <= 8; i++) {
      c.send({ type: 'pose', seq: i, position: { x: 20, y: 0, z: 30 }, yaw: 0, look: 0, stance: 'standing' });
      await new Promise((r) => setTimeout(r, 55));
    }
    expect(c.got.some((m) => m.type === 'portal')).toBe(false);
  });
});

describe('heights (S2.07)', () => {
  it('fits a chosen height into the world’s range, and a narrower or wider world fits it differently', async () => {
    const heightOf = async (udp: UdpServer, height: number): Promise<number> => {
      const c = await connect(udp, { height });
      const w = await c.next('welcome');
      return (await c.next('roster')).players.find((p) => p.entity === w.entity)!.height;
    };
    // The platform's range by default: 0.5 to 3 m; 0 means the default height.
    let udp = await start();
    expect([await heightOf(udp, 0), await heightOf(udp, 160), await heightOf(udp, 20), await heightOf(udp, 900)]).toEqual([175, 160, 50, 300]);
    await running!.server.stop('next world');
    running = undefined;
    // A world that narrows it to 1.2–1.5 m.
    udp = await start({ heights: { min: 1.2, max: 1.5 } });
    expect([await heightOf(udp, 0), await heightOf(udp, 130), await heightOf(udp, 300)]).toEqual([150, 130, 150]);
    await running!.server.stop('next world');
    running = undefined;
    // One that widens it to 0.2–8 m.
    udp = await start({ heights: { min: 0.2, max: 8 } });
    expect([await heightOf(udp, 25), await heightOf(udp, 700)]).toEqual([25, 700]);
  });

  it('announces a new height as a roster change, at most once a second', async () => {
    const udp = await start({ heights: { min: 1, max: 2 } });
    const a = await connect(udp);
    const me = (await a.next('welcome')).entity;
    const b = await connect(udp);
    await b.next('welcome');
    a.send({ type: 'appearance', height: 260 });
    const change = await b.next('roster', (r) => !r.full && r.players.some((p) => p.entity === me && p.height === 200));
    expect(change.players.find((p) => p.entity === me)!.height).toBe(200);
    a.send({ type: 'appearance', height: 120 });
    await new Promise((r) => setTimeout(r, 300));
    expect(b.got.some((m) => m.type === 'roster' && m.players.some((p) => p.entity === me && p.height === 120))).toBe(false);
  });
});

describe('seats and teleports (S2.06)', () => {
  const seats = [{ position: [22, 0.45, 20] as [number, number, number], yaw: 1 }];
  const solids = [
    { min: { x: 0, y: -1, z: 0 }, max: { x: 64, y: 0, z: 64 } },
    { min: { x: 30, y: 0, z: 30 }, max: { x: 34, y: 2, z: 34 } },
  ];
  const spawnPoints = [{ x: 20, y: 0, z: 20, yaw: 0, group: 'start', main: true }];

  /** Sends a teleport and returns the answer to it (the newest `placed`). */
  async function placedAfter(c: Client, m: MessageOf<'teleport'>): Promise<MessageOf<'placed'>> {
    const all = (): Array<MessageOf<'placed'>> => c.got.filter((x): x is MessageOf<'placed'> => x.type === 'placed');
    const before = all().length;
    c.send(m);
    await c.next('placed', () => all().length > before);
    return all().at(-1)!;
  }

  it('sits a player on a seat within reach, and refuses one too far away or unknown', async () => {
    const udp = await start({ world: { size: 64, solids }, spawnPoints, seats });
    const c = await connect(udp);
    await c.next('snapshot', (s) => s.correction?.seq === 0);
    const sat = await placedAfter(c, { type: 'teleport', position: { x: 0, y: 0, z: 0 }, yaw: 0, seat: 0 });
    expect(sat).toMatchObject({ accepted: true, stance: 'sitting', position: { x: 22, z: 20 } });
    expect(sat.position.y).toBeCloseTo(0.45, 1);
    await new Promise((r) => setTimeout(r, 1050));
    expect((await placedAfter(c, { type: 'teleport', position: { x: 0, y: 0, z: 0 }, yaw: 0, seat: 7 })).accepted).toBe(false);
  });

  it('lands a clicked spot on the ground within range, once a second, and never inside a solid or in the air', async () => {
    const udp = await start({ world: { size: 64, solids }, spawnPoints });
    const c = await connect(udp);
    await c.next('snapshot', (s) => s.correction?.seq === 0);
    const ok = await placedAfter(c, { type: 'teleport', position: { x: 26, y: 0.2, z: 26 }, yaw: 0.5 });
    expect(ok).toMatchObject({ accepted: true, stance: 'standing', position: { x: 26, y: 0, z: 26 } });
    // Too soon after the last one.
    expect((await placedAfter(c, { type: 'teleport', position: { x: 27, y: 0, z: 27 }, yaw: 0 })).accepted).toBe(false);
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 1050));
    await wait();
    // Inside the block, floating, out of range, outside the world.
    expect((await placedAfter(c, { type: 'teleport', position: { x: 32, y: 1, z: 32 }, yaw: 0 })).accepted).toBe(false);
    await wait();
    expect((await placedAfter(c, { type: 'teleport', position: { x: 24, y: 5, z: 24 }, yaw: 0 })).accepted).toBe(false);
    await wait();
    expect((await placedAfter(c, { type: 'teleport', position: { x: 63, y: 0, z: 63 }, yaw: 0 })).accepted).toBe(false);
    await wait();
    expect((await placedAfter(c, { type: 'teleport', position: { x: 20, y: 0, z: -3 }, yaw: 0 })).accepted).toBe(false);
    await wait();
    // On top of the block is fine.
    const top = await placedAfter(c, { type: 'teleport', position: { x: 31, y: 2.1, z: 31 }, yaw: 0 });
    expect(top).toMatchObject({ accepted: true, position: { y: 2 } });
  }, 15_000);

  it('lands a built world’s teleport on its navigation mesh, and nowhere else', async () => {
    const walkable = await testSurface();
    try {
      const udp = await start({ world: { size: 40 }, spawnPoints: [{ x: 10, y: 0, z: 10, yaw: 0, group: 'start', main: true }], walkable });
      const c = await connect(udp);
      await c.next('snapshot', (s) => s.correction?.seq === 0);
      const on = await placedAfter(c, { type: 'teleport', position: { x: 14, y: 0.3, z: 12 }, yaw: 0 });
      expect(on.accepted).toBe(true);
      // On the mesh, which lies within a cell height (0.1 m) of the floor.
      expect(Math.abs(on.position.y)).toBeLessThanOrEqual(0.11);
      await new Promise((r) => setTimeout(r, 1050));
      expect((await placedAfter(c, { type: 'teleport', position: { x: 14, y: 4, z: 12 }, yaw: 0 })).accepted).toBe(false);
    } finally {
      walkable.dispose();
    }
  });

  it('lets a flying world take a spot in the air', async () => {
    const udp = await start({ world: { size: 64, solids, flying: true }, spawnPoints });
    const c = await connect(udp);
    await c.next('snapshot', (s) => s.correction?.seq === 0);
    expect((await placedAfter(c, { type: 'teleport', position: { x: 24, y: 6, z: 24 }, yaw: 0 })).accepted).toBe(true);
  });
});
