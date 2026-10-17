// SPDX-License-Identifier: MPL-2.0
// Roles and build rights (S3.06, Q-M7): the owner from the token gives admin and lower, an admin
// only lower roles, a moderator none, nobody touches the owner; roles are in the roster and stay in
// the world's database; a builder's new build is checked and put in place, a visitor's refused, a
// piece that does not match its hash or a build missing a file refused.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeColliders } from '@flatchat/content';
import { decodeMessage, encodeMessage, type Message, type MessageName, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { builtOptions, can, DEFAULT_SERVER, RIGHTS, WorldServer, type WorldServerOptions } from '../src/server.ts';
import { ContentServer, loadBuiltWorld } from '../src/world/content.ts';
import { WorldStore } from '../src/world/store.ts';
import { BuildUploads } from '../src/world/uploads.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let running: WorldServer[] = [];
afterEach(async () => {
  for (const s of running) await s.stop('test over');
  running = [];
});

async function start(extra: Partial<WorldServerOptions> = {}): Promise<UdpServer> {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, ...extra }, [udp]);
  server.start();
  running.push(server);
  return udp;
}

class Client {
  readonly got: Message[] = [];
  readonly account: string;
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>, account: string) {
    this.link = link;
    this.account = account;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
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
  /** The latest role the roster gave an account. */
  roleOf(account: string): string | undefined {
    let role: string | undefined;
    for (const m of this.got) if (m.type === 'roster') for (const p of m.players) if (p.account === account) role = p.role;
    return role;
  }
}

async function enter(udp: UdpServer, o: { owner?: boolean; account?: string; name?: string } = {}): Promise<Client> {
  const account = o.account ?? randomUUID();
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }), account);
  const token = await sealToken(
    { account, name: o.name ?? 'Ana', trust: 1, tester: false, emailVerified: true, under18: false, ageDays: 3, owner: o.owner ?? false, contact: 'everyone', friends: [], blocks: [] },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '', height: 0 });
  await c.next('welcome');
  return c;
}

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('roles', () => {
  it('rise along the list: build, then moderate, then give roles', () => {
    expect(can('visitor', 'build')).toBe(false);
    expect(can('builder', 'build')).toBe(true);
    expect(can('builder', 'moderate')).toBe(false);
    expect(can('moderator', 'moderate')).toBe(true);
    expect(can('moderator', 'roles')).toBe(false);
    expect(can('admin', 'roles')).toBe(true);
    expect(Object.keys(RIGHTS)).toEqual(['build', 'moderate', 'roles']);
  });

  it('are given by the owner and admins below their own, never over the owner, and kept by the world', async () => {
    const store = WorldStore.open(':memory:', 'reset');
    const udp = await start({ store });
    const owner = await enter(udp, { owner: true, name: 'Owner' });
    const ana = await enter(udp, { name: 'Ana' });
    const bo = await enter(udp, { name: 'Bo' });
    const cy = await enter(udp, { name: 'Cy' });
    await settle();
    expect(bo.roleOf(owner.account)).toBe('owner');
    expect(bo.roleOf(ana.account)).toBe('visitor');

    owner.send({ type: 'role', account: ana.account, role: 'admin' });
    await settle();
    expect(cy.roleOf(ana.account)).toBe('admin');
    // An admin gives the roles below its own, and nothing over the owner or another admin.
    ana.send({ type: 'role', account: bo.account, role: 'admin' });
    ana.send({ type: 'role', account: owner.account, role: 'visitor' });
    ana.send({ type: 'role', account: bo.account, role: 'moderator' });
    await settle();
    expect(cy.roleOf(bo.account)).toBe('moderator');
    expect(cy.roleOf(owner.account)).toBe('owner');
    // A moderator gives none; nobody makes another owner; nobody changes their own role.
    bo.send({ type: 'role', account: cy.account, role: 'builder' });
    owner.send({ type: 'role', account: cy.account, role: 'owner' });
    ana.send({ type: 'role', account: ana.account, role: 'visitor' });
    await settle();
    expect(owner.roleOf(cy.account)).toBe('visitor');
    expect(owner.roleOf(ana.account)).toBe('admin');
    // The owner takes a role back.
    owner.send({ type: 'role', account: ana.account, role: 'visitor' });
    await settle();
    expect(cy.roleOf(ana.account)).toBe('visitor');
    expect(store.roles()).toEqual([{ account: bo.account, role: 'moderator' }]);
    store.close();
  });

  it('come back with the account after the world restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-roles-'));
    dirs.push(dir);
    const file = join(dir, 'world.db');
    const account = randomUUID();
    let store = WorldStore.open(file, 'reset');
    let udp = await start({ store });
    const owner = await enter(udp, { owner: true });
    owner.send({ type: 'role', account, role: 'builder' });
    await settle();
    for (const s of running) await s.stop('restart');
    running = [];
    store.close();
    // A reset world forgets its state, never its roles.
    store = WorldStore.open(file, 'reset');
    udp = await start({ store });
    const back = await enter(udp, { account });
    await settle();
    expect(back.roleOf(account)).toBe('builder');
    store.close();
  });
});

