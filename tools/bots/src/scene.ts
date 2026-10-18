// SPDX-License-Identifier: MPL-2.0
// The weak-laptop scene (S7.05's preparation): bots that look like players for a tester's client to
// draw. Run on the host's PC, beside its world server: each bot is an account on the core (made with
// the core's admin tool the first time, signed in after), wears one of the three standard bodies,
// and the first --effects of them also wear the starter aura (an Effekseer effect, S6.01); each joins
// with a connect token from the core, as a player does, over the world server's UDP port on this
// machine, and mingles in the world. A tester's client in that world then draws real avatars, real
// effects and the full interface, and its stats panel (F3) shows the frame rate (docs/weak-laptop.md).
//
//   node --env-file=$HOME/.config/flatchat/core.env tools/bots/src/scene.ts --core https://core.example.org
//        --world WORLD_ID --udp 127.0.0.1:PORT [--bots 55] [--effects 10] [--minutes 30] [--spawn GROUP]
//
// One JSON line when the bots are in, one when they leave: { event: 'scene', joined, avatars, effects }.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BODY_KITS } from '@flatchat/content';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { run, signIn, signUpAndIn } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ADMIN = join(ROOT, 'apps', 'core', 'src', 'admin.ts');
const PASSWORD = 'a scene bot password';

const { values } = parseArgs({
  options: {
    core: { type: 'string' },
    world: { type: 'string' },
    udp: { type: 'string' },
    bots: { type: 'string', default: '55' },
    effects: { type: 'string', default: '10' },
    minutes: { type: 'string', default: '30' },
    spawn: { type: 'string' },
    prefix: { type: 'string', default: 'scene-bot' },
  },
});
const [host, port] = (values.udp ?? '').split(':');
const bots = Number(values.bots);
const effects = Number(values.effects);
if (!values.core || !/^[0-9a-f-]{36}$/i.test(values.world ?? '') || !host || !Number(port) || !(bots >= 1 && bots <= 200) || !(effects >= 0 && effects <= bots)) {
  process.stderr.write('usage: node --env-file=CORE_ENV tools/bots/src/scene.ts --core URL --world WORLD_ID --udp HOST:PORT [--bots 55] [--effects 10] [--minutes 30]\n');
  process.exit(2);
}
const coreUrl = values.core.replace(/\/$/, '');
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** One request to the core. Every bot's requests come from this one address, so the core's
 *  per-address limit answers 429 now and then: wait and ask again. */
const api = async (access: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${coreUrl}${path}`, { method, headers: { authorization: `Bearer ${access}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    if (r.status === 429 && attempt < 30) {
      await pause(Math.max(2000, Number(r.headers.get('retry-after') ?? 0) * 1000));
      continue;
    }
    return { status: r.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
};
/** Asks every 2 s (gently: one address for every bot) until `probe` answers, for at most `ms`. */
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await pause(2000)) {
    const v = await probe();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out: ${what}`);
}

/** A scene bot's account: signed in if it exists, else invited, made a tester and signed up. */
async function account(i: number): Promise<{ access: string; id: string }> {
  const email = `${values.prefix}-${i}@example.org`;
  let access = await signIn(coreUrl, email, PASSWORD).catch(() => '');
  if (!access) {
    const invitation = (await run([process.execPath, ADMIN, 'invite', '--email', email, '--note', 'weak-laptop scene'])).match(/invite=(\S+)/)?.[1] ?? '';
    access = await signUpAndIn(coreUrl, invitation, email, PASSWORD, `Scene ${i}`);
    await run([process.execPath, ADMIN, 'account', email, '--tester', 'on']);
  }
  return { access, id: String((await api(access, 'GET', '/api/v1/me')).json['id'] ?? '') };
}

/** Wears a standard body (ready on the core), and the aura when asked; answers the aura's manifest. */
async function dress(access: string, i: number, aura: boolean): Promise<string | undefined> {
  const kit = await api(access, 'POST', '/api/v1/avatars/kit', { kit: BODY_KITS[i % BODY_KITS.length] });
  const avatar = String(kit.json['id'] ?? '');
  await until(`scene body ${i}`, 300_000, async () => ((((await api(access, 'GET', '/api/v1/avatars')).json['avatars'] ?? []) as Array<Record<string, unknown>>).find((a) => a['id'] === avatar)?.['status'] === 'ready' ? true : undefined));
  await api(access, 'PUT', '/api/v1/me/avatar', { avatar });
  if (!aura) return undefined;
  const taken = await api(access, 'POST', '/api/v1/items/starter', { starter: 'aura' });
  const id = String(taken.json['id'] ?? '');
  if (!id) throw new Error(`the core gave no aura: ${taken.status} ${JSON.stringify(taken.json).slice(0, 200)}`);
  const ready = await until(`scene aura ${i}`, 300_000, async () => (((await api(access, 'GET', '/api/v1/items')).json['items'] ?? []) as Array<Record<string, unknown>>).find((x) => x['id'] === id && x['status'] === 'ready'));
  return typeof ready['manifest'] === 'string' ? ready['manifest'] : undefined;
}

const crowd: Bot[] = [];
let slot = 0;
const ticking = setInterval(() => {
  slot += 1;
  const now = performance.now();
  for (const b of crowd) b.tick(slot, now);
}, 10);
let auras = 0;
try {
  for (let i = 0; i < bots; i++) {
    const a = await account(i);
    const aura = await dress(a.access, i, i < effects);
    const b = new Bot({
      index: i,
      seed: 900 + i,
      // The core seals each bot's token: the world's own key is never needed here (bot.ts uses it
      // only to seal a token itself).
      target: { transport: 'udp', host: host!, udpPort: Number(port), signalUrl: '', worldId: values.world!, worldKey: new Uint8Array(32) },
      brain: { ...DEFAULT_BRAIN, size: 24, scenario: 'crowd' },
      voice: false,
      chat: false,
      account: a.id,
      ...(values.spawn ? { spawn: values.spawn } : {}),
      token: async () => {
        const r = await api(a.access, 'POST', `/api/v1/worlds/${values.world}/join`);
        if (typeof r.json['token'] !== 'string') throw new Error(`the core refused: ${r.status} ${String(r.json['error'] ?? '')}`);
        return new Uint8Array(Buffer.from(r.json['token'], 'base64url'));
      },
    });
    crowd.push(b);
    await b.join();
    if (aura) {
      b.act({ type: 'outfit', items: [{ item: fromHex(aura) }] });
      auras += 1;
    }
  }
  const joined = crowd.filter((b) => b.state === 'joined').length;
  say('scene', { joined, of: bots, effects: auras, minutes: Number(values.minutes) });
  await new Promise((r) => setTimeout(r, Number(values.minutes) * 60_000));
  say('scene-done', { stillIn: crowd.filter((b) => b.state === 'joined').length, of: bots });
} finally {
  clearInterval(ticking);
  for (const b of crowd) b.stop();
}
process.exit(0);
