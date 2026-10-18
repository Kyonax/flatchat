// SPDX-License-Identifier: MPL-2.0
// Stage 6's acceptance run (S6.09), the parts a machine without a screen can show, with every real
// program and real accounts: the core on PostgreSQL with its file store and its sandboxed converters,
// a world server connected to the core, and bots that join with the core's connect tokens. The
// plan's lines:
//   1. Effects (S6.01): an avatar's effect uploads and converts after its dry run in the runtime; a
//      trail too busy for an avatar is refused, saying how many particles it has and may have.
//   2. Overlays (S6.02): a PNG overlay uploads and converts with its screen point; one larger than
//      an overlay may be is refused, saying so.
//   3. Creator shaders (S6.03): an avatar with a creator shader converts with the graph kept and its
//      cost counted into the rank; one whose graph loops is refused, saying why.
//   4. A world with every Stage 6 marker (S6.01, S6.02, S6.05, S6.06): effects, an overlay, a [look]
//      and a reverb zone around its arrivals, with a wall and two sounds; it converts, every client
//      can read it (the content package's own reader), a world server serves it, and two players in
//      its hall hear each other as anywhere (the room is each client's, never the server's). A host
//      who hands out a world.json with a look that is not a colour or a room the format does not
//      know is refused by the same reader.
// What only a screen shows (the materials, the screen effects, the 3D audio's rays, the interface,
// the presets and the stats panel) is the client's end-to-end test and its checks, run in CI at the
// high preset and, through a TURN relay, at the low one.
//
//   node tools/bots/src/accept-stage6.ts [--keep]
//
// One JSON line: { event: 'accept-stage6', ok, passed, lines }; exit 0 when every line passed.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { parseBuiltWorld, writeBundle } from '@flatchat/content';
import { sampleBundle } from '@flatchat/converter/effect-samples';
import { sampleShaderAvatar } from '@flatchat/converter/samples';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const PASSWORD = 'an acceptance password';
const JSON_TYPE = { 'content-type': 'application/json' };

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const lines: Record<string, Record<string, unknown>> = {};
const passed: Record<string, boolean> = {};
const dir = mkdtempSync(join(tmpdir(), 'fcaccept6-'));
const bots: Bot[] = [];
let slot = 0;
const ticking = setInterval(() => {
  slot += 1;
  const now = performance.now();
  for (const b of bots) b.tick(slot, now);
}, 10);
let ok = false;
let addresses = 0;
const from = (): Record<string, string> => ({ 'x-forwarded-for': `10.46.0.${(addresses += 1)}` });

