// SPDX-License-Identifier: MPL-2.0
// Stage 5's acceptance run (S5.10), the parts a machine without a screen can show, with every real
// program and real accounts: the core on PostgreSQL with its file store and the sandboxed converters
// (KTX2 on), a world server connected to the core, and bots that join with the core's connect
// tokens. The plan's lines:
//   1. A creator makes a jacket with the kit (as the test tee is made: each body's own surface over
//      the regions it covers, 14 mm out, long sleeves), uploads it, and it converts with a fit for
//      each body and nothing out through it in the seven reference poses; three players on the
//      three bodies take it from the gallery and wear it, and everyone sees each of them in it.
//   2. An outfit toggled (the quick menu sends this same message) changes for everyone nearby.
//   3. A gallery item is published, worn and taken down: a rights holder asks on the takedown form,
//      the admin removes it, and it leaves the gallery, the accounts that took it, and the outfits
//      everyone in the world sees, at once.
//   4. A re-exported copy of the taken-down item is caught at upload: one fit ripped and written as
//      a DAE, as another program would, is refused, and is a strike on its uploader.
// The quick menu's own buttons are the client's end-to-end test (CI's Linux client job).
//
//   node tools/bots/src/accept-stage5.ts [--keep]
//
// One JSON line: { event: 'accept-stage5', ok, passed, lines }; exit 0 when every line passed.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BODY_KITS, type BodyKit, STRICT_LICENCE } from '@flatchat/content';
import { daeOf, oneFit } from '@flatchat/converter/format-samples';
import { garmentDeclaration, makeGarment, TEST_JACKET } from '@flatchat/converter/item-samples';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const PASSWORD = 'an acceptance password';
const JSON_TYPE = { 'content-type': 'application/json' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const lines: Record<string, Record<string, unknown>> = {};
const passed: Record<string, boolean> = {};
const dir = mkdtempSync(join(tmpdir(), 'fcaccept5-'));
const bots: Bot[] = [];
let slot = 0;
const ticking = setInterval(() => {
  slot += 1;
  const now = performance.now();
  for (const b of bots) b.tick(slot, now);
}, 10);
let ok = false;
let addresses = 0;
const from = (): Record<string, string> => ({ 'x-forwarded-for': `10.45.0.${(addresses += 1)}` });

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
    const r = await fetch(`${coreUrl}${path}`, { method, headers: { ...p.auth, ...from(), ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  /** Sends a file to a fresh slot, with `extra` in the slot's request, and waits for its conversion. */
  const upload = async (p: Person, kind: 'items' | 'avatars', bytes: Uint8Array, name: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const slotAnswer = await api(p, 'POST', `/api/v1/${kind}`, { name, bytes: bytes.length, sha256: sha(bytes), ...extra });
    const url = String((slotAnswer.json['upload'] as { url?: string } | undefined)?.url ?? '');
    const id = String(slotAnswer.json['id'] ?? '');
    await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...from() }, body: bytes });
    return waitFor(`${name} to convert`, 300_000, async () => {
      const list = ((await api(p, 'GET', `/api/v1/${kind}`)).json[kind] ?? []) as Array<Record<string, unknown>>;
      const a = list.find((x) => x['id'] === id);
      return a && a['status'] !== 'converting' && a['status'] !== 'uploading' ? a : undefined;
    });
  };

  // ------------------------------------------------------------------ 1. a jacket made with the kit, worn on three bodies
  const owner = await person('Owner');
  await admin('account', owner.email, '--admin', 'on');
  const creator = await person('Creator');
  const players: Array<{ body: BodyKit; who: Person }> = [];
  for (const [body, name] of [['feminine', 'Fern'], ['masculine', 'Mark'], ['neutral', 'Nell']] as const) players.push({ body, who: await person(name) });
  const jacketBytes = await makeGarment(TEST_JACKET);
  const jacket = await upload(creator, 'items', jacketBytes, 'Test jacket');
  const manifest = String(jacket['manifest'] ?? '');
  const files = await api(creator, 'GET', `/api/v1/item-files/${manifest}`);
  const clipping = ((files.json['manifest'] ?? {}) as { clipping?: Record<string, { poses: number; through: number }> }).clipping ?? {};
  const entry = String((await api(creator, 'POST', '/api/v1/gallery', { kind: 'item', id: jacket['id'], licence: STRICT_LICENCE, affirm: true })).json['id'] ?? '');
  const taken: Array<Record<string, unknown>> = [];
  for (const { body, who } of players) {
    const kit = await api(who, 'POST', '/api/v1/avatars/kit', { kit: body });
    const avatarId = String(kit.json['id'] ?? '');
    await waitFor(`${body} body to be ready`, 300_000, async () => {
      const list = ((await api(who, 'GET', '/api/v1/avatars')).json['avatars'] ?? []) as Array<Record<string, unknown>>;
      return list.find((a) => a['id'] === avatarId)?.['status'] === 'ready' ? true : undefined;
    });
    const worn = await api(who, 'PUT', '/api/v1/me/avatar', { avatar: avatarId });
    const copy = await api(who, 'POST', `/api/v1/gallery/${entry}/take`);
    taken.push({ body, avatar: worn.status, took: copy.status, copy: copy.json['id'] });
  }
  const reg = (await admin('world', 'register', '--name', 'Fitting Room', '--owner', owner.email, '--address', 'relay', '--capacity', '50')).match(/registered (\S+)/)?.[1] ?? '';
  const key = (await admin('world', 'approve', reg)).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1] ?? '';
  const proc = await start(
    [process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--world-id', reg, '--data', join(dir, 'room.db'), '--capacity', '50', '--metrics-every', '0', '--core', coreUrl, '--stop-on-stdin'],
    { FLATCHAT_WORLD_KEY: key },
    'ready',
  );
  await waitFor('the world to reach the core', 15_000, async () => (proc.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
  const udpPort = Number(proc.lines.find((l) => l['event'] === 'ready')?.['port']);
  const enter = async (p: Person): Promise<Bot> => {
    const b = new Bot({
      index: bots.length,
      seed: 700 + bots.length,
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
  const inWorld: Array<{ body: BodyKit; who: Person; b: Bot }> = [];
  for (const p of players) inWorld.push({ ...p, b: await enter(p.who) });
  await waitFor('every roster to list everyone', 10_000, async () => (inWorld.every(({ b }) => b.people.size === inWorld.length) ? true : undefined));
  const wearing = (b: Bot, who: Person): boolean => b.people.get(who.id)?.outfit.some((w) => w.item === manifest) === true;
  for (const { b } of inWorld) b.act({ type: 'outfit', items: [{ item: fromHex(manifest) }] });
  await waitFor('everyone to see everyone in the jacket', 10_000, async () => (inWorld.every(({ b }) => inWorld.every(({ who }) => wearing(b, who))) ? true : undefined)).catch(() => undefined);
  const seen = inWorld.map(({ body, b }) => ({ body, sees: inWorld.filter(({ who }) => wearing(b, who)).length }));
  lines['1-jacket'] = { status: jacket['status'], slot: jacket['slot'], fits: jacket['fits'], clipping, taken, seen };
  passed['1'] =
    jacket['status'] === 'ready' &&
    jacket['slot'] === 'outer' &&
    JSON.stringify(jacket['fits']) === JSON.stringify([...BODY_KITS]) &&
    BODY_KITS.every((b) => clipping[b]?.poses === 7 && clipping[b]?.through === 0) &&
    taken.every((t) => t['avatar'] === 204 && t['took'] === 200) &&
    seen.every((s) => s.sees === inWorld.length);

  // ------------------------------------------------------------------ 2. an outfit toggled changes for everyone nearby
  const fern = inWorld[0]!;
  // The world takes one change a second from each player: the jacket went on just now.
  await new Promise((r) => setTimeout(r, 1100));
  fern.b.act({ type: 'outfit', items: [] });
  const off = await waitFor('everyone to see Fern take it off', 10_000, async () => (inWorld.every(({ b }) => !wearing(b, fern.who)) ? true : undefined)).catch(() => false);
  await new Promise((r) => setTimeout(r, 1100));
  fern.b.act({ type: 'outfit', items: [{ item: fromHex(manifest) }] });
  const on = await waitFor('everyone to see Fern put it back on', 10_000, async () => (inWorld.every(({ b }) => wearing(b, fern.who)) ? true : undefined)).catch(() => false);
  lines['2-toggle'] = { off, on };
  passed['2'] = off === true && on === true;

  // ------------------------------------------------------------------ 3. published, worn, taken down
  const asked = await fetch(`${coreUrl}/takedown?lang=en`, {
    method: 'POST',
    headers: { ...FORM, ...from() },
    body: new URLSearchParams({ name: 'Rita Rights', contact: 'rita@example.org', work: 'My jacket, sold on my own site since 2025', target: `${coreUrl}/gallery/${entry}`, statement: 'yes', signature: 'Rita Rights' }),
  });
  const receipt = /T-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(await asked.text())?.[0] ?? '';
  const signin = await fetch(`${coreUrl}/admin/signin`, { method: 'POST', headers: { ...FORM, ...from() }, body: new URLSearchParams({ email: owner.email, password: PASSWORD }), redirect: 'manual' });
  const cookie = String(signin.headers.get('set-cookie') ?? '').split(';')[0]!;
  const page = await (await fetch(`${coreUrl}/admin`, { headers: { cookie, ...from() } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
  const takedownId = /action="\/admin\/takedowns\/([0-9a-f-]{36})"/.exec(page)?.[1] ?? '';
  const decided = await fetch(`${coreUrl}/admin/takedowns/${takedownId}`, {
    method: 'POST',
    headers: { ...FORM, cookie, ...from() },
    body: new URLSearchParams({ csrf, decision: 'remove', note: 'It copies her jacket.' }),
    redirect: 'manual',
  });
  const gone = await waitFor('the jacket to leave every outfit in the world', 10_000, async () => (inWorld.every(({ b }) => inWorld.every(({ who }) => !wearing(b, who))) ? true : undefined)).catch(() => false);
  const inGallery = (await api(fern.who, 'GET', `/api/v1/gallery/${entry}`)).status;
  const copies = await Promise.all(players.map(async ({ who }) => (((await api(who, 'GET', '/api/v1/items')).json['items'] ?? []) as Array<Record<string, unknown>>).map((i) => i['status'])));
  const delivery = (await api(fern.who, 'GET', `/api/v1/item-files/${manifest}`)).status;
  const status = await (await fetch(`${coreUrl}/takedown/status?receipt=${receipt}&lang=en`, { headers: from() })).text();
  lines['3-takedown'] = { receipt, asked: asked.status, decided: decided.headers.get('location'), inWorld: gone, inGallery, copies, delivery, told: status.includes('Taken down from FlatChat.') };
  passed['3'] = /^T-/.test(receipt) && decided.headers.get('location') === '/admin?done=takedown-removed' && gone === true && inGallery === 404 && copies.every((c) => c.length === 1 && c[0] === 'removed') && delivery === 404 && status.includes('Taken down from FlatChat.');

  // ------------------------------------------------------------------ 4. a re-exported copy is caught at upload
  const thief = await person('Thief');
  const ripped = new TextEncoder().encode(await daeOf(await oneFit(jacketBytes, 'feminine')));
  const caught = await upload(thief, 'items', ripped, 'Brown jacket', { declaration: garmentDeclaration(TEST_JACKET) });
  const admin2 = await (await fetch(`${coreUrl}/admin`, { headers: { cookie, ...from() } })).text();
  lines['4-copy'] = { status: caught['status'], problems: caught['problems'], struck: admin2.includes(thief.email) && admin2.includes('caught re-uploads') };
  passed['4'] = caught['status'] === 'refused' && JSON.stringify(caught['problems']).includes('a copy of an item taken down from FlatChat') && lines['4-copy']['struck'] === true;

  await stop(proc.proc);
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
say('accept-stage5', { ok, passed, lines });
process.exit(ok ? 0 : 1);
