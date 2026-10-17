// SPDX-License-Identifier: MPL-2.0
// The network census's pure parts: STUN messages, the verdict, the ISP's name.
import { describe, expect, it } from 'vitest';
import { classify, isPrivateOrShared, ispFromPtr } from '../src/main/census/classify';
import { bindingRequest, parseBindingResponse } from '../src/main/census/stun';

const ID = Uint8Array.from({ length: 12 }, (_, i) => i + 1);

/** A binding success with XOR-MAPPED-ADDRESS 203.0.113.7:54321, as a server would send it. */
function response(id = ID): Uint8Array {
  const out = new Uint8Array(32);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x0101);
  v.setUint16(2, 12);
  v.setUint32(4, 0x2112a442);
  out.set(id, 8);
  v.setUint16(20, 0x0020);
  v.setUint16(22, 8);
  out[25] = 0x01;
  v.setUint16(26, 54321 ^ 0x2112);
  [203, 0, 113, 7].forEach((b, k) => {
    out[28 + k] = b ^ [0x21, 0x12, 0xa4, 0x42][k]!;
  });
  return out;
}

describe('STUN', () => {
  it('writes a binding request with the magic cookie', () => {
    const req = bindingRequest(ID);
    expect([...req.subarray(0, 8)]).toEqual([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]);
    expect([...req.subarray(8)]).toEqual([...ID]);
  });

  it('reads the XOR-mapped address of its own transaction only', () => {
    expect(parseBindingResponse(response(), ID)).toEqual({ family: 'IPv4', address: '203.0.113.7', port: 54321 });
    expect(parseBindingResponse(response(), new Uint8Array(12))).toBeUndefined();
    expect(parseBindingResponse(new Uint8Array(10), ID)).toBeUndefined();
  });
});

describe('the verdict', () => {
  const at = (address: string, port: number) => ({ family: 'IPv4' as const, address, port });
  it('names the NAT mapping from two servers', () => {
    expect(classify({ stun: [at('203.0.113.7', 5000), at('203.0.113.7', 5000)], local: ['192.168.1.5'], upnp: false, natpmp: false, pcp: false }).mapping).toBe('endpoint-independent');
    expect(classify({ stun: [at('203.0.113.7', 5000), at('203.0.113.7', 5001)], local: ['192.168.1.5'], upnp: false, natpmp: false, pcp: false }).mapping).toBe('endpoint-dependent');
    expect(classify({ stun: [undefined, undefined], local: [], upnp: false, natpmp: false, pcp: false }).mapping).toBe('blocked');
    expect(classify({ stun: [at('203.0.113.7', 5000)], local: ['203.0.113.7'], upnp: false, natpmp: false, pcp: false })).toMatchObject({ mapping: 'none', cgnat: false, canHost: 'direct' });
  });

  it('finds carrier-grade NAT from the router\'s own external address', () => {
    const behind = classify({ stun: [at('203.0.113.7', 5000), at('203.0.113.7', 5000)], routerExternal: '100.70.1.2', local: ['192.168.1.5'], upnp: true, natpmp: false, pcp: false });
    expect(behind).toMatchObject({ cgnat: true, canHost: 'hole-punching' });
    const home = classify({ stun: [at('203.0.113.7', 5000), at('203.0.113.7', 5000)], routerExternal: '203.0.113.7', local: ['192.168.1.5'], upnp: true, natpmp: false, pcp: false });
    expect(home).toMatchObject({ cgnat: false, canHost: 'with-port-mapping' });
    expect(isPrivateOrShared('100.64.0.1')).toBe(true);
    expect(isPrivateOrShared('100.128.0.1')).toBe(false);
  });

  it('keeps only the ISP\'s name from the reverse DNS', () => {
    expect(ispFromPtr('dynamic-ip-181-50-1-2.cable.net.co')).toBe('cable.net.co');
    expect(ispFromPtr('static.etb.net.co.')).toBe('etb.net.co');
    expect(ispFromPtr('host-1-2-3-4.example.com')).toBe('example.com');
    expect(ispFromPtr(undefined)).toBeUndefined();
  });
});
