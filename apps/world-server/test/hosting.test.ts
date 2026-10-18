// SPDX-License-Identifier: MPL-2.0
// Hosting from home (S1.13): the port mapper's wire formats and its fallbacks against a fake
// router, the ICE servers' conversion, and the host channel's proof.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type Network, natPmpRequest, parseNatPmpMap, parsePcpMap, pcpMapRequest, PortMapper, soapBody } from '../src/net/portmap.ts';
import { CoreRelay, hostProof, hostUrl } from '../src/net/relay.ts';
import { toDatachannelIce } from '../src/net/rtc.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

describe('the wire formats', () => {
  it('NAT-PMP: a UDP mapping request, and its answer', () => {
    expect([...natPmpRequest(7778, 7778, 3600)]).toEqual([0, 1, 0, 0, 0x1e, 0x62, 0x1e, 0x62, 0, 0, 0x0e, 0x10]);
    const reply = Uint8Array.of(0, 129, 0, 0, 0, 0, 0, 9, 0x1e, 0x62, 0x1e, 0x63, 0, 0, 0x0e, 0x10);
    expect(parseNatPmpMap(reply)).toEqual({ result: 0, internal: 7778, external: 7779, lifetimeS: 3600 });
    expect(parseNatPmpMap(reply.slice(0, 10))).toBeUndefined();
  });

  it('PCP: a MAP request with its nonce, and an answer only for that nonce', () => {
    const nonce = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
    const req = pcpMapRequest(nonce, 7778, 7778, 3600, '192.168.1.20');
    expect(req.length).toBe(60);
    expect([req[0], req[1], req[18], req[19], req[20], req[23], req[36]]).toEqual([2, 1, 0xff, 0xff, 192, 20, 17]);
    expect([...req.subarray(24, 36)]).toEqual([...nonce]);
    const reply = new Uint8Array(req);
    reply[1] = 0x81;
    reply[3] = 0;
    reply.set([203, 0, 113, 7], 56);
    expect(parsePcpMap(reply, nonce)).toMatchObject({ result: 0, lifetimeS: 3600, external: 7778, address: '203.0.113.7' });
    expect(parsePcpMap(reply, new Uint8Array(12))).toBeUndefined();
  });

  it('UPnP: escapes every value in the SOAP body', () => {
    const body = soapBody('urn:schemas-upnp-org:service:WANIPConnection:1', 'AddPortMapping', { NewPortMappingDescription: '<x>&"' });
    expect(body).toContain('<NewPortMappingDescription>&#60;x&#62;&#38;&#34;</NewPortMappingDescription>');
  });
});

