// SPDX-License-Identifier: MPL-2.0
// Outfits between real bots (S5.05): six bots join a world server over UDP and each puts on its own
// outfit; every bot's roster then shows every other's as the world fitted it (a prop's adjustment
// past the platform's limits clamped, an item worn twice kept once), and a bot joining later reads
// everyone's in its first roster.
import { randomUUID } from 'node:crypto';
import { newWorldKey } from '@flatchat/protocol';
import { UdpServer } from '@flatchat/world-server/net';
import { DEFAULT_SERVER, WorldServer } from '@flatchat/world-server/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bot, type WornItem } from '../src/bot.ts';
import { DEFAULT_BRAIN } from '../src/brain.ts';
import { waitFor } from '../src/procs.ts';

const KEY = newWorldKey();
const WORLD = randomUUID();
const BOTS = 6;
const bytes = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const hex = (b: number): string => b.toString(16).padStart(2, '0').repeat(32);

let server: WorldServer | undefined;
let port = 0;
const bots: Bot[] = [];
const accounts: string[] = [];
let ticker: ReturnType<typeof setInterval> | undefined;

async function enter(index: number): Promise<Bot> {
  accounts[index] = randomUUID();
  const b = new Bot({
    index,
    seed: 900 + index,
    account: accounts[index],
    target: { transport: 'udp', host: '127.0.0.1', udpPort: port, signalUrl: '', worldId: WORLD, worldKey: KEY },
    brain: { ...DEFAULT_BRAIN, size: 32, scenario: 'crowd' },
    voice: false,
    chat: false,
    still: true,
  });
  bots.push(b);
  await b.join();
  if (b.state !== 'joined') throw new Error(`bot ${index} did not join: ${b.refuseReason || b.lostReason}`);
  return b;
}

/** Bot i wears a garment of its own and a prop; bot 0's prop is pushed past every limit, and bot 1
 *  sends its garment twice. */
const sent = (i: number): Array<{ item: Uint8Array; adjust?: WornItem['adjust'] }> => [
  ...(i === 1 ? [{ item: bytes(0x10 + i) }] : []),
  { item: bytes(0x10 + i) },
  { item: bytes(0x80 + i), adjust: i === 0 ? { x: 90, y: -90, z: 4, rx: 120, ry: -120, rz: 0, scale: 250 } : { x: 0, y: 3, z: 0, rx: 0, ry: 10, rz: 0, scale: 100 } },
];
const expected = (i: number): WornItem[] => [
  { item: hex(0x10 + i) },
  { item: hex(0x80 + i), adjust: i === 0 ? { x: 10, y: -10, z: 4, rx: 45, ry: -45, rz: 0, scale: 125 } : { x: 0, y: 3, z: 0, rx: 0, ry: 10, rz: 0, scale: 100 } },
];

beforeAll(async () => {
  const udp = await UdpServer.listen({ port: 0, host: '127.0.0.1' });
  server = new WorldServer({ ...DEFAULT_SERVER, worldId: WORLD, worldKey: KEY, metricsEverySec: 0, log: () => {} }, [udp]);
  server.start();
  port = udp.port;
  let slot = 0;
  ticker = setInterval(() => {
    slot += 1;
    const now = performance.now();
    for (const b of bots) b.tick(slot, now);
  }, 10);
});

afterAll(async () => {
  if (ticker) clearInterval(ticker);
  for (const b of bots) if (b.state === 'joined') b.stop();
  await server?.stop('test over');
});

describe('outfits between bots', () => {
  it('reach every bot as the world fitted them, and a bot joining later reads them all', async () => {
    for (let i = 0; i < BOTS; i++) await enter(i);
    await waitFor('every roster to list everyone', 10_000, async () => (bots.every((b) => b.people.size === BOTS) ? true : undefined));
    for (const b of bots) for (const p of b.people.values()) expect(p.outfit).toEqual([]);

    bots.forEach((b, i) => b.act({ type: 'outfit', items: sent(i) }));
    const everyoneSees = (b: Bot): boolean => bots.every((_, i) => JSON.stringify(b.people.get(accounts[i]!)?.outfit) === JSON.stringify(expected(i)));
    await waitFor('every bot to see every outfit', 10_000, async () => (bots.every(everyoneSees) ? true : undefined));
    for (const b of bots) for (let i = 0; i < BOTS; i++) expect(b.people.get(accounts[i]!)!.outfit).toEqual(expected(i));

    const late = await enter(BOTS);
    await waitFor('the late bot to see everyone', 10_000, async () => (late.people.size === BOTS + 1 ? true : undefined));
    for (let i = 0; i < BOTS; i++) expect(late.people.get(accounts[i]!)!.outfit).toEqual(expected(i));
  }, 30_000);
});
