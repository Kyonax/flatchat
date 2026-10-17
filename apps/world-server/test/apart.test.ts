// SPDX-License-Identifier: MPL-2.0
// Keeping players apart (S3.11, S3.10): a block, from the token or made during the visit, hides each
// side from the other (the `hidden` list) and stops voice and chat both ways; a player aged 13 to 17
// is reached only by its accepted friends, unless its guardian widened it, whatever a plugin says.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessage, encodeMessage, type Message, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { Plugins } from '../src/plugins.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const mouth = { aa: 1, ih: 2, ou: 3, ee: 4, oh: 5, level: 9 };

let running: Array<{ server: WorldServer; plugins?: Plugins }> = [];
afterEach(async () => {
  for (const r of running) {
    r.plugins?.close();
    await r.server.stop('test over');
  }
  running = [];
});

async function start(plugins = false): Promise<UdpServer> {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, spawn: { x: 20, z: 20, r: 3 } }, [udp]);
  let p: Plugins | undefined;
  if (plugins) {
    p = new Plugins(server, () => {});
    await p.load([join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins-voice')]);
    server.usePlugins(p);
  }
  server.start();
  running.push({ server, ...(p ? { plugins: p } : {}) });
  return udp;
}

class Client {
  readonly got: Message[] = [];
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  readonly account: string;
  entity = -1;
  seq = 0;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>, account: string) {
    this.link = link;
    this.account = account;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
  }
  send(m: Message): void {
    this.link.send(messageDef(m.type).channel, encodeMessage(m));
  }
  speak(): void {
    this.seq += 1;
    this.send({ type: 'voice', seq: this.seq, start: this.seq === 1, mouth, opus: new Uint8Array(30) });
  }
  heard(from: Client): number {
    return this.got.reduce((n, m) => n + (m.type === 'voiceBundle' ? m.frames.filter((f) => f.from === from.entity).length : 0), 0);
  }
  read(from: Client): string[] {
    return this.got.flatMap((m) => (m.type === 'chat' && m.from === from.entity ? [m.text] : []));
  }
  hidden(): number[] | undefined {
    return this.got.filter((m): m is MessageOf<'hidden'> => m.type === 'hidden').at(-1)?.entities;
  }
}

interface Facts {
  name?: string;
  under18?: boolean;
  contact?: 'everyone' | 'friends' | 'none';
  friends?: string[];
  blocks?: string[];
  account?: string;
}

async function enter(udp: UdpServer, f: Facts = {}): Promise<Client> {
  const account = f.account ?? randomUUID();
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }), account);
  const token = await sealToken(
    { account, name: f.name ?? 'P', trust: 1, tester: false, emailVerified: true, under18: f.under18 ?? false, ageDays: 9, owner: false, contact: f.contact ?? (f.under18 ? 'friends' : 'everyone'), friends: f.friends ?? [], blocks: f.blocks ?? [] },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '', height: 0 });
  for (let i = 0; i < 200 && c.entity < 0; i++) {
    const w = c.got.find((m): m is MessageOf<'welcome'> => m.type === 'welcome');
    if (w) c.entity = w.entity;
    else await new Promise((r) => setTimeout(r, 10));
  }
  return c;
}

async function exchange(...people: Client[]): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (const p of people) p.speak();
    await new Promise((r) => setTimeout(r, 25));
  }
  for (const p of people) p.send({ type: 'say', text: `hello from ${p.entity}` });
  await new Promise((r) => setTimeout(r, 200));
}

describe('a block', () => {
  it('from the token hides each side from the other and stops voice and chat both ways', async () => {
    const udp = await start();
    const bo = await enter(udp);
    const ana = await enter(udp, { blocks: [bo.account] });
    const cy = await enter(udp);
    await exchange(ana, bo, cy);
    expect(ana.hidden()).toEqual([bo.entity]);
    expect(bo.hidden()).toEqual([ana.entity]);
    expect(cy.hidden()).toBeUndefined();
    expect([ana.heard(bo), bo.heard(ana), ana.read(bo).length, bo.read(ana).length]).toEqual([0, 0, 0, 0]);
    expect(cy.heard(ana)).toBeGreaterThan(0);
    expect(cy.read(bo)).toEqual([`hello from ${bo.entity}`]);
  });

  it('made during the visit counts at once, and an unblock lifts it', async () => {
    const udp = await start();
    const ana = await enter(udp);
    const bo = await enter(udp);
    ana.send({ type: 'block', account: bo.account, on: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(bo.hidden()).toEqual([ana.entity]);
    await exchange(ana, bo);
    expect([ana.heard(bo), bo.heard(ana)]).toEqual([0, 0]);
    ana.send({ type: 'block', account: bo.account, on: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(ana.hidden()).toEqual([]);
    await exchange(ana, bo);
    expect(bo.heard(ana)).toBeGreaterThan(0);
  });
});

describe('a player aged 13 to 17', () => {
  it('is reached by its accepted friends only, both ways, whatever a plugin sets', async () => {
    const udp = await start(true);
    const friend = await enter(udp, { name: 'Friend' });
    const stranger = await enter(udp, { name: 'Shout' });
    const teen = await enter(udp, { name: 'Teen', under18: true, friends: [friend.account] });
    await exchange(teen, friend, stranger);
    expect(teen.heard(friend)).toBeGreaterThan(0);
    expect(friend.heard(teen)).toBeGreaterThan(0);
    expect(teen.read(friend)).toEqual([`hello from ${friend.entity}`]);
    expect([teen.heard(stranger), stranger.heard(teen), teen.read(stranger).length, stranger.read(teen).length]).toEqual([0, 0, 0, 0]);
    // The stranger and the friend still hear each other.
    expect(friend.heard(stranger)).toBeGreaterThan(0);
  });

  it('is reached by everyone when its guardian widened it, and by nobody when narrowed', async () => {
    const udp = await start();
    const someone = await enter(udp);
    const open = await enter(udp, { under18: true, contact: 'everyone' });
    const closed = await enter(udp, { under18: true, contact: 'none', friends: [someone.account] });
    await exchange(someone, open, closed);
    expect(open.heard(someone)).toBeGreaterThan(0);
    expect([closed.heard(someone), someone.heard(closed)]).toEqual([0, 0]);
  });
});
