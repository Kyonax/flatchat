// SPDX-License-Identifier: MPL-2.0
// Asking the home router to forward the world's UDP port (S1.13, DR-08): PCP (RFC 6887) first, then
// NAT-PMP (RFC 6886), then UPnP IGD's AddPortMapping. It maps only the world's own port, only on the
// gateway the default route names, renews the lease at half its life, and removes the mapping when
// the world stops. It changes the host's router, so it runs only with --map-port.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

export type MapProtocol = 'pcp' | 'natpmp' | 'upnp';

export interface Mapping {
  protocol: MapProtocol;
  internalPort: number;
  externalPort: number;
  /** The router's public address, when it said. */
  externalAddress?: string;
  lifetimeS: number;
}

const TIMEOUT_MS = 2000;
const LIFETIME_S = 3600;

// ------------------------------------------------------------------ the wire formats (pure)

/** NAT-PMP: map a UDP port (opcode 1). Lifetime 0 with external 0 removes it. */
export function natPmpRequest(internal: number, external: number, lifetimeS: number): Uint8Array {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  b[0] = 0;
  b[1] = 1;
  v.setUint16(4, internal);
  v.setUint16(6, external);
  v.setUint32(8, lifetimeS);
  return b;
}

export function parseNatPmpMap(reply: Uint8Array): { result: number; internal: number; external: number; lifetimeS: number } | undefined {
  if (reply.length < 16 || reply[0] !== 0 || reply[1] !== 129) return undefined;
  const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  return { result: v.getUint16(2), internal: v.getUint16(8), external: v.getUint16(10), lifetimeS: v.getUint32(12) };
}

/** An IPv4 address as PCP's 16-byte IPv4-mapped form. */
function mapped(ipv4: string | undefined): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  (ipv4 ?? '0.0.0.0').split('.').forEach((p, i) => {
    out[12 + i] = Number(p) & 255;
  });
  return out;
}

/** PCP MAP for UDP: a 24-byte header and 36 bytes of MAP data. */
export function pcpMapRequest(nonce: Uint8Array, internal: number, external: number, lifetimeS: number, client: string | undefined): Uint8Array {
  const b = new Uint8Array(60);
  const v = new DataView(b.buffer);
  b[0] = 2;
  b[1] = 1;
  v.setUint32(4, lifetimeS);
  b.set(mapped(client), 8);
  b.set(nonce.subarray(0, 12), 24);
  b[36] = 17;
  v.setUint16(40, internal);
  v.setUint16(42, external);
  b.set(mapped(undefined), 44);
  return b;
}

export function parsePcpMap(reply: Uint8Array, nonce: Uint8Array): { result: number; lifetimeS: number; external: number; address: string } | undefined {
  if (reply.length < 60 || reply[0] !== 2 || reply[1] !== 0x81) return undefined;
  for (let i = 0; i < 12; i++) if (reply[24 + i] !== nonce[i]) return undefined;
  const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  return { result: reply[3]!, lifetimeS: v.getUint32(4), external: v.getUint16(42), address: [reply[56], reply[57], reply[58], reply[59]].join('.') };
}

const xml = (s: string): string => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function soapBody(type: string, action: 'AddPortMapping' | 'DeletePortMapping', args: Record<string, string | number>): string {
  const fields = Object.entries(args)
    .map(([k, v]) => `<${k}>${xml(String(v))}</${k}>`)
    .join('');
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${xml(type)}">${fields}</u:${action}></s:Body></s:Envelope>`;
}

// ------------------------------------------------------------------------ the network

export interface Network {
  /** The default IPv4 gateway. */
  gateway(): Promise<string | undefined>;
  /** This machine's IPv4 address toward that gateway. */
  localAddress(gateway: string): string | undefined;
  ask(host: string, port: number, payload: Uint8Array, accept: (m: Uint8Array) => boolean): Promise<Uint8Array | undefined>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** The default IPv4 gateway: /proc/net/route on Linux, PowerShell on Windows. */
export async function defaultGateway(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
        const [, destination, gw] = line.trim().split(/\s+/);
        if (destination === '00000000' && gw && gw !== '00000000') {
          const n = Number.parseInt(gw, 16);
          return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        }
      }
    } else if (process.platform === 'win32') {
      const out = await new Promise<string>((resolve) =>
        execFile('powershell', ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop'], { timeout: 8000 }, (_e, stdout) =>
          resolve(String(stdout).trim()),
        ),
      );
      return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : undefined;
    }
  } catch {
    // none found
  }
  return undefined;
}

export const SYSTEM_NETWORK: Network = {
  gateway: defaultGateway,
  localAddress(gateway: string): string | undefined {
    const prefix = gateway.split('.').slice(0, 3).join('.');
    const all = Object.values(networkInterfaces())
      .flat()
      .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal);
    return (all.find((a) => a.address.startsWith(`${prefix}.`)) ?? all[0])?.address;
  },
  ask(host, port, payload, accept) {
    return new Promise((resolve) => {
      const socket = createSocket('udp4');
      const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);
      function finish(v: Uint8Array | undefined): void {
        clearTimeout(timer);
        socket.close();
        resolve(v);
      }
      socket.on('error', () => finish(undefined));
      socket.on('message', (m) => {
        if (accept(m)) finish(new Uint8Array(m));
      });
      socket.send(payload, port, host);
    });
  },
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS * 2) }),
};

// --------------------------------------------------------------------------- the mapper

