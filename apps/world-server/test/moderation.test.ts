// SPDX-License-Identifier: MPL-2.0
// Moderation in one world (S3.07): kicks, bans and mutes from a moderator over someone below them,
// each with the reason the player is told and a line in the world's record; mutes and bans outlast
// a rejoin; nobody acts on the owner, even while it is away; a ban reversed on appeal is lifted.
import { randomUUID } from 'node:crypto';
import { decodeMessage, encodeMessage, type Message, type MessageName, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';
import { WorldStore } from '../src/world/store.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const mouth = { aa: 1, ih: 2, ou: 3, ee: 4, oh: 5, level: 9 };

let running: Array<{ server: WorldServer; store: WorldStore }> = [];
afterEach(async () => {
  for (const r of running) {
    await r.server.stop('test over');
    r.store.close();
  }
  running = [];
});

async function start(): Promise<{ udp: UdpServer; server: WorldServer; store: WorldStore }> {
  const store = WorldStore.open(':memory:', 'reset');
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  // Everyone within a few metres, inside the voice range.
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, store, spawn: { x: 20, z: 20, r: 3 } }, [udp]);
  server.start();
  running.push({ server, store });
  return { udp, server, store };
}

class Client {
  readonly got: Message[] = [];
  readonly account: string;
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  entity = -1;
  closed = false;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>, account: string) {
    this.link = link;
    this.account = account;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
    link.onClose(() => (this.closed = true));
  }
  send(m: Message): void {
    this.link.send(messageDef(m.type).channel, encodeMessage(m));
  }
  async next<K extends MessageName>(type: K, where: (m: MessageOf<K>) => boolean = () => true, ms = 3000): Promise<MessageOf<K>> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.got.findIndex((x) => x.type === type && where(x as MessageOf<K>));
      if (i >= 0) return this.got.splice(i, 1)[0] as MessageOf<K>;
      if (Date.now() > end) throw new Error(`no ${type}; got ${this.got.map((x) => x.type).join(', ')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Joins, or is refused: `welcome` is waited for only when `joins` is true. */
async function enter(udp: UdpServer, o: { owner?: boolean; account?: string; name?: string } = {}, joins = true): Promise<Client> {
  const account = o.account ?? randomUUID();
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }), account);
  const token = await sealToken(
    { account, name: o.name ?? 'Ana', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 3, owner: o.owner ?? false, contact: 'everyone', friends: [], blocks: [] },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '', height: 0 });
  if (joins) c.entity = (await c.next('welcome')).entity;
  return c;
}

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
const act = (account: string, action: MessageOf<'moderate'>['action'], reason = 'for the test', minutes = 0): Message => ({ type: 'moderate', account, action, minutes, reason });

describe('moderation in a world', () => {
  it('lets a moderator kick someone below it, with the reason told and recorded, and nobody else', async () => {
    const { udp, store } = await start();
    const owner = await enter(udp, { owner: true });
    const mod = await enter(udp, { name: 'Mod' });
    const admin = await enter(udp, { name: 'Ad' });
    const vi = await enter(udp, { name: 'Vi' });
    owner.send({ type: 'role', account: mod.account, role: 'moderator' });
    owner.send({ type: 'role', account: admin.account, role: 'admin' });
    await settle();
    // Not over an admin or the owner; not without a reason; not from a visitor.
    mod.send(act(admin.account, 'kick'));
    mod.send(act(owner.account, 'kick'));
    mod.send(act(vi.account, 'kick', '  '));
    vi.send(act(mod.account, 'kick'));
    await settle();
    expect([admin.closed, owner.closed, vi.closed, mod.closed]).toEqual([false, false, false, false]);
    mod.send(act(vi.account, 'kick', 'Spamming the stage'));
    expect(await vi.next('leave')).toMatchObject({ reason: 'kicked', detail: 'Spamming the stage' });
    expect(store.moderationLog()).toEqual([expect.objectContaining({ actor: mod.account, target: vi.account, action: 'kick', reason: 'Spamming the stage' })]);
  });

  it('bans with the reason given at every later try, until a moderator or an appeal lifts it', async () => {
    const { udp, server } = await start();
    const owner = await enter(udp, { owner: true });
    const vi = await enter(udp, { name: 'Vi' });
    owner.send(act(vi.account, 'ban', 'Harassment', 60 * 24));
    expect(await vi.next('leave')).toMatchObject({ reason: 'banned', detail: 'Harassment' });
    const again = await enter(udp, { account: vi.account }, false);
    expect(await again.next('refuse')).toMatchObject({ reason: 'banned', detail: 'Harassment' });
    owner.send(act(vi.account, 'unban', ''));
    await settle();
    await enter(udp, { account: vi.account });
    // Banned again, then lifted by the world's owner on appeal, through the core.
    owner.send(act(vi.account, 'ban', 'Again'));
    await settle();
    server.liftBanOnAppeal(vi.account);
    await enter(udp, { account: vi.account });
  });

  it('mutes: no voice forwarded, the player told why, still muted after coming back, until lifted', async () => {
    const { udp } = await start();
    const owner = await enter(udp, { owner: true });
    const vi = await enter(udp, { name: 'Vi' });
    owner.send(act(vi.account, 'mute', 'Shouting'));
    expect(await vi.next('muted')).toEqual({ type: 'muted', on: true, reason: 'Shouting' });
    vi.send({ type: 'voice', seq: 1, start: true, mouth, opus: new Uint8Array(40) });
    await settle(200);
    expect(owner.got.some((m) => m.type === 'voiceBundle')).toBe(false);
    vi.link.close('bye');
    await settle();
    const back = await enter(udp, { account: vi.account });
    expect(await back.next('muted')).toMatchObject({ on: true, reason: 'Shouting' });
    owner.send(act(vi.account, 'unmute', ''));
    expect(await back.next('muted')).toEqual({ type: 'muted', on: false, reason: '' });
    back.send({ type: 'voice', seq: 2, start: true, mouth, opus: new Uint8Array(40) });
    await owner.next('voiceBundle');
  });

  it('never bans the owner, even while it is away', async () => {
    const { udp } = await start();
    const owner = await enter(udp, { owner: true });
    const admin = await enter(udp, { name: 'Ad' });
    owner.send({ type: 'role', account: admin.account, role: 'admin' });
    await settle();
    owner.link.close('away');
    await settle();
    admin.send(act(owner.account, 'ban', 'Taking over'));
    await settle();
    await enter(udp, { owner: true, account: owner.account });
  });
});
