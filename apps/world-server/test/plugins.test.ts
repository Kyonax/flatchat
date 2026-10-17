// SPDX-License-Identifier: MPL-2.0
// The plugin loader and its hooks (S3.01): plugin.toml, loading and refusals, a working plugin's
// greeting, command, chat filter and store, an entry rule, a missing permission, a plugin
// switched off after too many errors, and async code (setup, a rejecting hook, a promised answer).
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessage, encodeMessage, type Message, type MessageName, type MessageOf, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectUdp, UdpServer } from '../src/net/udp.ts';
import { parseManifest, PluginError, Plugins } from '../src/plugins.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins');
const KEY = newWorldKey();
const WORLD = randomUUID();

describe('plugin.toml', () => {
  it('reads a good one and says what is wrong with a bad one', () => {
    const m = parseManifest('name = "door"\nversion = "1.2.3"\napi = 1\npermissions = ["chat"]\nhooks = ["on_join"]\n[settings]\nwelcome = "hi"\n');
    expect(m).toMatchObject({ name: 'door', version: '1.2.3', main: 'index.ts', permissions: ['chat'], hooks: ['on_join'], settings: { welcome: 'hi' } });
    for (const [text, why] of [
      ['name = "x"\nversion = "1.0.0"\napi = 2\n', /host interface 1/],
      ['name = "x"\nversion = "1"\napi = 1\n', /version/],
      ['name = "Door"\nversion = "1.0.0"\napi = 1\n', /name/],
      ['name = "x"\nversion = "1.0.0"\napi = 1\nhooks = ["on_explode"]\n', /unknown on_explode/],
      ['name = "x"\nversion = "1.0.0"\napi = 1\npermissions = ["root"]\n', /unknown root/],
      ['name = "x"\nversion = "1.0.0"\napi = 1\nhooks = ["on_chat"]\n', /on_chat needs the "chat" permission/],
      ['name = "x"\nversion = "1.0.0"\napi = 1\nmain = "../evil.ts"\n', /main/],
      ['name = = "x"', /does not parse/],
    ] as const) {
      expect(() => parseManifest(text)).toThrow(PluginError);
      expect(() => parseManifest(text)).toThrow(why);
    }
  });
});

let running: { server: WorldServer; udp: UdpServer; plugins: Plugins } | undefined;
afterEach(async () => {
  if (running) {
    running.plugins.close();
    await running.server.stop('test over');
  }
  running = undefined;
});

async function start(folders: string[]): Promise<{ udp: UdpServer; logs: Array<{ event: string; fields: Record<string, unknown> }>; plugins: Plugins }> {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}): void => void logs.push({ event, fields });
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  const server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log }, [udp]);
  const plugins = new Plugins(server, log);
  await plugins.load(folders.map((f) => join(FIXTURES, '..', f)));
  server.usePlugins(plugins);
  server.start();
  running = { server, udp, plugins };
  return { udp, logs, plugins };
}

