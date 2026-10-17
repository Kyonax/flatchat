// SPDX-License-Identifier: MPL-2.0
// The world's voice rules (S3.08): a stage zone carries a voice farther and louder, and its frames
// say so; a quiet zone silences voice both ways; a private zone keeps voice among those inside;
// plugins set a player's range and gain; a minor's voice never carries past the world's defaults.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuiltZone } from '@flatchat/content';
import { decodeMessage, encodeMessage, type Message, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { Plugins } from '../src/plugins.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const mouth = { aa: 1, ih: 2, ou: 3, ee: 4, oh: 5, level: 9 };
const box = (x: number, z: number): Pick<BuiltZone, 'center' | 'half' | 'yaw'> => ({ center: [x, 0, z], half: [3, 2, 3], yaw: 0 });
const ZONES: BuiltZone[] = [
  { kind: 'voice', range: 60, gain: 2, ...box(10, 10) },
  { kind: 'quiet', ...box(30, 10) },
  { kind: 'private', ...box(50, 10) },
];
const at = (group: string, x: number, z: number) => ({ x, y: 0, z, yaw: 0, group });
const SPAWNS = [at('stage', 10, 10), at('floor', 10, 40), at('quiet', 30, 10), at('near-quiet', 30, 18), at('room', 50, 10), at('door', 50, 16), { ...at('', 70, 70), main: true }];

let running: Array<{ server: WorldServer; plugins?: Plugins }> = [];
afterEach(async () => {
  for (const r of running) {
    r.plugins?.close();
    await r.server.stop('test over');
  }
  running = [];
});

async function start(pluginsDir?: string): Promise<UdpServer> {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {}, world: { size: 100 }, zones: ZONES, spawnPoints: SPAWNS }, [udp]);
  let plugins: Plugins | undefined;
  if (pluginsDir) {
    plugins = new Plugins(server, () => {});
    await plugins.load([pluginsDir]);
    server.usePlugins(plugins);
  }
  server.start();
  running.push({ server, ...(plugins ? { plugins } : {}) });
  return udp;
}

class Client {
  readonly got: Message[] = [];
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  entity = -1;
  seq = 0;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>) {
    this.link = link;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
  }
  send(m: Message): void {
    this.link.send(messageDef(m.type).channel, encodeMessage(m));
  }
  speak(): void {
    this.seq += 1;
    this.send({ type: 'voice', seq: this.seq, start: this.seq === 1, mouth, opus: new Uint8Array(40).fill(this.entity) });
  }
  /** The frames heard from a speaker so far. */
  heard(from: number): Array<MessageOf<'voiceBundle'>['frames'][number]> {
    return this.got.flatMap((m) => (m.type === 'voiceBundle' ? m.frames.filter((f) => f.from === from) : []));
  }
}

async function enter(udp: UdpServer, spawn: string, o: { name?: string; under18?: boolean } = {}): Promise<Client> {
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }));
  const token = await sealToken(
    { account: randomUUID(), name: o.name ?? spawn, trust: 1, tester: false, emailVerified: true, under18: o.under18 ?? false, ageDays: 9, owner: false, contact: o.under18 ? 'friends' : 'everyone', friends: [], blocks: [] },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn, height: 0 });
  for (let i = 0; i < 200 && c.entity < 0; i++) {
    const w = c.got.find((m): m is MessageOf<'welcome'> => m.type === 'welcome');
    if (w) c.entity = w.entity;
    else await new Promise((r) => setTimeout(r, 10));
  }
  if (c.entity < 0) throw new Error(`no welcome for ${spawn}`);
  return c;
}

/** Everyone speaks a few frames, then the test reads who heard whom. */
async function talk(...speakers: Client[]): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (const s of speakers) s.speak();
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
}

describe('the world’s voice rules', () => {
  it('carry a stage farther and louder, and say so in each frame', async () => {
    const udp = await start();
    const singer = await enter(udp, 'stage');
    const far = await enter(udp, 'floor');
    await talk(singer);
    const frames = far.heard(singer.entity);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ gain: 128, range: 60 });
    // From the floor, 30 m out, an ordinary voice does not carry to the stage.
    await talk(far);
    expect(singer.heard(far.entity)).toEqual([]);
  });

  it('silence a quiet zone both ways, and keep a private zone’s voice inside it', async () => {
    const udp = await start();
    const quiet = await enter(udp, 'quiet');
    const nearQuiet = await enter(udp, 'near-quiet');
    const roomA = await enter(udp, 'room');
    const roomB = await enter(udp, 'room');
    const door = await enter(udp, 'door');
    await talk(quiet, nearQuiet, roomA, door);
    expect(nearQuiet.heard(quiet.entity)).toEqual([]);
    expect(quiet.heard(nearQuiet.entity)).toEqual([]);
    expect(roomB.heard(roomA.entity).length).toBeGreaterThan(0);
    expect(door.heard(roomA.entity)).toEqual([]);
    expect(roomB.heard(door.entity)).toEqual([]);
  });

  it('take a player’s range and gain from a plugin, and keep a minor’s within the defaults', async () => {
    const udp = await start(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins-voice'));
    const whisper = await enter(udp, 'floor', { name: 'Whisper' });
    const shout = await enter(udp, 'floor', { name: 'Shout' });
    const listener = await enter(udp, 'stage', { name: 'Listener' });
    const young = await enter(udp, 'stage', { name: 'Young', under18: true });
    await talk(whisper, shout, young);
    // The stage is 30 m from the floor: a whisper does not reach it, a shout does.
    expect(listener.heard(whisper.entity)).toEqual([]);
    expect(listener.heard(shout.entity)[0]).toMatchObject({ gain: 128, range: 80 });
    // On the stage, a minor's voice keeps the world's range and gain.
    expect(listener.heard(young.entity)[0]).toMatchObject({ gain: 64, range: 0 });
    expect(shout.heard(young.entity)).toEqual([]);
  });
});
