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
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

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

async function token(options: { world?: string; expiresAt?: number; nonce?: Uint8Array; name?: string } = {}): Promise<Uint8Array> {
  return sealToken(
    { account: randomUUID(), name: options.name ?? 'bot', trust: 1, tester: true, emailVerified: true, under18: false, ageDays: 3 },
    { key: KEY, world: options.world ?? WORLD, expiresAt: options.expiresAt ?? NOW + 60, ...(options.nonce ? { nonce: options.nonce } : {}) },
  );
}

async function connect(udp: UdpServer, hello: Partial<MessageOf<'hello'>> = {}): Promise<Client> {
  const client = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }));
  clients.push(client);
  client.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token: hello.token ?? (await token()), ...hello });
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