/** A plain PNG of one colour, `side` pixels a side (an overlay too large when over 512). */
function plainPng(side: number): Uint8Array {
  const row = Buffer.alloc(side * 4 + 1);
  for (let x = 0; x < side; x++) row.set([215, 128, 252, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: side }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

interface Person {
  email: string;
  auth: Record<string, string>;
}

try {
  const db = (await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'start', '--dir', join(dir, 'pg')])).match(/FLATCHAT_CORE_DB=(\S+)/)?.[1];
  if (!db) throw new Error('no database');
  const corePort = await freePort();
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const coreEnv = { FLATCHAT_CORE_DB: db, FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'), FLATCHAT_CORE_URL: coreUrl, FLATCHAT_CORE_STUN: 'none', FLATCHAT_CORE_TUNNEL: '1', FLATCHAT_CORE_STORE: join(dir, 'store') };
  const core = await start([process.execPath, join(CORE, 'src', 'main.ts'), '--port', String(corePort), '--stop-on-stdin'], coreEnv, 'ready');
  const admin = (...args: string[]): Promise<string> => run([process.execPath, join(CORE, 'src', 'admin.ts'), ...args], coreEnv);
  const api = async (p: Person, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${coreUrl}${path}`, { method, headers: { ...p.auth, ...from(), ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const person = async (name: string): Promise<Person> => {
    const email = `${name.toLowerCase()}@example.org`;
    const invitation = (await admin('invite', '--email', email, '--note', 'acceptance')).match(/invite=(\S+)/)?.[1] ?? '';
    const access = await signUpAndIn(coreUrl, invitation, email, PASSWORD, name, from());
    await admin('account', email, '--tester', 'on');
    return { email, auth: { authorization: `Bearer ${access}` } };
  };
  /** Sends a file to a fresh slot, with `extra` in the slot's request, and waits for its conversion. */
  const upload = async (p: Person, kind: 'items' | 'avatars', bytes: Uint8Array, name: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const slotAnswer = await api(p, 'POST', `/api/v1/${kind}`, { name, bytes: bytes.length, sha256: sha(bytes), ...extra });
    const url = String((slotAnswer.json['upload'] as { url?: string } | undefined)?.url ?? '');
    const id = String(slotAnswer.json['id'] ?? '');
    if (!url || !id) return { status: `no slot (${slotAnswer.status} ${JSON.stringify(slotAnswer.json).slice(0, 200)})` };
    await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...from() }, body: bytes });
    return waitFor(`${name} to convert`, 300_000, async () => {
      const list = ((await api(p, 'GET', `/api/v1/${kind}`)).json[kind] ?? []) as Array<Record<string, unknown>>;
      const a = list.find((x) => x['id'] === id);
      return a && a['status'] !== 'converting' && a['status'] !== 'uploading' ? a : undefined;
    });
  };
  const owner = await person('Owner');
  await admin('account', owner.email, '--admin', 'on');
  const creator = await person('Creator');

  // ------------------------------------------------------------------ 1. effects
  const aura = await upload(creator, 'items', writeBundle({ ...sampleBundle('00_Version16/Aura01.efkefc'), declaration: { name: 'Aura', slot: 'effect', attach: 'hips', scale: 0.5, authors: ['the Effekseer project'] } }), 'Aura');
  const trail = await upload(creator, 'items', writeBundle({ ...sampleBundle('00_Basic/Simple_Track1.efkefc'), declaration: { name: 'Trail', slot: 'effect', attach: 'hips', scale: 1, authors: ['the Effekseer project'] } }), 'Trail');
  lines['1-effects'] = { aura: aura['status'], trail: trail['status'], trailWhy: trail['problems'] };
  passed['1'] = aura['status'] === 'ready' && trail['status'] === 'refused' && /particles at once; an avatar's effects may have 300/.test(JSON.stringify(trail['problems']));

  // ------------------------------------------------------------------ 2. overlays
  const overlayDeclaration = { name: 'Heart', slot: 'overlay', hud: 'top-left', size: 0.08, opacity: 0.9, motion: 'bob', audience: 'everyone', authors: ['the FlatChat contributors'] };
  const heart = await upload(creator, 'items', new Uint8Array(readFileSync(join(ROOT, 'kits', 'overlays', 'heart-badge.png'))), 'Heart', { declaration: overlayDeclaration });
  const huge = await upload(creator, 'items', plainPng(1024), 'Huge', { declaration: { ...overlayDeclaration, name: 'Huge' } });
  lines['2-overlays'] = { heart: heart['status'], huge: huge['status'], hugeWhy: huge['problems'] };
  passed['2'] = heart['status'] === 'ready' && huge['status'] === 'refused' && /512/.test(JSON.stringify(huge['problems']));

  // ------------------------------------------------------------------ 3. creator shaders
  const glowing = await upload(creator, 'avatars', await sampleShaderAvatar(), 'Glowing');
  const files = await api(creator, 'GET', `/api/v1/avatar-files/${String(glowing['manifest'] ?? '')}`);
  const manifest = (files.json['manifest'] ?? {}) as { shaders?: number };
  const loop = { format: 1, nodes: [{ id: 'a', op: 'add', in: { a: 'b', b: 1 } }, { id: 'b', op: 'add', in: { a: 'a', b: 1 } }], out: { emissive: 'a' } };
  const looping = await upload(creator, 'avatars', await sampleShaderAvatar(loop), 'Looping');
  lines['3-shaders'] = { glowing: glowing['status'], rank: glowing['rank'], shaders: manifest.shaders, costCounted: JSON.stringify(files.json).includes('"shaderCost":'), looping: looping['status'], loopingWhy: looping['problems'] };
  passed['3'] = glowing['status'] === 'ready' && manifest.shaders === 1 && lines['3-shaders']['costCounted'] === true && looping['status'] === 'refused' && /cycle/.test(JSON.stringify(looping['problems']));

  // ------------------------------------------------------------------ 4. a world with every Stage 6 marker
  const register = async (name: string): Promise<{ id: string; key: string }> => {
    const id = (await admin('world', 'register', '--name', name, '--owner', owner.email, '--address', 'relay', '--capacity', '50')).match(/registered (\S+)/)?.[1] ?? '';
    const key = (await admin('world', 'approve', id)).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1] ?? '';
    if (!id || !key) throw new Error(`no world ${name}`);
    return { id, key };
  };
  const plazaReg = await register('Stage Six Plaza');
  const gardenReg = await register('Stage Six Garden');
  await run([process.execPath, MAKE_TRAVEL, join(dir, 'travel'), '--worlds', `${plazaReg.id},${gardenReg.id}`, '--names', 'Stage Six Plaza,Stage Six Garden', '--kits', 'plaza,park', '--effect', '--overlay', '--look', '--acoustics']);
  const built = JSON.parse(readFileSync(join(dir, 'travel', 'b.built', 'world.json'), 'utf8')) as Record<string, unknown>;
  const read = parseBuiltWorld(built);
  const world = 'world' in read ? read.world : undefined;
  const zones = world?.scenes.flatMap((sc) => sc.zones) ?? [];
  const markers = {
    effects: world?.scenes.flatMap((sc) => sc.effects).length ?? 0,
    overlays: world?.overlays?.length ?? 0,
    look: world?.manifest.look ? { bloom: !!world.manifest.look.bloom, filters: !!world.manifest.look.filters } : null,
    reverb: zones.filter((z) => z.kind === 'reverb').map((z) => ({ room: z.room, mix: z.mix })),
    emitters: world?.scenes.flatMap((sc) => sc.emitters).length ?? 0,
  };
  const serverProc = await start(
    [process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--world-id', gardenReg.id, '--data', join(dir, 'garden.db'), '--capacity', '50', '--metrics-every', '0', '--core', coreUrl, '--stop-on-stdin', '--world', join(dir, 'travel', 'b.built')],
    { FLATCHAT_WORLD_KEY: gardenReg.key },
    'ready',
  );
  await waitFor('the world to reach the core', 15_000, async () => (serverProc.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
  const udpPort = Number(serverProc.lines.find((l) => l['event'] === 'ready')?.['port']);
  const enter = async (p: Person): Promise<Bot> => {
    const b = new Bot({
      index: bots.length,
      seed: 600 + bots.length,
      target: { transport: 'udp', host: '127.0.0.1', udpPort, signalUrl: '', worldId: gardenReg.id, worldKey: fromHex(gardenReg.key) },
      brain: { ...DEFAULT_BRAIN, size: 32, scenario: 'crowd' },
      voice: true,
      chat: false,
      firstTalkWithin: 0.2,
      still: true,
      spawn: 'arrival',
      token: async () => {
        const r = await api(p, 'POST', `/api/v1/worlds/${gardenReg.id}/join`);
        if (typeof r.json['token'] !== 'string') throw new Error(`the core refused: ${r.status} ${String(r.json['error'] ?? '')}`);
        return new Uint8Array(Buffer.from(r.json['token'], 'base64url'));
      },
    });
    bots.push(b);
    await b.join();
    return b;
  };
  const ana = await enter(await person('Ana'));
  const ben = await enter(await person('Ben'));
  await pause(500);
  for (const b of bots) b.heard.clear();
  await pause(3000);
  const heard = (listener: Bot, speaker: Bot): number => (speaker.entity === undefined ? 0 : (listener.heard.get(speaker.entity) ?? 0));
  // A host's own world.json, read by every client: a look that is no colour, a room the format does not know.
  const broken = (change: (w: Record<string, unknown>) => void): string => {
    const w = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
    change(w);
    const r = parseBuiltWorld(w);
    return 'error' in r ? r.error : 'accepted';
  };
  const badLook = broken((w) => ((w['manifest'] as Record<string, unknown>)['look'] = { ...((w['manifest'] as Record<string, unknown>)['look'] as object), sky: 'url(javascript:alert(1))' }));
  const badRoom = broken((w) => {
    for (const sc of w['scenes'] as Array<Record<string, unknown>>) for (const z of (sc['zones'] ?? []) as Array<Record<string, unknown>>) if (z['kind'] === 'reverb') z['room'] = 'disco';
  });
  lines['4-world'] = { read: world ? 'ok' : (read as { error: string }).error, markers, joined: [ana.state, ben.state], anaHeardBen: heard(ana, ben), benHeardAna: heard(ben, ana), badLook, badRoom };
  passed['4'] =
    world !== undefined &&
    markers.effects >= 1 &&
    markers.overlays === 1 &&
    markers.look?.bloom === true &&
    markers.reverb.length === 1 &&
    markers.reverb[0]?.room === 'hall' &&
    markers.emitters === 2 &&
    ana.state === 'joined' &&
    ben.state === 'joined' &&
    heard(ana, ben) > 0 &&
    heard(ben, ana) > 0 &&
    /look\.sky/.test(badLook) &&
    /room/.test(badRoom);

  await stop(serverProc.proc);
  await stop(core.proc);
  ok = ['1', '2', '3', '4'].every((k) => passed[k] === true);
} catch (err) {
  lines['error'] = { message: err instanceof Error ? err.message : String(err) };
} finally {
  clearInterval(ticking);
  for (const b of bots) b.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('accept-stage6', { ok, passed, lines });
process.exit(ok ? 0 : 1);
