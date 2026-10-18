// SPDX-License-Identifier: MPL-2.0
// Stage 4's acceptance run (S4.12), the parts a machine without a screen can show, with every real
// program and real accounts: the core on PostgreSQL with its file store and the sandboxed avatar
// converter (KTX2 on), a world server, and bots that join with the connect tokens the core issued.
// The plan's lines it covers:
//   1. Avatars from three different creation tools upload, convert and rank: the reference avatars
//      written as VRoid Studio 1.x (VRM 1.0), UniVRM 0.x and Blender's exporter (VRM 0.x) and a
//      Mixamo-named GLB would write them, and a free shape (a robot with no skeleton), each sent
//      by its own account to an upload slot and converted.
//   2. ...and appear for everyone: each account wears its avatar, joins the world, and every bot's
//      roster names every other player's avatar; a viewer fetches every level of every worn avatar
//      through signed links and checks each against its hash.
// The rest is the client's and the owner's: the end-to-end test draws a worn avatar in the real
// client (CI's Linux client job); the frame-rate lines (55 avatars in view at 30 fps and 200 with
// impostors at 720p on the reference laptop) are the avatar bench on the stand-in; the trust
// shield's rule is apps/client/test/avatar-policy.test.ts.
//
//   node tools/bots/src/accept-stage4.ts [--keep]
//
// One JSON line: { event: 'accept-stage4', ok, passed, lines }; exit 0 when every line passed.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sampleAvatar, type SampleKind } from '@flatchat/converter/samples';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const PASSWORD = 'an acceptance password';
const JSON_TYPE = { 'content-type': 'application/json' };

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const lines: Record<string, Record<string, unknown>> = {};
const passed: Record<string, boolean> = {};
const dir = mkdtempSync(join(tmpdir(), 'fcaccept4-'));
const bots: Bot[] = [];
let slot = 0;
const ticking = setInterval(() => {
  slot += 1;
  const now = performance.now();
  for (const b of bots) b.tick(slot, now);
}, 10);
let ok = false;
let addresses = 0;
const from = (): Record<string, string> => ({ 'x-forwarded-for': `10.44.0.${(addresses += 1)}` });

interface Person {
  email: string;
  id: string;
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
    const r = await fetch(`${coreUrl}${path}`, { method, headers: { ...p.auth, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const person = async (name: string): Promise<Person> => {
    const email = `${name.toLowerCase()}@example.org`;
    const invitation = (await admin('invite', '--email', email, '--note', 'acceptance')).match(/invite=(\S+)/)?.[1] ?? '';
    const access = await signUpAndIn(coreUrl, invitation, email, PASSWORD, name, from());
    await admin('account', email, '--tester', 'on');
    const p: Person = { email, id: '', auth: { authorization: `Bearer ${access}` } };
    p.id = String((await api(p, 'GET', '/api/v1/me')).json['id'] ?? '');
    return p;
  };

  // ------------------------------------------------------------------ 1. upload, convert, rank
  const owner = await person('Owner');
  const makers: Array<{ kind: SampleKind; tool: string; who: Person }> = [
    { kind: 'vrm1', tool: 'VRM 1.0 (as VRoid Studio 1.x writes)', who: await person('Vera') },
    { kind: 'vrm0', tool: 'VRM 0.x (as UniVRM and Blender’s exporter write)', who: await person('Vito') },
    { kind: 'glb', tool: 'GLB with Mixamo’s bone names', who: await person('Gale') },
    { kind: 'free', tool: 'a free shape (a robot, no skeleton)', who: await person('Rob') },
  ];
  const viewer = await person('Viewer');
  const uploads: Array<Record<string, unknown>> = [];
  const manifests = new Map<string, string>();
  for (const m of makers) {
    const bytes = await sampleAvatar(m.kind);
    const slotAnswer = await api(m.who, 'POST', '/api/v1/avatars', { name: m.kind, bytes: bytes.length, sha256: sha(bytes) });
    const url = String((slotAnswer.json['upload'] as { url?: string } | undefined)?.url ?? '');
    const id = String(slotAnswer.json['id'] ?? '');
    const sent = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...from() }, body: bytes });
    const ready = await waitFor(`${m.kind} to convert`, 180_000, async () => {
      const list = ((await api(m.who, 'GET', '/api/v1/avatars')).json['avatars'] ?? []) as Array<Record<string, unknown>>;
      const a = list.find((x) => x['id'] === id);
      return a && a['status'] !== 'converting' && a['status'] !== 'uploading' ? a : undefined;
    });
    const worn = await api(m.who, 'PUT', '/api/v1/me/avatar', { avatar: id });
    if (typeof ready['manifest'] === 'string') manifests.set(m.who.id, ready['manifest']);
    uploads.push({ tool: m.tool, slot: slotAnswer.status, sent: sent.status, status: ready['status'], rank: ready['rank'], worn: worn.status });
  }
  lines['1-uploads'] = { avatars: uploads };
  passed['1'] = uploads.every((u) => u['slot'] === 201 && u['sent'] === 202 && u['status'] === 'ready' && typeof u['rank'] === 'string' && u['worn'] === 204);

