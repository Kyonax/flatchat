// SPDX-License-Identifier: MPL-2.0
// Bots that travel between worlds through portals (S2.11): each joins a world, walks into its
// portal, takes `portal`, leaves with `travel` and joins the world it leads to with the portal's
// spawn group, again and again. The bots stand in for the core, sealing their own connect tokens
// with each world's key. Used by hop.ts and by Stage 2's acceptance run (accept-stage2.ts).
import { Bot } from './bot.ts';
import type { BrainConfig } from './brain.ts';

/** One world a traveller visits: how to reach it, where its portal stands, how bots walk in it. */
export interface TravelWorld {
  id: string;
  key: Uint8Array;
  udpPort: number;
  portal: { x: number; z: number };
  brain: BrainConfig;
}

export interface Journey {
  hops: number;
  /** Where the bot was placed at each join that came through a portal. */
  arrivals: Array<{ world: string; x: number; z: number }>;
  error: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Travellers {
  private readonly active = new Set<Bot>();
  private ticker: ReturnType<typeof setInterval> | undefined;

  start(): void {
    let slot = 0;
    this.ticker = setInterval(() => {
      slot += 1;
      const now = performance.now();
      for (const b of this.active) b.tick(slot, now);
    }, 10);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const b of this.active) b.stop();
    this.active.clear();
  }

  /** Bot `i` makes `hops` trips between two worlds that lead to each other, starting in `first`. */
  async journey(i: number, worlds: readonly [TravelWorld, TravelWorld], hops: number, first = i % 2): Promise<Journey> {
    const j: Journey = { hops: 0, arrivals: [], error: '' };
    let at = first;
    let spawn = '';
    while (j.hops < hops) {
      const here = worlds[at]!;
      let through!: (to: { world: string; spawn: string }) => void;
      const went = new Promise<{ world: string; spawn: string }>((resolve) => (through = resolve));
      const bot = new Bot({
        index: i,
        seed: 9000 + i * 131 + j.hops,
        target: { transport: 'udp', host: '127.0.0.1', udpPort: here.udpPort, signalUrl: '', worldId: here.id, worldKey: here.key },
        brain: here.brain,
        voice: false,
        chat: false,
        spawn,
        goal: here.portal,
        onPortal: (to) => through(to),
      });
      this.active.add(bot);
      await bot.join();
      if (bot.state !== 'joined') {
        this.active.delete(bot);
        j.error = `hop ${j.hops}: ${bot.refuseReason || bot.lostReason || bot.state}`;
        return j;
      }
      const to = await Promise.race([went, sleep(40_000).then(() => undefined)]);
      if (spawn && bot.spawnAt) j.arrivals.push({ world: here.id, ...bot.spawnAt });
      const next = worlds[1 - at]!;
      if (!to || to.world !== next.id) {
        bot.stop();
        this.active.delete(bot);
        j.error = `hop ${j.hops}: ${to ? `a portal to ${to.world}` : 'no portal within 40 s'}`;
        return j;
      }
      bot.stop('travel');
      this.active.delete(bot);
      j.hops += 1;
      at = 1 - at;
      spawn = to.spawn;
    }
    return j;
  }
}
