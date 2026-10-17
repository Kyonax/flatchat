// SPDX-License-Identifier: MPL-2.0
// What a network census means (spike S0.10): from the raw answers of two STUN servers, the
// router's own external address (UPnP or NAT-PMP) and the machine's addresses, decide whether a
// player behind this network can host a world. Pure. The report keeps derived facts only, never
// the tester's public address: what the owner needs is "CGNAT or not, per ISP".
import type { Mapped } from './stun';

export type Mapping = 'none' | 'endpoint-independent' | 'endpoint-dependent' | 'unknown' | 'blocked';

export interface CensusInputs {
  /** What each STUN server saw of the same local socket. */
  stun: Array<Mapped | undefined>;
  /** The router's external IPv4, from UPnP or NAT-PMP. */
  routerExternal?: string;
  /** This machine's own addresses. */
  local: string[];
  upnp: boolean;
  natpmp: boolean;
  pcp: boolean;
  /** A reply over IPv6 from a STUN server, if one came. */
  stunV6?: Mapped;
}

export interface CensusVerdict {
  mapping: Mapping;
  /** True when the router's own external address is private or shared (100.64.0.0/10), or differs from the public one. */
  cgnat: boolean | null;
  portMapping: { upnp: boolean; natpmp: boolean; pcp: boolean };
  ipv6: { global: boolean; reachable: boolean };
  /** One line for the host: can players reach a world on this network? */
  canHost: 'direct' | 'with-port-mapping' | 'hole-punching' | 'relay-only';
}

function v4(address: string): number[] | undefined {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
}

/** RFC 1918 private ranges and RFC 6598 shared address space (carrier-grade NAT). */
export function isPrivateOrShared(address: string): boolean {
  const p = v4(address);
  if (!p) return false;
  const [a = 0, b = 0] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function isGlobalIpv6(address: string): boolean {
  const first = Number.parseInt(address.split(':')[0] ?? '', 16);
  return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff;
}

export function classify(i: CensusInputs): CensusVerdict {
  const seen = i.stun.filter((m): m is Mapped => m !== undefined && m.family === 'IPv4');
  let mapping: Mapping;
  if (seen.length === 0) mapping = 'blocked';
  else if (seen.some((m) => i.local.includes(m.address))) mapping = 'none';
  else if (seen.length < 2) mapping = 'unknown';
  else mapping = seen.every((m) => m.port === seen[0]!.port && m.address === seen[0]!.address) ? 'endpoint-independent' : 'endpoint-dependent';

  const publicV4 = seen[0]?.address;
  let cgnat: boolean | null = null;
  if (i.routerExternal) cgnat = isPrivateOrShared(i.routerExternal) || (publicV4 !== undefined && publicV4 !== i.routerExternal);
  else if (mapping === 'none') cgnat = false;

  const canMap = (i.upnp || i.natpmp || i.pcp) && cgnat === false;
  const canHost =
    mapping === 'none' ? 'direct' : canMap ? 'with-port-mapping' : mapping === 'endpoint-independent' ? 'hole-punching' : 'relay-only';

  return {
    mapping,
    cgnat,
    portMapping: { upnp: i.upnp, natpmp: i.natpmp, pcp: i.pcp },
    ipv6: { global: i.local.some(isGlobalIpv6), reachable: i.stunV6 !== undefined },
    canHost,
  };
}

/** The ISP's name from the reverse DNS of the public address (for example "etb.net.co"), never the address. */
export function ispFromPtr(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return undefined;
  // Keep the registrable part: two labels, or three under a two-letter country with a second level (net.co, com.co).
  const second = labels.at(-2) ?? '';
  const keep = (labels.at(-1)?.length ?? 0) === 2 && ['net', 'com', 'org', 'gov', 'edu', 'co'].includes(second) ? 3 : 2;
  return labels.slice(-keep).join('.');
}
