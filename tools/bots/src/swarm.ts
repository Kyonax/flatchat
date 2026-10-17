// SPDX-License-Identifier: MPL-2.0
// One process of bots. The run starts several, each with a slice of the bots, so the load spreads
// over cores and no single event loop limits the bots. Configuration comes from the environment
// (FLATCHAT_SWARM: JSON; FLATCHAT_WORLD_KEY: the world's key in hexadecimal). It writes JSON lines
// to stdout: `joined` once its bots have tried to join, `window` every few seconds, and `summary`
// with every bot's totals when it stops (on SIGTERM, or after durationSec).
//
//   FLATCHAT_SWARM='{...}' FLATCHAT_WORLD_KEY=... node tools/bots/src/swarm.ts
import { fromHex } from '@flatchat/protocol';
import { memory, summarize } from '@flatchat/world-server/metrics';
import type { TransportName } from '@flatchat/world-server/net';
import { Bot, type BotOptions } from './bot.ts';
import type { BrainConfig } from './brain.ts';

export interface SwarmConfig {
  /** The first bot's index, and how many bots this process runs. */
  from: number;
  count: number;
  seed: number;
  transport: TransportName;
  host: string;
  udpPort: number;
  signalUrl: string;
  iceBind?: string;
  worldId: string;
  brain: BrainConfig;
  voice: boolean;
  chat: boolean;
  /** The first voice burst of each bot starts within this many seconds (default 16). */
  firstTalkWithin?: number;
  /** Joins started per second by this process. */
  joinPerSecond: number;
  windowSec: number;
  /** Stop by itself after this long (0: wait for SIGTERM). */
  durationSec: number;
}

function out(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ event, time: Date.now(), ...fields })}\n`);
}

export async function runSwarm(config: SwarmConfig, worldKey: Uint8Array): Promise<void> {
  const bots: Bot[] = [];
  for (let i = 0; i < config.count; i++) {
    const index = config.from + i;
    const options: BotOptions = {
      index,
      seed: (config.seed * 7919 + index * 104_729) >>> 0,
      target: {
        transport: config.transport,
        host: config.host,
        udpPort: config.udpPort,
        signalUrl: config.signalUrl,
        ...(config.iceBind ? { iceBind: config.iceBind } : {}),
        worldId: config.worldId,
        worldKey,
      },
      brain: config.brain,
      voice: config.voice,
      chat: config.chat,
      ...(config.firstTalkWithin !== undefined ? { firstTalkWithin: config.firstTalkWithin } : {}),
    };
    bots.push(new Bot(options));
  }

  const started = performance.now();
  let slot = 0;
  let slotsInWindow = 0;
  const scheduler = setInterval(() => {
    slot += 1;
    slotsInWindow += 1;
    const now = performance.now();
    for (const bot of bots) bot.tick(slot, now);
  }, 10);

  const joins: Array<Promise<void>> = [];
  const spacing = 1000 / Math.max(1, config.joinPerSecond);
  for (const bot of bots) {
    joins.push(bot.join());
    await new Promise((r) => setTimeout(r, spacing));
  }
  await Promise.all(joins);
  // A real client tries again when its connection fails to open: a loaded machine's WebRTC check can
  // miss once. A refusal is not retried.
  const retried = bots.filter((b) => b.state === 'failed');
  await Promise.all(retried.map((b) => b.join()));
  out('joined', {
    retried: retried.length,
    from: config.from,
    count: bots.length,
    joined: bots.filter((b) => b.state === 'joined').length,
    failed: bots.filter((b) => b.state === 'failed').map((b) => [b.options.index, b.lostReason]),
    refused: bots.filter((b) => b.state === 'refused').map((b) => [b.options.index, b.refuseReason]),
    joinMs: summarize(bots.filter((b) => b.state === 'joined').map((b) => b.joinMs)),
  });

  let windowStart = performance.now();
  const report = (): void => {
    const now = performance.now();
    const seconds = (now - windowStart) / 1000;
    windowStart = now;
    const perBot: Array<[number, number, number, number]> = [];
    const rtt: number[] = [];
    let corrections = 0;
    let voiceFrames = 0;
    let chats = 0;
    let bad = 0;
    for (const bot of bots) {
      const w = bot.takeWindow();
      let down = 0;
      for (const v of Object.values(w.down)) down += v;
      let up = 0;
      for (const v of Object.values(w.up)) up += v;
      perBot.push([bot.options.index, down, w.down['voiceBundle'] ?? 0, up]);
      for (const r of w.rtt) rtt.push(r);
      corrections += w.corrections;
      voiceFrames += w.voiceFrames;
      chats += w.chats;
      bad += w.bad;
    }
    out('window', {
      seconds: Math.round(seconds * 100) / 100,
      joined: bots.filter((b) => b.state === 'joined').length,
      lost: bots.filter((b) => b.lostReason !== '' && b.state !== 'failed').length,
      speaking: bots.filter((b) => b.speaking).length,
      slotsPerSecond: Math.round(slotsInWindow / seconds),
      perBot,
      rtt: summarize(rtt),
      corrections,
      voiceFrames,
      chats,
      bad,
      memory: memory(),
    });
    slotsInWindow = 0;
  };
  const windows = setInterval(report, config.windowSec * 1000);

  await new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
    if (config.durationSec > 0) setTimeout(resolve, Math.max(0, config.durationSec * 1000 - (performance.now() - started)));
  });
  clearInterval(windows);
  report();
  for (const bot of bots) bot.stop();
  await new Promise((r) => setTimeout(r, 600));
  clearInterval(scheduler);
  out('summary', { from: config.from, bots: bots.map((b) => b.summary()) });
}

if (import.meta.main) {
  const raw = process.env['FLATCHAT_SWARM'];
  const key = process.env['FLATCHAT_WORLD_KEY'];
  if (!raw || !key) {
    process.stderr.write('swarm: FLATCHAT_SWARM and FLATCHAT_WORLD_KEY must be set\n');
    process.exit(2);
  }
  await runSwarm(JSON.parse(raw) as SwarmConfig, fromHex(key));
  process.exit(0);
}
