// SPDX-License-Identifier: MPL-2.0
// The network census's probes (spike S0.10), run by the client's main process with --census. All
// of them only ask; none changes the router: two public STUN servers from one local socket (how the
// NAT maps us), STUN over IPv6, UPnP's GetExternalIPAddress, NAT-PMP's external-address request and
// a PCP ANNOUNCE (does the router speak them), and the reverse DNS of the public address (the ISP's
// name). What a router answers is untrusted: only fixed fields are read, with patterns, never run.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { lookup, reverse } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { classify, type CensusVerdict, ispFromPtr } from './classify';
import { bindingRequest, type Mapped, parseBindingResponse } from './stun';

export const STUN_SERVERS = [
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.l.google.com', port: 19302 },
];
const TIMEOUT_MS = 2500;

export interface CensusReport extends CensusVerdict {
  isp?: string;
  platform: string;
  /** Seconds the probes took. */
  seconds: number;
  notes: string[];
}

function stunQuery(socket: Socket, host: string, port: number): Promise<Mapped | undefined> {
  return new Promise((resolve) => {
    const id = randomBytes(12);
    const onMessage = (msg: Buffer): void => {
      const mapped = parseBindingResponse(msg, id);
      if (mapped) done(mapped);
    };
    const timer = setTimeout(() => done(undefined), TIMEOUT_MS);
    function done(v: Mapped | undefined): void {
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(v);
    }
    socket.on('message', onMessage);
    socket.send(bindingRequest(id), port, host, (err) => {
      if (err) done(undefined);
    });
  });
}

async function stunFromOneSocket(family: 'udp4' | 'udp6'): Promise<Array<Mapped | undefined>> {
  const socket = createSocket(family);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => resolve());
    });
    const out: Array<Mapped | undefined> = [];
    for (const s of STUN_SERVERS) {
      try {
        const { address } = await lookup(s.host, { family: family === 'udp4' ? 4 : 6 });
        out.push(await stunQuery(socket, address, s.port));
      } catch {
        out.push(undefined);
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    socket.close();
  }
}

/** The default IPv4 gateway: /proc/net/route on Linux, PowerShell on Windows. */
async function gateway(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const route = await readFile('/proc/net/route', 'utf8');
      for (const line of route.split('\n').slice(1)) {
        const [, destination, gw] = line.trim().split(/\s+/);
        if (destination === '00000000' && gw && gw !== '00000000') {
          const n = Number.parseInt(gw, 16);
          return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        }
      }
    } else if (process.platform === 'win32') {
      const out = await new Promise<string>((resolve) =>
        execFile('powershell', ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop'], { timeout: 8000 }, (_e, stdout) => resolve(String(stdout).trim())),
      );
      return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : undefined;
    }
  } catch {
    // no gateway found
  }
  return undefined;
}

function udpAsk(host: string, port: number, payload: Uint8Array, accept: (msg: Buffer) => boolean): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);
    function finish(v: Buffer | undefined): void {
      clearTimeout(timer);
      socket.close();
      resolve(v);
    }
    socket.on('error', () => finish(undefined));
    socket.on('message', (msg) => {
      if (accept(msg)) finish(msg);
    });
    socket.send(payload, port, host);
  });
}

/** NAT-PMP (RFC 6886): the external address the router reports, if it speaks NAT-PMP. */
async function natPmp(gw: string): Promise<string | undefined> {
  const reply = await udpAsk(gw, 5351, Uint8Array.of(0, 0), (m) => m.length >= 12 && m[0] === 0 && m[1] === 128);
  if (!reply || reply.readUInt16BE(2) !== 0) return undefined;
  return [reply[8], reply[9], reply[10], reply[11]].join('.');
}

/** PCP (RFC 6887): does the router answer an ANNOUNCE request in version 2? */
async function pcp(gw: string, local: string | undefined): Promise<boolean> {
  const req = new Uint8Array(24);
  req[0] = 2;
  req[1] = 0;
  if (local) {
    req[18] = 0xff;
    req[19] = 0xff;
    local.split('.').forEach((p, k) => {
      req[20 + k] = Number(p);
    });
  }
  const reply = await udpAsk(gw, 5351, req, (m) => m.length >= 24 && m[0] === 2 && m[1] === 0x80);
  return reply !== undefined;
}

/** UPnP IGD: discover the router over SSDP and ask its GetExternalIPAddress. */
async function upnp(): Promise<string | 'found' | undefined> {
  const search = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n',
  );
  const answer = await udpAsk('239.255.255.250', 1900, search, (m) => /^HTTP\/1\.1 200/i.test(m.toString('latin1')) && /location:/i.test(m.toString('latin1')));
  const location = answer?.toString('latin1').match(/^location:\s*(http:\/\/[^\s]+)\s*$/im)?.[1];
  if (!location) return undefined;
  try {
    const url = new URL(location);
    if (!/^(10|172|192|100)\./.test(url.hostname)) return undefined;
    const description = await (await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).text();
    const service = description.match(/<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/);
    if (!service) return 'found';
    const [, type, control] = service;
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="${type}"/></s:Body></s:Envelope>`;
    const res = await fetch(new URL(control!, url), {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${type}#GetExternalIPAddress"` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ip = (await res.text()).match(/<NewExternalIPAddress>(\d+\.\d+\.\d+\.\d+)<\/NewExternalIPAddress>/)?.[1];
    return ip ?? 'found';
  } catch {
    return 'found';
  }
}

export async function runCensus(): Promise<CensusReport> {
  const started = performance.now();
  const notes: string[] = [];
  const local = Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => n !== undefined && !n.internal)
    .map((n) => n.address);
  const [stun4, stun6, gw, upnpAnswer] = await Promise.all([stunFromOneSocket('udp4'), stunFromOneSocket('udp6'), gateway(), upnp()]);
  const localV4 = local.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const [pmp, pcpOk] = gw ? await Promise.all([natPmp(gw), pcp(gw, localV4)]) : [undefined, false];
  if (!gw) notes.push('no default gateway found');
  const routerExternal = (typeof upnpAnswer === 'string' && upnpAnswer !== 'found' ? upnpAnswer : undefined) ?? pmp;
  const verdict = classify({
    stun: stun4,
    ...(routerExternal ? { routerExternal } : {}),
    local,
    upnp: upnpAnswer !== undefined,
    natpmp: pmp !== undefined,
    pcp: pcpOk,
    ...(stun6.find((m) => m?.family === 'IPv6') ? { stunV6: stun6.find((m) => m?.family === 'IPv6')! } : {}),
  });
  let isp: string | undefined;
  const publicV4 = stun4.find((m) => m?.family === 'IPv4')?.address;
  if (publicV4) {
    try {
      isp = ispFromPtr((await reverse(publicV4))[0]);
    } catch {
      notes.push('the public address has no reverse DNS name');
    }
  }
  return { ...verdict, ...(isp ? { isp } : {}), platform: process.platform, seconds: Math.round((performance.now() - started) / 100) / 10, notes };
}