async function viaPcp(net: Network, gw: string, local: string | undefined, port: number, lifetimeS: number, nonce: Uint8Array): Promise<Mapping | undefined> {
  const reply = await net.ask(gw, 5351, pcpMapRequest(nonce, port, port, lifetimeS, local), (m) => m.length >= 60 && m[0] === 2 && m[1] === 0x81);
  const r = reply ? parsePcpMap(reply, nonce) : undefined;
  if (!r || r.result !== 0) return undefined;
  return { protocol: 'pcp', internalPort: port, externalPort: r.external, externalAddress: r.address, lifetimeS: r.lifetimeS };
}

async function viaNatPmp(net: Network, gw: string, port: number, lifetimeS: number): Promise<Mapping | undefined> {
  const reply = await net.ask(gw, 5351, natPmpRequest(port, port, lifetimeS), (m) => m.length >= 16 && m[0] === 0 && m[1] === 129);
  const r = reply ? parseNatPmpMap(reply) : undefined;
  if (!r || r.result !== 0) return undefined;
  return { protocol: 'natpmp', internalPort: port, externalPort: r.external, lifetimeS: r.lifetimeS };
}

interface Igd {
  control: string;
  type: string;
}

async function findIgd(net: Network): Promise<Igd | undefined> {
  const search = new TextEncoder().encode('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
  const text = (m: Uint8Array): string => new TextDecoder('latin1').decode(m);
  const answer = await net.ask('239.255.255.250', 1900, search, (m) => /^HTTP\/1\.1 200/i.test(text(m)) && /location:/i.test(text(m)));
  const location = answer ? text(answer).match(/^location:\s*(http:\/\/[^\s]+)\s*$/im)?.[1] : undefined;
  if (!location) return undefined;
  const url = new URL(location);
  // Only a router on the local network: never an address an answer could point elsewhere.
  if (!/^(10|172|192)\./.test(url.hostname)) return undefined;
  const description = await (await net.fetch(url.href)).text();
  const service = description.match(/<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/);
  if (!service) return undefined;
  const control = new URL(service[2]!, url);
  if (control.hostname !== url.hostname) return undefined;
  return { control: control.href, type: service[1]! };
}

async function soap(net: Network, igd: Igd, action: 'AddPortMapping' | 'DeletePortMapping', args: Record<string, string | number>): Promise<boolean> {
  const res = await net.fetch(igd.control, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${igd.type}#${action}"` },
    body: soapBody(igd.type, action, args),
  });
  return res.ok;
}

async function viaUpnp(net: Network, local: string | undefined, port: number, lifetimeS: number): Promise<{ mapping: Mapping; igd: Igd } | undefined> {
  if (!local) return undefined;
  const igd = await findIgd(net);
  if (!igd) return undefined;
  const ok = await soap(net, igd, 'AddPortMapping', {
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: 'UDP',
    NewInternalPort: port,
    NewInternalClient: local,
    NewEnabled: 1,
    NewPortMappingDescription: 'FlatChat world',
    NewLeaseDuration: lifetimeS,
  });
  return ok ? { mapping: { protocol: 'upnp', internalPort: port, externalPort: port, lifetimeS }, igd } : undefined;
}

/** Maps the port, keeps it mapped, and removes it at stop(). */
export class PortMapper {
  private readonly net: Network;
  private readonly port: number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private igd: Igd | undefined;
  private gw: string | undefined;
  /** PCP renews and removes a mapping by the nonce that made it (RFC 6887, section 11.1). */
  private readonly nonce = new Uint8Array(randomBytes(12));
  mapping: Mapping | undefined;

  constructor(port: number, log: (event: string, fields?: Record<string, unknown>) => void, net: Network = SYSTEM_NETWORK) {
    this.port = port;
    this.log = log;
    this.net = net;
  }

  async start(): Promise<Mapping | undefined> {
    this.gw = await this.net.gateway();
    if (!this.gw) {
      this.log('port-map', { ok: false, why: 'no default gateway' });
      return undefined;
    }
    await this.renew();
    return this.mapping;
  }

  private async renew(): Promise<void> {
    const gw = this.gw!;
    const local = this.net.localAddress(gw);
    let m = (await viaPcp(this.net, gw, local, this.port, LIFETIME_S, this.nonce)) ?? (await viaNatPmp(this.net, gw, this.port, LIFETIME_S));
    if (!m) {
      const u = await viaUpnp(this.net, local, this.port, LIFETIME_S).catch(() => undefined);
      if (u) {
        m = u.mapping;
        this.igd = u.igd;
      }
    }
    this.mapping = m;
    // The router's address is the host's own public address: logged as a fact about the mapping, never sent anywhere.
    this.log('port-map', m ? { ok: true, protocol: m.protocol, port: m.externalPort, lifetimeS: m.lifetimeS } : { ok: false, why: 'the router answered none of PCP, NAT-PMP or UPnP' });
    if (m) this.timer = setTimeout(() => void this.renew(), Math.max(60, m.lifetimeS / 2) * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const m = this.mapping;
    this.mapping = undefined;
    if (!m || !this.gw) return;
    try {
      if (m.protocol === 'natpmp') await this.net.ask(this.gw, 5351, natPmpRequest(this.port, 0, 0), () => true);
      else if (m.protocol === 'pcp') await this.net.ask(this.gw, 5351, pcpMapRequest(this.nonce, this.port, 0, 0, this.net.localAddress(this.gw)), () => true);
      else if (this.igd) await soap(this.net, this.igd, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: 'UDP' });
    } catch {
      // the lease ends by itself
    }
  }
}