  // ------------------------------------------------------------------ 2. everyone sees everyone's avatar
  const reg = (await admin('world', 'register', '--name', 'Avatar Hall', '--owner', owner.email, '--address', 'relay', '--capacity', '50')).match(/registered (\S+)/)?.[1] ?? '';
  const key = (await admin('world', 'approve', reg)).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1] ?? '';
  const proc = await start(
    [process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--world-id', reg, '--data', join(dir, 'hall.db'), '--capacity', '50', '--metrics-every', '0', '--core', coreUrl, '--stop-on-stdin'],
    { FLATCHAT_WORLD_KEY: key },
    'ready',
  );
  await waitFor('the world to reach the core', 15_000, async () => (proc.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
  const udpPort = Number(proc.lines.find((l) => l['event'] === 'ready')?.['port']);
  const enter = async (p: Person): Promise<Bot> => {
    const b = new Bot({
      index: bots.length,
      seed: 500 + bots.length,
      target: { transport: 'udp', host: '127.0.0.1', udpPort, signalUrl: '', worldId: reg, worldKey: fromHex(key) },
      brain: { ...DEFAULT_BRAIN, size: 32, scenario: 'crowd' },
      voice: false,
      chat: false,
      still: true,
      token: async () => {
        const r = await api(p, 'POST', `/api/v1/worlds/${reg}/join`);
        if (typeof r.json['token'] !== 'string') throw new Error(`the core refused: ${r.status}`);
        return new Uint8Array(Buffer.from(r.json['token'], 'base64url'));
      },
    });
    bots.push(b);
    await b.join();
    return b;
  };
  const inWorld: Array<{ p: Person; b: Bot }> = [];
  for (const p of [...makers.map((m) => m.who), viewer]) inWorld.push({ p, b: await enter(p) });
  await waitFor('every roster to list everyone', 10_000, async () => (inWorld.every(({ b }) => b.people.size === inWorld.length) ? true : undefined));
  const seen = inWorld.map(({ p, b }) => ({
    who: p.email,
    sees: makers.filter((m) => b.people.get(m.who.id)?.avatar === manifests.get(m.who.id)).length,
    viewerHasNone: b.people.get(viewer.id)?.avatar === undefined,
  }));
  lines['2-everyone'] = { joined: inWorld.filter(({ b }) => b.state === 'joined').length, seen };
  passed['2'] = inWorld.every(({ b }) => b.state === 'joined') && seen.every((s) => s.sees === makers.length && s.viewerHasNone);

  // ------------------------------------------------------------------ 3. delivered intact to anyone
  const delivered: Array<Record<string, unknown>> = [];
  for (const m of makers) {
    const manifest = manifests.get(m.who.id) ?? '';
    const d = await api(viewer, 'GET', `/api/v1/avatar-files/${manifest}`);
    const links = (d.json['links'] ?? {}) as Record<string, string>;
    const levels = ((d.json['manifest'] ?? {}) as { levels?: Record<string, { file: string }>; shape?: string }).levels ?? {};
    let intact = 0;
    for (const level of ['lod0', 'lod1', 'lod2', 'impostor']) {
      const r = await fetch(links[level] ?? '', { headers: from() });
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (r.status === 200 && sha(bytes) === levels[level]?.file) intact += 1;
    }
    delivered.push({ kind: m.kind, delivery: d.status, intact, shape: ((d.json['manifest'] ?? {}) as { shape?: string }).shape });
  }
  lines['3-delivery'] = { delivered };
  passed['3'] = delivered.every((x) => x['delivery'] === 200 && x['intact'] === 4) && delivered.find((x) => x['kind'] === 'free')?.['shape'] === 'free';

  await stop(proc.proc);
  await stop(core.proc);
  ok = ['1', '2', '3'].every((k) => passed[k] === true);
} catch (err) {
  lines['error'] = { message: err instanceof Error ? err.message : String(err) };
} finally {
  clearInterval(ticking);
  for (const b of bots) b.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('accept-stage4', { ok, passed, lines });
process.exit(ok ? 0 : 1);
