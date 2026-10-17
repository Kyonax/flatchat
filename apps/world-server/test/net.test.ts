// SPDX-License-Identifier: MPL-2.0
// The two transports: raw UDP with our own encryption (its session tested over a simulated lossy
// wire, then the real handshake on loopback) and WebRTC data channels on loopback.
import { randomBytes } from 'node:crypto';
import type { Channel } from '@flatchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRtc, RtcServer } from '../src/net/rtc.ts';
import type { Link } from '../src/net/types.ts';
import { connectUdp, UdpServer, UdpSession } from '../src/net/udp.ts';

type Got = Array<[Channel, Buffer]>;

/** Two sessions joined by an in-memory wire that can drop, duplicate or tamper with datagrams. */
function wire(options: { drop?: (n: number) => boolean; tamper?: (n: number) => boolean; duplicate?: boolean } = {}) {
  const c2s = randomBytes(32);
  const s2c = randomBytes(32);
  let sent = 0;
  const queue: Array<() => void> = [];
  const deliver = (to: () => UdpSession) => (packet: Buffer) => {
    const n = sent++;
    if (options.drop?.(n)) return;
    const copy = Buffer.from(packet);
    if (options.tamper?.(n)) copy[copy.length - 20]! ^= 0x40;
    queue.push(() => to().receive(copy, performance.now()));
    if (options.duplicate) queue.push(() => to().receive(Buffer.from(copy), performance.now()));
  };
  const client: UdpSession = new UdpSession('server', deliver(() => server), c2s, s2c, performance.now());
  const server: UdpSession = new UdpSession('client', deliver(() => client), s2c, c2s, performance.now());
  const gotClient: Got = [];
  const gotServer: Got = [];
  client.onMessage((ch, b) => gotClient.push([ch, Buffer.from(b)]));
  server.onMessage((ch, b) => gotServer.push([ch, Buffer.from(b)]));
  /** Delivers queued datagrams and services both ends, as time passes. */
  const run = async (ms: number): Promise<void> => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      while (queue.length > 0) queue.shift()!();
      const now = performance.now();
      client.service(now);
      server.service(now);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  return { client, server, gotClient, gotServer, run };
}

describe('the raw UDP session', () => {
  it('carries both channels, encrypted, in order on the reliable one', async () => {
    const w = wire();
    for (let i = 0; i < 50; i++) w.client.send('reliable', Buffer.from([i]));
    w.client.send('unreliable', Buffer.from('hello'));
    await w.run(60);
    expect(w.gotServer.filter(([ch]) => ch === 'reliable').map(([, b]) => b[0])).toEqual([...Array(50).keys()]);
    expect(w.gotServer.filter(([ch]) => ch === 'unreliable').map(([, b]) => b.toString())).toEqual(['hello']);
  });

  it('reassembles a reliable message much larger than a datagram', async () => {
    const w = wire();
    const big = randomBytes(40_000);
    w.server.send('reliable', big);
    await w.run(80);
    expect(w.gotClient).toHaveLength(1);
    expect(w.gotClient[0]?.[1].equals(big)).toBe(true);
  });

  it('delivers every reliable message through 20% loss, in order', async () => {
    const w = wire({ drop: () => Math.random() < 0.2 });
    for (let i = 0; i < 200; i++) w.client.send('reliable', Buffer.from(`m${i}`));
    await w.run(3000);
    expect(w.gotServer.map(([, b]) => b.toString())).toEqual(Array.from({ length: 200 }, (_, i) => `m${i}`));
    expect(w.client.stats().retransmits).toBeGreaterThan(0);
  });

  it('drops tampered and replayed datagrams', async () => {
    const w = wire({ tamper: (n) => n === 0, duplicate: true });
    w.client.send('unreliable', Buffer.from('a'));
    w.client.send('unreliable', Buffer.from('b'));
    await w.run(30);
    expect(w.gotServer.map(([, b]) => b.toString())).toEqual(['b']);
  });

  it('closes both ends with the reason, and times out a silent peer', async () => {
    const w = wire();
    let reason = '';
    w.server.onClose((r) => {
      reason = r;
    });
    w.client.close('bye');
    await w.run(20);
    expect(reason).toBe('peer: bye');
    const quiet = wire({ drop: () => true });
    let timedOut = '';
    quiet.client.onClose((r) => {
      timedOut = r;
    });
    quiet.client.service(performance.now() + 11_000);
    expect(timedOut).toBe('timeout');
  });
});

const open: Array<{ close(): Promise<void> }> = [];
const links: Link[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) link.close('test over');
  for (const server of open.splice(0)) await server.close();
});

async function echo(serverLinks: Promise<Link>, client: Link): Promise<Got> {
  const got: Got = [];
  const server = await serverLinks;
  links.push(server);
  server.onMessage((ch, b) => server.send(ch, b));
  client.onMessage((ch, b) => got.push([ch, Buffer.from(b)]));
  client.send('reliable', Buffer.from('ping'));
  client.send('unreliable', Buffer.from('pong'));
  client.send('reliable', randomBytes(30_000));
  for (let i = 0; i < 100 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  return got;
}

describe('the transports on loopback', () => {
  it('raw UDP: handshake, both channels, a large reliable message', async () => {
    const server = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
    open.push(server);
    const accepted = new Promise<Link>((resolve) => server.onLink(resolve));
    const client = await connectUdp({ host: '127.0.0.1', port: server.port });
    links.push(client);
    const got = await echo(accepted, client);
    expect(got.map(([ch, b]) => [ch, b.length])).toEqual(
      expect.arrayContaining([
        ['reliable', 4],
        ['unreliable', 4],
        ['reliable', 30_000],
      ]),
    );
    expect(server.sessionCount).toBe(1);
  });

  it('WebRTC data channels: signaling, one shared ICE port, both channels', async () => {
    const icePort = 40_000 + Math.floor(Math.random() * 20_000);
    const server = await RtcServer.listen({ icePort, signalPort: 0, host: '127.0.0.1', iceBind: '127.0.0.1' });
    open.push(server);
    const accepted = new Promise<Link>((resolve) => server.onLink(resolve));
    const client = await connectRtc({ signalUrl: `http://127.0.0.1:${server.port}/rtc`, iceBind: '127.0.0.1' });
    links.push(client);
    const got = await echo(accepted, client);
    expect(got.map(([ch, b]) => [ch, b.length])).toEqual(
      expect.arrayContaining([
        ['reliable', 4],
        ['unreliable', 4],
        ['reliable', 30_000],
      ]),
    );
  }, 20_000);

  it('WebRTC signaling refuses a malformed offer', async () => {
    const server = await RtcServer.listen({ icePort: 40_000 + Math.floor(Math.random() * 20_000), signalPort: 0, host: '127.0.0.1' });
    open.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/rtc`, { method: 'POST', body: '{"type":"answer"}' });
    expect(res.status).toBe(400);
    expect(server.refused).toBe(1);
  });
});