function fakeRouter(speaks: Array<'pcp' | 'natpmp' | 'upnp'>): Network & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    gateway: async () => '192.168.1.1',
    localAddress: () => '192.168.1.20',
    async ask(host, port, payload) {
      if (host === '239.255.255.250') {
        sent.push('ssdp');
        return speaks.includes('upnp') ? new TextEncoder().encode('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/desc.xml\r\n\r\n') : undefined;
      }
      if (port !== 5351) return undefined;
      if (payload[0] === 2) {
        sent.push(`pcp:${new DataView(payload.buffer).getUint32(4)}`);
        if (!speaks.includes('pcp')) return undefined;
        const r = new Uint8Array(payload);
        r[1] = 0x81;
        r[3] = 0;
        return r;
      }
      sent.push(`natpmp:${new DataView(payload.buffer).getUint32(8)}`);
      if (!speaks.includes('natpmp')) return undefined;
      // Version 0, opcode 129, result 0, an epoch, then the request's ports and lifetime echoed.
      const reply = new Uint8Array(16);
      reply[1] = 129;
      reply[7] = 1;
      reply.set(payload.subarray(4, 12), 8);
      return reply;
    },
    async fetch(url, init) {
      sent.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${init?.headers ? ` ${String((init.headers as Record<string, string>)['soapaction'])}` : ''}`);
      if (url.endsWith('/desc.xml')) {
        return new Response('<root><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></root>');
      }
      return new Response('<ok/>', { status: 200 });
    },
  };
}

describe('the port mapper', () => {
  const quiet = (): void => undefined;

  it('maps with PCP when the router speaks it, and removes the mapping with the same nonce', async () => {
    const net = fakeRouter(['pcp', 'natpmp']);
    const m = new PortMapper(7778, quiet, net);
    expect(await m.start()).toMatchObject({ protocol: 'pcp', internalPort: 7778, externalPort: 7778, lifetimeS: 3600 });
    await m.stop();
    expect(net.sent).toEqual(['pcp:3600', 'pcp:0']);
  });

  it('falls back to NAT-PMP, then to UPnP, and says when nothing answers', async () => {
    const pmp = fakeRouter(['natpmp']);
    expect(await new PortMapper(7778, quiet, pmp).start()).toMatchObject({ protocol: 'natpmp', externalPort: 7778 });
    const upnp = fakeRouter(['upnp']);
    const mapper = new PortMapper(7778, quiet, upnp);
    expect(await mapper.start()).toMatchObject({ protocol: 'upnp', externalPort: 7778 });
    await mapper.stop();
    expect(upnp.sent.filter((s) => s.startsWith('POST'))).toEqual([
      'POST /ctl "urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"',
      'POST /ctl "urn:schemas-upnp-org:service:WANIPConnection:1#DeletePortMapping"',
    ]);
    const lines: unknown[] = [];
    expect(await new PortMapper(7778, (e, f) => lines.push([e, f]), fakeRouter([])).start()).toBeUndefined();
    expect(lines).toEqual([['port-map', { ok: false, why: 'the router answered none of PCP, NAT-PMP or UPnP' }]]);
  });
});

describe('ICE servers and the host channel', () => {
  it('turns the browser form into node-datachannel’s, keeping TURN usernames with colons', () => {
    expect(
      toDatachannelIce([
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349', 'turn:turn.example.org?transport=tcp', 'http://nope'], username: '1800000000:acct', credential: 'pw' },
      ]),
    ).toEqual([
      'stun:stun.cloudflare.com:3478',
      { hostname: 'turn.example.org', port: 3478, relayType: 'TurnUdp', username: '1800000000:acct', password: 'pw' },
      { hostname: 'turn.example.org', port: 5349, relayType: 'TurnTls', username: '1800000000:acct', password: 'pw' },
      { hostname: 'turn.example.org', port: 3478, relayType: 'TurnTcp', username: '1800000000:acct', password: 'pw' },
    ]);
  });

  it('proves the world key with an HMAC of the core’s nonce, at the core’s host address', () => {
    const key = new Uint8Array(32).fill(7);
    expect(hostProof(key, 'n0nce')).toBe(createHmac('sha256', key).update('flatchat host v1 n0nce').digest('base64url'));
    expect(hostUrl('https://core.example.org', 'w')).toBe('wss://core.example.org/api/v1/worlds/w/host');
    expect(hostUrl('http://127.0.0.1:8787/', 'w')).toBe('ws://127.0.0.1:8787/api/v1/worlds/w/host');
  });

  it('answers relayed offers and takes the core’s ICE servers', async () => {
    const sent: string[] = [];
    const listeners: Record<string, (ev: { data?: unknown; code?: number; reason?: string }) => void> = {};
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (d: string) => sent.push(d),
      close: () => undefined,
      addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
        listeners[type] = fn;
      },
    } as unknown as WebSocket;
    let ice: unknown;
    const removed: string[][] = [];
    const relay = new CoreRelay({
      core: 'http://127.0.0.1:1',
      worldId: 'w',
      worldKey: new Uint8Array(32),
      rtc: { answer: async (sdp) => ({ type: 'answer', sdp: `answer to ${sdp}` }), setIceServers: (s) => (ice = s) },
      onRemoved: (m) => removed.push(m),
      log: () => undefined,
      socketFactory: () => socket,
    });
    relay.start();
    listeners['message']!({ data: JSON.stringify({ type: 'challenge', nonce: 'abc' }) });
    listeners['message']!({ data: JSON.stringify({ type: 'welcome' }) });
    listeners['message']!({ data: JSON.stringify({ type: 'ice', iceServers: [{ urls: 'stun:x:1' }, 'junk'] }) });
    listeners['message']!({ data: JSON.stringify({ type: 'offer', id: 'o1', sdp: 'v=0' }) });
    listeners['message']!({ data: JSON.stringify({ type: 'removed', manifests: ['ab'.repeat(32), 'junk', 7] }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(relay.online).toBe(true);
    expect(ice).toEqual([{ urls: 'stun:x:1' }]);
    expect(removed).toEqual([['ab'.repeat(32)]]);
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'auth', proof: hostProof(new Uint8Array(32), 'abc') },
      { type: 'answer', id: 'o1', sdp: 'answer to v=0' },
    ]);
    relay.stop();
  });

  it('reports its players for the world browser, takes the approved capacity, and refuses offers when not relayed', () => {
    vi.useFakeTimers();
    try {
      const sent: Array<Record<string, unknown>> = [];
      const listeners: Record<string, (ev: { data?: unknown }) => void> = {};
      const socket = {
        OPEN: 1,
        readyState: 1,
        send: (d: string) => sent.push(JSON.parse(d) as Record<string, unknown>),
        close: () => undefined,
        addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
          listeners[type] = fn;
        },
      } as unknown as WebSocket;
      let players = 0;
      let approved = 0;
      const relay = new CoreRelay({
        core: 'http://127.0.0.1:1',
        worldId: 'w',
        worldKey: new Uint8Array(32),
        status: () => ({ players, recommended: 3, maximum: 5 }),
        onLimits: (m) => (approved = m),
        log: () => undefined,
        socketFactory: () => socket,
      });
      relay.start();
      listeners['message']!({ data: JSON.stringify({ type: 'challenge', nonce: 'n' }) });
      listeners['message']!({ data: JSON.stringify({ type: 'welcome' }) });
      listeners['message']!({ data: JSON.stringify({ type: 'limits', maximum: 4 }) });
      expect(approved).toBe(4);
      const statuses = (): Array<Record<string, unknown>> => sent.filter((m) => m['type'] === 'status');
      expect(statuses()).toEqual([{ type: 'status', players: 0, recommended: 3, maximum: 5 }]);
      // Nothing new while nothing changes; a change goes out within a second.
      vi.advanceTimersByTime(3000);
      expect(statuses()).toHaveLength(1);
      players = 2;
      vi.advanceTimersByTime(1000);
      expect(statuses().at(-1)).toEqual({ type: 'status', players: 2, recommended: 3, maximum: 5 });
      // And at least every 15 seconds, so the core never shows a stale count for long.
      vi.advanceTimersByTime(15_000);
      expect(statuses()).toHaveLength(3);
      // A world reached at its own address answers no relayed offer.
      listeners['message']!({ data: JSON.stringify({ type: 'offer', id: 'o1', sdp: 'v=0' }) });
      expect(sent.at(-1)).toEqual({ type: 'error', id: 'o1', error: 'this world takes no relayed offers' });
      relay.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the platform revokes the world (S3.12)', () => {
    const listeners: Record<string, (ev: { data?: unknown }) => void> = {};
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, fn: (ev: { data?: unknown }) => void) => {
        listeners[type] = fn;
      },
    } as unknown as WebSocket;
    const logged: string[] = [];
    let revoked = 0;
    const relay = new CoreRelay({ core: 'http://127.0.0.1:1', worldId: 'w', worldKey: new Uint8Array(32), onRevoked: () => (revoked += 1), log: (e) => void logged.push(e), socketFactory: () => socket });
    relay.start();
    listeners['message']!({ data: JSON.stringify({ type: 'welcome' }) });
    listeners['message']!({ data: JSON.stringify({ type: 'revoked' }) });
    expect(revoked).toBe(1);
    expect(logged).toContain('world-revoked');
    relay.stop();
  });

  it('takes no more players than the core approved', () => {
    const server = new WorldServer({ ...DEFAULT_SERVER, worldId: '00000000-0000-4000-8000-000000000001', worldKey: undefined, log: () => undefined, capacity: 10, recommended: 7 }, []);
    expect([server.capacity, server.recommended]).toEqual([10, 7]);
    server.setApprovedCapacity(5);
    expect([server.capacity, server.recommended]).toEqual([5, 5]);
    server.setApprovedCapacity(0);
    expect(server.capacity).toBe(5);
  });
});