/** A small built world (the converter's layout), named `name`, with an optional extra scene. */
function built(name: string, extra?: Uint8Array): { dir: string; files: Map<string, Uint8Array> } {
  const dir = mkdtempSync(join(tmpdir(), 'fc-build-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'content'));
  const scene = new Uint8Array(40_000).map((_, i) => (i * 7) & 255);
  const collision = encodeColliders([{ type: 'box', position: [10, -0.5, 10], rotation: [0, 0, 0, 1], half: [10, 0.5, 10] }]);
  const parts = [
    { bytes: scene, kind: 'scene' },
    { bytes: collision, kind: 'collision' },
    ...(extra ? [{ bytes: extra, kind: 'scene' }] : []),
  ];
  const files = new Map<string, Uint8Array>();
  for (const f of parts) {
    writeFileSync(join(dir, 'content', sha(f.bytes)), f.bytes);
    files.set(`content/${sha(f.bytes)}`, f.bytes);
  }
  const world = {
    format: 1,
    manifest: { format: 1, name, description: '', capacity: { recommended: 4, maximum: 6 }, persistence: 'reset', flying: false, avatars: { minHeight: 0.5, maxHeight: 3 }, voice: { range: 25 }, scenes: [{ id: 'main', file: 'main.glb' }] },
    scenes: [{ id: 'main', glb: sha(extra ?? scene), spawns: [{ position: [5, 0, 6], yaw: 1, title: '', group: '' }], seats: [], portals: [], zones: [], emitters: [], triangles: 2 }],
    collision: sha(collision),
    bounds: { min: [0, -100, 0], max: [20, 500, 20] },
    files: parts.map((f) => ({ hash: sha(f.bytes), size: f.bytes.length, kind: f.kind })),
  };
  const json = new TextEncoder().encode(JSON.stringify(world));
  writeFileSync(join(dir, 'world.json'), json);
  files.set('world.json', json);
  return { dir, files };
}

/** Sends one file in pieces and waits for the world to hold all of it (or to refuse). */
async function putFile(c: Client, bytes: Uint8Array, hash = createHash('sha256').update(bytes).digest()): Promise<void> {
  for (let offset = 0; offset < bytes.length || offset === 0; ) {
    const data = bytes.subarray(offset, offset + 16_384);
    c.send({ type: 'put', hash, offset, total: bytes.length, data });
    offset += data.length;
    if (bytes.length === 0) break;
  }
  await c.next('got', (g) => Buffer.from(g.hash).equals(hash) && g.offset === bytes.length);
}

async function serveBuilt(dir: string, onPublished: (w: { name: string; files: number }) => void): Promise<UdpServer> {
  const loaded = await loadBuiltWorld(dir);
  return start({ ...builtOptions(loaded, new ContentServer(loaded)), uploads: new BuildUploads(dir), onPublished });
}

describe('new builds', () => {
  it('come from a builder, are checked, and replace the built folder; a visitor’s are refused', async () => {
    const before = built('Before');
    let published: { name: string; files: number } | undefined;
    const udp = await serveBuilt(before.dir, (w) => (published = w));
    const owner = await enter(udp, { owner: true });
    const bo = await enter(udp, { name: 'Bo' });
    const visitor = await enter(udp, { name: 'Vi' });

    visitor.send({ type: 'put', hash: new Uint8Array(32), offset: 0, total: 4, data: new Uint8Array(4) });
    expect(await visitor.next('published')).toEqual({ type: 'published', ok: false, detail: 'only a builder, an admin or the owner may change this world' });

    owner.send({ type: 'role', account: bo.account, role: 'builder' });
    await settle();
    // The new build shares two files with the old one and brings one of its own.
    const after = built('After', new Uint8Array(20_000).fill(9));
    for (const [path, bytes] of after.files) if (path !== 'world.json' && !before.files.has(path)) await putFile(bo, bytes);
    const json = after.files.get('world.json')!;
    await putFile(bo, json);
    bo.send({ type: 'publish', world: createHash('sha256').update(json).digest() });
    expect(await bo.next('published', () => true, 10_000)).toEqual({ type: 'published', ok: true, detail: '' });
    expect(published).toEqual({ name: 'After', files: 4 });
    expect((await loadBuiltWorld(before.dir)).world.manifest.name).toBe('After');
    expect(existsSync(`${before.dir}.incoming`)).toBe(false);
    expect(existsSync(`${before.dir}.next`)).toBe(false);
  });

  it('refuses a piece that does not match its hash, and a build that lacks a file', async () => {
    const before = built('Before');
    const udp = await serveBuilt(before.dir, () => {
      throw new Error('nothing should be published');
    });
    const owner = await enter(udp, { owner: true });
    const wrong = new Uint8Array(100).fill(1);
    owner.send({ type: 'put', hash: new Uint8Array(32).fill(2), offset: 0, total: wrong.length, data: wrong });
    expect((await owner.next('published')).detail).toMatch(/does not match its hash/);

    // world.json names a scene nobody sent.
    const after = built('After', new Uint8Array(500).fill(3));
    const json = after.files.get('world.json')!;
    await putFile(owner, json);
    owner.send({ type: 'publish', world: createHash('sha256').update(json).digest() });
    const verdict = await owner.next('published', () => true, 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/was neither uploaded nor already here/);
    expect((await loadBuiltWorld(before.dir)).world.manifest.name).toBe('Before');
  });
});
