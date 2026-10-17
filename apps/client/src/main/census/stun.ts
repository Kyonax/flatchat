// SPDX-License-Identifier: MPL-2.0
// STUN binding requests and responses (RFC 5389), the minimum the network census needs: ask a
// public STUN server which address and port our packet came from. Pure encoding and parsing; the
// socket work is in probe.ts.

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;

export interface Mapped {
  family: 'IPv4' | 'IPv6';
  address: string;
  port: number;
}

/** A binding request with this 12-byte transaction id. */
export function bindingRequest(transactionId: Uint8Array): Uint8Array {
  if (transactionId.length !== 12) throw new RangeError('a STUN transaction id is 12 bytes');
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  view.setUint16(0, BINDING_REQUEST);
  view.setUint16(2, 0);
  view.setUint32(4, MAGIC);
  out.set(transactionId, 8);
  return out;
}

function ipv6(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  return parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

/** The mapped address of a binding success response for `transactionId`, or undefined. */
export function parseBindingResponse(packet: Uint8Array, transactionId: Uint8Array): Mapped | undefined {
  if (packet.length < 20) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint16(0) !== BINDING_SUCCESS || view.getUint32(4) !== MAGIC) return undefined;
  for (let i = 0; i < 12; i++) if (packet[8 + i] !== transactionId[i]) return undefined;
  const length = view.getUint16(2);
  let at = 20;
  let plain: Mapped | undefined;
  while (at + 4 <= Math.min(packet.length, 20 + length)) {
    const type = view.getUint16(at);
    const size = view.getUint16(at + 2);
    const value = packet.subarray(at + 4, at + 4 + size);
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && value.length >= 8) {
      const family = value[1] === 0x01 ? 'IPv4' : value[1] === 0x02 ? 'IPv6' : undefined;
      if (family) {
        const xor = type === XOR_MAPPED_ADDRESS;
        const port = (((value[2] ?? 0) << 8) | (value[3] ?? 0)) ^ (xor ? MAGIC >>> 16 : 0);
        const raw = value.subarray(4, family === 'IPv4' ? 8 : 20);
        const key = new Uint8Array(16);
        new DataView(key.buffer).setUint32(0, MAGIC);
        key.set(transactionId, 4);
        const addr = raw.map((b, k) => (xor ? b ^ (key[k] ?? 0) : b));
        const mapped: Mapped = { family, address: family === 'IPv4' ? [...addr].join('.') : ipv6(addr), port };
        if (xor) return mapped;
        plain = mapped;
      }
    }
    at += 4 + size + ((4 - (size % 4)) % 4);
  }
  return plain;
}
