// SPDX-License-Identifier: MPL-2.0
// The in-process link of offline mode (S2.13): a world server and a player in one program.
import { randomUUID } from 'node:crypto';
import { decodeMessage, encodeMessage, type Message, messageDef, newWorldKey, PROTOCOL_VERSION, SCHEMA_FINGERPRINT, sealToken } from '@flatchat/protocol';
import { describe, expect, it } from 'vitest';
import { LocalTransport } from '../src/net/local.ts';
import { DEFAULT_SERVER, WorldServer } from '../src/server.ts';

describe('the local link', () => {
  it('joins a world server in the same program, both ways, and ends on either side', async () => {
    const key = newWorldKey();
    const worldId = randomUUID();
    const transport = new LocalTransport();
    const server = new WorldServer({ ...DEFAULT_SERVER, worldId, worldKey: key, metricsEverySec: 0, log: () => undefined }, [transport]);
    server.start();
    try {
      const got: Message[] = [];
      let ended = '';
      const link = transport.connect(
        (_channel, bytes) => got.push(decodeMessage(bytes, 'server')),
        (reason) => (ended = reason),
      );
      const token = await sealToken({ account: randomUUID(), name: 'Guest', trust: 0, tester: false, emailVerified: false, under18: false, ageDays: 0 }, { key, world: worldId, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      const hello: Message = { type: 'hello', protocol: PROTOCOL_VERSION, fingerprint: SCHEMA_FINGERPRINT, build: 'test', token, spawn: '', height: 0 };
      link.receive(messageDef('hello').channel, encodeMessage(hello));
      const until = async (what: (m: Message) => boolean): Promise<void> => {
        for (let i = 0; i < 100 && !got.some(what); i++) await new Promise((r) => setTimeout(r, 20));
      };
      await until((m) => m.type === 'snapshot');
      expect(got.map((m) => m.type)).toEqual(expect.arrayContaining(['welcome', 'roster', 'snapshot']));
      expect(server.players).toBe(1);
      expect(link.stats().receivedMessages.reliable).toBe(1);
      link.close('page left');
      expect(ended).toBe('page left');
      await new Promise((r) => setTimeout(r, 100));
      expect(server.players).toBe(0);
    } finally {
      await server.stop('test over');
    }
  });
});