class Client {
  readonly got: Message[] = [];
  readonly link: Awaited<ReturnType<typeof connectUdp>>;
  constructor(link: Awaited<ReturnType<typeof connectUdp>>) {
    this.link = link;
    link.onMessage((_c, bytes) => this.got.push(decodeMessage(bytes, 'server')));
  }
  send(m: Message): void {
    this.link.send(messageDef(m.type).channel, encodeMessage(m));
  }
  async next<K extends MessageName>(type: K, where: (m: MessageOf<K>) => boolean = () => true, ms = 2000): Promise<MessageOf<K>> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.got.find((x): x is MessageOf<K> => x.type === type && where(x as MessageOf<K>));
      if (m) return m;
      if (Date.now() > end) throw new Error(`no ${type}; got ${this.got.map((x) => x.type).join(', ')}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

async function enter(udp: UdpServer, claims: { account?: string; name?: string; tester?: boolean } = {}): Promise<Client> {
  const c = new Client(await connectUdp({ host: '127.0.0.1', port: udp.port }));
  const token = await sealToken(
    { account: claims.account ?? randomUUID(), name: claims.name ?? 'Ana', trust: 1, tester: claims.tester ?? false, emailVerified: true, under18: false, ageDays: 3 },
    { key: KEY, world: WORLD, expiresAt: Math.floor(Date.now() / 1000) + 60 },
  );
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '', height: 0 });
  return c;
}

describe('loading plugins', () => {
  it('loads a good plugin and refuses each broken one with a line saying why', async () => {
    const { logs, plugins } = await start(['plugins']);
    expect(plugins.names).toEqual(['greeter', 'no-permission', 'testers-only']);
    const refused = Object.fromEntries(logs.filter((l) => l.event === 'plugin-refused').map((l) => [l.fields['folder'], l.fields['why']]));
    expect(refused['bad-toml']).toMatch(/name/);
    expect(refused['setup-throws']).toMatch(/setup failed: no database configured/);
    expect(refused['undeclared']).toMatch(/on_tick but plugin.toml does not list it/);
    // A plugin may load without the permission it later tries to use: the call itself is refused.
    expect(refused['no-permission']).toBeUndefined();
  });
});

describe('the hooks', () => {
  it('greets with a visit count, answers a command, filters chat, and runs an entry rule', async () => {
    const { udp } = await start(['plugins']);
    // testers-only refuses anyone without the tester flag, with its own words.
    const outsider = await enter(udp, { tester: false });
    expect(await outsider.next('refuse')).toMatchObject({ reason: 'rule', detail: 'testers only today' });
    const account = randomUUID();
    const ana = await enter(udp, { account, name: 'Ana', tester: true });
    await ana.next('welcome');
    expect((await ana.next('chat', (m) => m.from === undefined)).text).toBe('Welcome, Ana (visit 1)');
    ana.send({ type: 'say', text: '/roll 4' });
    expect((await ana.next('chat', (m) => m.text.includes('rolled'))).text).toBe('Ana rolled 4');
    ana.send({ type: 'say', text: 'no spoiler here' });
    ana.send({ type: 'say', text: 'darn it' });
    const said = await ana.next('chat', (m) => m.from !== undefined);
    expect(said.text).toBe('d**n it');
    expect(ana.got.some((m) => m.type === 'chat' && m.text.includes('spoiler'))).toBe(false);
    // The store remembers the account: a second visit counts 2.
    ana.link.close('bye');
    await new Promise((r) => setTimeout(r, 200));
    const again = await enter(udp, { account, name: 'Ana', tester: true });
    expect((await again.next('chat', (m) => m.from === undefined)).text).toBe('Welcome, Ana (visit 2)');
  });

  it('refuses a call the plugin did not ask permission for, and switches off a plugin that keeps failing', async () => {
    const { udp, logs, plugins } = await start(['plugins']);
    const c = await enter(udp, { tester: true });
    await c.next('welcome');
    await new Promise((r) => setTimeout(r, 100));
    expect(logs.find((l) => l.event === 'plugin-error' && l.fields['name'] === 'no-permission')?.fields['why']).toMatch(/did not ask for the "moderation" permission/);
    // The player was not kicked.
    expect(c.got.some((m) => m.type === 'leave')).toBe(false);
    for (let i = 0; i < 25; i++) await enter(udp, { tester: true });
    await new Promise((r) => setTimeout(r, 600));
    expect(logs.some((l) => l.event === 'plugin-disabled' && l.fields['name'] === 'no-permission')).toBe(true);
    expect(plugins.names).not.toContain('no-permission');
  });
});

describe('async plugin code', () => {
  it('waits for an async setup, logs a rejected hook with the world going on, and refuses on a promised entry answer', async () => {
    const { udp, logs, plugins } = await start(['plugins-async']);
    expect(plugins.names).toEqual(['late']);
    const ana = await enter(udp, { name: 'Ana' });
    await ana.next('welcome');
    expect((await ana.next('chat', (m) => m.from === undefined)).text).toBe('ready for Ana');
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.find((l) => l.event === 'plugin-error' && l.fields['hook'] === 'on_join')?.fields['why']).toBe('nothing more for Ana');
    const late = await enter(udp, { name: 'Async' });
    expect(await late.next('refuse')).toMatchObject({ reason: 'rule', detail: 'the world’s entry rule failed' });
    expect(logs.find((l) => l.event === 'plugin-error' && l.fields['hook'] === 'on_join_request')?.fields['why']).toMatch(/answers at once/);
    // The world still takes players.
    await (await enter(udp, { name: 'Bo' })).next('welcome');
  });
});
