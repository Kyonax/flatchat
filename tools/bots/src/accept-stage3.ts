// SPDX-License-Identifier: MPL-2.0
// Stage 3's acceptance run (S3.13), with every real program on this machine and real accounts: the
// core on PostgreSQL (minors on, mail into a folder), its admin command line, three world servers,
// and headless bots that sign in as accounts and join with the connect tokens the core issued them.
// The plan's lines:
//   1. Each entry rule admits the right accounts and refuses the rest with a clear reason
//      (entry-open, entry-verified, entry-trust, and entry-trust for testers only).
//   2. Kick, ban, mute, force-mute and platform bans work: the world's owner holds a player's
//      voice and the world drops it, removes one, then bans them with the reason they are shown;
//      the core's owner bans an account everywhere.
//   3. A personal mute and a block follow the account into another world: the block keeps the
//      two apart in the second world (voice, chat, hidden); the mute list comes with the account
//      (the client silences it in every world: apps/client/test/voice-controls.test.ts).
//   4. A quiet zone silences voice, both ways, while voice outside it carries.
//   5. A test minor hears and is heard only by its accepted friend until its guardian widens it.
//   6. A report reaches the queue with its evidence, and the reporter reads the decision.
//   7. A drill runs the abuse path end to end with a harmless stand-in file.
//
//   node tools/bots/src/accept-stage3.ts [--keep]
//
// One JSON line: { event: 'accept-stage3', ok, lines }; exit 0 when every line passed.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromHex } from '@flatchat/protocol';
import { Bot } from './bot.ts';
import { DEFAULT_BRAIN } from './brain.ts';
import { children, freePort, run, signUpAndIn, start, stop, waitFor } from './procs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(ROOT, 'apps', 'core');
const SERVER_MAIN = join(ROOT, 'apps', 'world-server', 'src', 'main.ts');
const RULES = join(ROOT, 'apps', 'world-server', 'plugins');
const MAKE_TRAVEL = join(ROOT, 'tools', 'converter', 'scripts', 'make-travel.ts');
const PASSWORD = 'an acceptance password';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'content-type': 'application/json' };
// The core runs as behind a tunnel, so each person arrives from an address of its own, as players
// do: the core's limits count per address (five sign-ups in ten minutes).
let addresses = 0;
const from = (): Record<string, string> => {
  addresses += 1;
  return { 'x-forwarded-for': `10.33.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}` };
};

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const say = (event: string, fields: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lines: Record<string, Record<string, unknown>> = {};
const passed: Record<string, boolean> = {};
const dir = mkdtempSync(join(tmpdir(), 'fcaccept3-'));
const bots: Bot[] = [];
let slot = 0;
const ticking = setInterval(() => {
  slot += 1;
  const now = performance.now();
  for (const b of bots) b.tick(slot, now);
}, 10);
let ok = false;

interface Person {
  email: string;
  id: string;
  auth: Record<string, string>;
}

interface World {
  id: string;
  key: Uint8Array;
  udpPort: number;
  proc: Awaited<ReturnType<typeof start>>;
}

/** A WAV file as the client's recorder writes it: 16 kHz, mono, 16-bit, half a second. */
function wav(samples = 8000): Buffer {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 6) * 5000), 44 + i * 2);
  return b;
}

try {
  // ------------------------------------------------------------------ the core and its accounts
  const db = (await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'start', '--dir', join(dir, 'pg')])).match(/FLATCHAT_CORE_DB=(\S+)/)?.[1];
  if (!db) throw new Error('no database');
  const corePort = await freePort();
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const mail = join(dir, 'mail');
  const coreEnv = {
    FLATCHAT_CORE_DB: db,
    FLATCHAT_CORE_SECRET: randomBytes(32).toString('hex'),
    FLATCHAT_CORE_URL: coreUrl,
    FLATCHAT_CORE_STUN: 'none',
    FLATCHAT_CORE_TUNNEL: '1',
    FLATCHAT_CORE_MINORS: 'on',
    FLATCHAT_CORE_MAIL: 'folder',
    FLATCHAT_CORE_MAIL_FOLDER: mail,
    FLATCHAT_CORE_MAIL_FROM: 'FlatChat <noreply@example.org>',
  };
  const core = await start([process.execPath, join(CORE, 'src', 'main.ts'), '--port', String(corePort), '--stop-on-stdin'], coreEnv, 'ready');
  const admin = (...args: string[]): Promise<string> => run([process.execPath, join(CORE, 'src', 'admin.ts'), ...args], coreEnv);
  const api = async (p: Person, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${coreUrl}${path}`, { method, headers: { ...p.auth, ...(body === undefined ? {} : JSON_TYPE) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const person = async (name: string, verified = true): Promise<Person> => {
    const email = `${name.toLowerCase()}@example.org`;
    const invitation = (await admin('invite', ...(verified ? ['--email', email] : []), '--note', 'acceptance')).match(/invite=(\S+)/)?.[1] ?? '';
    const access = await signUpAndIn(coreUrl, invitation, email, PASSWORD, name, from());
    const p: Person = { email, id: '', auth: { authorization: `Bearer ${access}` } };
    p.id = String((await api(p, 'GET', '/api/v1/me')).json['id'] ?? '');
    return p;
  };
  /** Signs in the way the client does (PKCE, the sign-in page, the code exchange); the page's
   *  status and text when it refuses. */
  const signIn = async (email: string): Promise<{ access?: string; status: number; page: string }> => {
    const verifier = randomBytes(48).toString('base64url');
    const at = from();
    const lr = (await (await fetch(`${coreUrl}/api/v1/login-requests`, { method: 'POST', headers: { ...JSON_TYPE, ...at }, body: JSON.stringify({ challenge: createHash('sha256').update(verifier).digest('base64url'), port: 50_000 }) })).json()) as { request: string };
    const posted = await fetch(`${coreUrl}/signin?lang=en`, { method: 'POST', headers: { ...FORM, ...at }, body: new URLSearchParams({ request: lr.request, email, password: PASSWORD }), redirect: 'manual' });
    const code = new URL(posted.headers.get('location') ?? 'http://x/').searchParams.get('code');
    if (!code) return { status: posted.status, page: await posted.text() };
    const session = (await (await fetch(`${coreUrl}/api/v1/sessions`, { method: 'POST', headers: { ...JSON_TYPE, ...at }, body: JSON.stringify({ request: lr.request, code, verifier }) })).json()) as { access?: string };
    return { ...(session.access ? { access: session.access } : {}), status: posted.status, page: '' };
  };

  const owner = await person('Owner');
  await admin('account', owner.email, '--admin', 'on');
  const ana = await person('Ana');
  const ben = await person('Ben');
  const cy = await person('Cyd', false);
  const dee = await person('Dee');
  await admin('account', dee.email, '--tester', 'on');
  const eve = await person('Eve');
  await admin('account', eve.email, '--trust', '2');
  const gus = await person('Gus');
  const hal = await person('Hal');
  const fran = await person('Fran');
  const stan = await person('Stan');

  // ------------------------------------------------------------------ three worlds of the owner's
  const register = async (name: string): Promise<{ id: string; key: string }> => {
    const id = (await admin('world', 'register', '--name', name, '--owner', owner.email, '--address', 'relay', '--capacity', '50')).match(/registered (\S+)/)?.[1] ?? '';
    const key = (await admin('world', 'approve', id)).match(/FLATCHAT_WORLD_KEY=(\S+)/)?.[1] ?? '';
    if (!id || !key) throw new Error(`no world ${name}`);
    return { id, key };
  };
  const plazaReg = await register('Owner Plaza');
  const parkReg = await register('Quiet Park');
  const hallReg = await register('Rules Hall');
  await run([process.execPath, MAKE_TRAVEL, join(dir, 'travel'), '--worlds', `${plazaReg.id},${parkReg.id}`, '--names', 'Owner Plaza,Quiet Park', '--kits', 'plaza,park', '--quiet']);
  const serve = async (reg: { id: string; key: string }, o: { built?: string; plugins?: string; data: string }): Promise<World> => {
    const proc = await start(
      [
        process.execPath, SERVER_MAIN, '--transport', 'udp', '--port', '0', '--bind', '127.0.0.1', '--world-id', reg.id, '--data', o.data, '--capacity', '50',
        '--metrics-every', '0', '--core', coreUrl, '--stop-on-stdin', ...(o.built ? ['--world', o.built] : []), ...(o.plugins ? ['--plugins', o.plugins] : []),
      ],
      { FLATCHAT_WORLD_KEY: reg.key },
      'ready',
    );
    await waitFor('the world to reach the core', 15_000, async () => (proc.lines.some((l) => l['event'] === 'relay-connected') ? true : undefined));
    return { id: reg.id, key: fromHex(reg.key), udpPort: Number(proc.lines.find((l) => l['event'] === 'ready')?.['port']), proc };
  };

  /** A bot for an account: it asks the core for a connect token, as the client does, and stays put. */
  const enter = async (p: Person, w: World, o: { spawn?: string; voice?: boolean } = {}): Promise<Bot> => {
    const b = new Bot({
      index: bots.length,
      seed: 300 + bots.length,
      target: { transport: 'udp', host: '127.0.0.1', udpPort: w.udpPort, signalUrl: '', worldId: w.id, worldKey: w.key },
      brain: { ...DEFAULT_BRAIN, size: 32, scenario: 'crowd' },
      voice: o.voice ?? true,
      chat: true,
      firstTalkWithin: 0.2,
      still: true,
      ...(o.spawn ? { spawn: o.spawn } : {}),
      token: async () => {
        const r = await api(p, 'POST', `/api/v1/worlds/${w.id}/join`);
        if (typeof r.json['token'] !== 'string') throw new Error(`the core refused: ${r.status} ${String(r.json['error'] ?? '')}`);
        return new Uint8Array(Buffer.from(r.json['token'], 'base64url'));
      },
    });
    bots.push(b);
    await b.join();
    return b;
  };
  const leave = async (...gone: Bot[]): Promise<void> => {
    for (const b of gone) {
      b.stop();
      bots.splice(bots.indexOf(b), 1);
    }
    await pause(400);
  };
  /** Listens for a while with clean counters: who heard whom, who read whom. */
  const listen = async (ms: number): Promise<void> => {
    for (const b of bots) {
      b.heard.clear();
      b.read.clear();
    }
    await pause(ms);
  };
  const heard = (listener: Bot, speaker: Bot): number => (speaker.entity === undefined ? 0 : (listener.heard.get(speaker.entity) ?? 0));

  // ------------------------------------------------------------------ 1. entry rules
  const ruleFolder = (name: string, plugin: string, settings: Record<string, string>): string => {
    const folder = join(dir, `rules-${name}`);
    cpSync(join(RULES, plugin), join(folder, plugin), { recursive: true });
    const toml = join(folder, plugin, 'plugin.toml');
    let text = readFileSync(toml, 'utf8');
    for (const [k, v] of Object.entries(settings)) text = text.replace(new RegExp(`^${k} = .*$`, 'm'), `${k} = ${v}`);
    writeFileSync(toml, text);
    return folder;
  };
  const rules: Array<{ rule: string; plugins: string; admit: Person[]; refuse: Person[] }> = [
    { rule: 'entry-open', plugins: ruleFolder('open', 'entry-open', {}), admit: [cy, ana], refuse: [] },
    { rule: 'entry-verified', plugins: ruleFolder('verified', 'entry-verified', { min_account_days: '0' }), admit: [ana], refuse: [cy] },
    { rule: 'entry-trust', plugins: ruleFolder('trust', 'entry-trust', { min_trust: '2' }), admit: [eve, dee], refuse: [ana] },
    { rule: 'entry-trust, testers only', plugins: ruleFolder('testers', 'entry-trust', { testers_only: 'true' }), admit: [dee], refuse: [eve] },
  ];
  const entry: Array<Record<string, unknown>> = [];
  for (const r of rules) {
    const hall = await serve(hallReg, { plugins: r.plugins, data: join(dir, 'hall.db') });
    const admitted: string[] = [];
    const refused: Array<{ who: string; reason: string; detail: string }> = [];
    for (const p of r.admit) {
      const b = await enter(p, hall, { voice: false });
      if (b.state === 'joined') admitted.push(p.email);
      await leave(b);
    }
    for (const p of r.refuse) {
      const b = await enter(p, hall, { voice: false });
      refused.push({ who: p.email, reason: b.refuseReason || b.state, detail: b.refuseDetail });
      await leave(b);
    }
    await stop(hall.proc.proc);
    const right = admitted.length === r.admit.length && refused.length === r.refuse.length && refused.every((x) => x.reason === 'rule' && x.detail.length > 0);
    entry.push({ rule: r.rule, admitted: admitted.length, of: r.admit.length, refused, right });
  }
  lines['1-entry-rules'] = { rules: entry };
  passed['1'] = entry.every((e) => e['right'] === true);

  const plaza = await serve(plazaReg, { built: join(dir, 'travel', 'a.built'), data: join(dir, 'plaza.db') });
  const park = await serve(parkReg, { built: join(dir, 'travel', 'b.built'), data: join(dir, 'park.db') });

  // ------------------------------------------------------------------ 2. moderation
  const host = await enter(owner, plaza);
  const anaIn = await enter(ana, plaza);
  let benIn = await enter(ben, plaza);
  await waitFor('the owner to see the others', 5000, async () => (host.people.has(ana.id) && host.people.has(ben.id) ? true : undefined));
  const ownerRole = host.people.get(owner.id)?.role;
  // A held mute (force-mute): the player is told, and the world drops their voice.
  await listen(3000);
  const anaBefore = heard(host, anaIn);
  host.act({ type: 'moderate', account: ana.id, action: 'mute', minutes: 0, reason: 'Acceptance: held mute' });
  await waitFor('the held mute', 5000, async () => (anaIn.heldMute ? true : undefined));
  await listen(4000);
  const anaAfter = heard(host, anaIn);
  host.act({ type: 'moderate', account: ana.id, action: 'unmute', minutes: 0, reason: '' });
  // A kick, then a ban with its reason; the ban holds at the door.
  host.act({ type: 'moderate', account: ben.id, action: 'kick', minutes: 0, reason: 'Acceptance: kick' });
  await waitFor('the kick', 5000, async () => benIn.removed);
  const kicked = benIn.removed;
  await leave(benIn);
  benIn = await enter(ben, plaza, { voice: false });
  const backAfterKick = benIn.state === 'joined';
  host.act({ type: 'moderate', account: ben.id, action: 'ban', minutes: 60, reason: 'Acceptance: ban' });
  await waitFor('the ban', 5000, async () => benIn.removed);
  const banned = benIn.removed;
  await leave(benIn);
  const benAgain = await enter(ben, plaza, { voice: false });
  const atTheDoor = { reason: benAgain.refuseReason, detail: benAgain.refuseDetail };
  await leave(benAgain);
  // A platform ban: the core's owner bans an account everywhere.
  await admin('account', cy.email, '--status', 'banned', '--reason', 'Acceptance: platform ban');
  const cyJoin = await api(cy, 'POST', `/api/v1/worlds/${plaza.id}/join`);
  const cySignIn = await signIn(cy.email);
  lines['2-moderation'] = {
    ownerRole,
    heldMute: { told: anaIn.heldMute === undefined ? 'lifted' : anaIn.heldMute, framesBefore: anaBefore, framesWhileMuted: anaAfter },
    kick: kicked,
    backAfterKick,
    ban: banned,
    atTheDoor,
    platformBan: { join: cyJoin.status, signIn: cySignIn.status, reasonShown: cySignIn.page.includes('Acceptance: platform ban') },
  };
  passed['2'] =
    ownerRole === 'owner' &&
    anaBefore > 0 &&
    anaAfter === 0 &&
    kicked?.reason === 'kicked' &&
    kicked.detail === 'Acceptance: kick' &&
    backAfterKick &&
    banned?.reason === 'banned' &&
    banned.detail.includes('Acceptance: ban') &&
    atTheDoor.reason === 'banned' &&
    atTheDoor.detail.includes('Acceptance: ban') &&
    cyJoin.status === 401 &&
    cySignIn.status === 403 &&
    cySignIn.page.includes('Acceptance: platform ban');
  await leave(host, anaIn);

  // ------------------------------------------------------------------ 3. a mute and a block follow the account
  const muted = await api(ana, 'PUT', `/api/v1/me/mutes/${gus.id}`);
  const blocked = await api(ana, 'PUT', `/api/v1/me/blocks/${hal.id}`);
  const anaPark = await enter(ana, park);
  const halPark = await enter(hal, park);
  const gusPark = await enter(gus, park);
  await waitFor('the world to keep the blocked pair apart', 5000, async () => (halPark.entity !== undefined && anaPark.hidden.includes(halPark.entity) ? true : undefined));
  await listen(500);
  halPark.act({ type: 'say', text: 'Acceptance: a line from Hal' });
  await pause(5500);
  const mutes = ((await api(ana, 'GET', '/api/v1/me/mutes')).json['accounts'] ?? []) as unknown[];
  lines['3-follows'] = {
    muteSet: muted.status,
    muteListed: JSON.stringify(mutes).includes(gus.id),
    blockSet: blocked.status,
    hidden: { ana: anaPark.hidden.includes(halPark.entity ?? -1), hal: halPark.hidden.includes(anaPark.entity ?? -1) },
    voice: { anaHeardHal: heard(anaPark, halPark), halHeardAna: heard(halPark, anaPark), gusHeardHal: heard(gusPark, halPark) },
    chat: { anaReadHal: anaPark.read.get(halPark.entity ?? -1) ?? 0, gusReadHal: gusPark.read.get(halPark.entity ?? -1) ?? 0 },
  };
  passed['3'] =
    muted.status < 300 &&
    JSON.stringify(mutes).includes(gus.id) &&
    blocked.status < 300 &&
    anaPark.hidden.includes(halPark.entity ?? -1) &&
    halPark.hidden.includes(anaPark.entity ?? -1) &&
    heard(anaPark, halPark) === 0 &&
    heard(halPark, anaPark) === 0 &&
    heard(gusPark, halPark) > 0 &&
    (anaPark.read.get(halPark.entity ?? -1) ?? 0) === 0 &&
    (gusPark.read.get(halPark.entity ?? -1) ?? 0) > 0;
  await leave(anaPark, halPark, gusPark);

  // ------------------------------------------------------------------ 4. a quiet zone
  const inside = await enter(dee, park, { spawn: 'quiet' });
  const outside = await enter(eve, park, { spawn: 'near-quiet' });
  const beside = await enter(gus, park, { spawn: 'near-quiet' });
  await listen(6000);
  lines['4-quiet-zone'] = { outsideHeardInside: heard(outside, inside), insideHeardOutside: heard(inside, outside), outsideHeardBeside: heard(outside, beside) };
  passed['4'] = heard(outside, inside) === 0 && heard(inside, outside) === 0 && heard(outside, beside) > 0;
  await leave(inside, outside, beside);

  // ------------------------------------------------------------------ 5. a minor and its guardian
  const year = new Date().getUTCFullYear();
  const teenInvite = (await admin('invite', '--email', 'teen@example.org', '--note', 'acceptance')).match(/invite=(\S+)/)?.[1] ?? '';
  const teenSignup = await fetch(`${coreUrl}/signup?lang=en`, {
    method: 'POST',
    headers: { ...FORM, ...from() },
    body: new URLSearchParams({ invitation: teenInvite, email: 'teen@example.org', password: PASSWORD, displayName: 'Teen', birthMonth: '1', birthYear: String(year - 15), country: 'CO', consent: 'yes' }),
  });
  const step = /name="step" value="([^"]+)"/.exec(await teenSignup.text())?.[1] ?? '';
  const asked = await fetch(`${coreUrl}/guardian/ask?lang=en`, { method: 'POST', headers: { ...FORM, ...from() }, body: new URLSearchParams({ step, guardianEmail: 'parent@example.org', agree: 'yes' }) });
  const letter = readdirSync(mail).map((f) => readFileSync(join(mail, f), 'utf8')).find((m) => m.includes('To: parent@example.org')) ?? '';
  const invite = /invite=([^&\s]+)/.exec(letter)?.[1] ?? '';
  const teenAccess = (await signIn('teen@example.org')).access ?? '';
  const teen: Person = { email: 'teen@example.org', id: '', auth: { authorization: `Bearer ${teenAccess}` } };
  teen.id = String((await api(teen, 'GET', '/api/v1/me')).json['id'] ?? '');
  const pending = await api(teen, 'POST', `/api/v1/worlds/${plaza.id}/join`);
  const authorized = await fetch(`${coreUrl}/guardian/authorize?lang=en`, {
    method: 'POST',
    headers: { ...FORM, ...from() },
    body: new URLSearchParams({ invite, mode: 'new', email: 'parent@example.org', password: PASSWORD, displayName: 'Parent', birthMonth: '3', birthYear: '1980', country: 'CO', consent: 'yes', authorize: 'yes', abroad: 'yes' }),
  });
  // The teen asks Fran, Fran accepts; Stan is a stranger.
  await api(teen, 'POST', `/api/v1/me/friends/${fran.id}`);
  const accepted = await api(fran, 'POST', `/api/v1/me/friends/${teen.id}`);
  const minorRound = async (): Promise<Record<string, number>> => {
    const t = await enter(teen, plaza);
    const f = await enter(fran, plaza);
    const s = await enter(stan, plaza);
    await listen(500);
    t.act({ type: 'say', text: 'Acceptance: a line from the teen' });
    await pause(5500);
    const r = {
      friendHeardTeen: heard(f, t),
      teenHeardFriend: heard(t, f),
      strangerHeardTeen: heard(s, t),
      teenHeardStranger: heard(t, s),
      friendReadTeen: f.read.get(t.entity ?? -1) ?? 0,
      strangerReadTeen: s.read.get(t.entity ?? -1) ?? 0,
    };
    await leave(t, f, s);
    return r;
  };
  const friendsOnly = await minorRound();
  // The guardian widens it on the guardian's page.
  const gs = await fetch(`${coreUrl}/guardian/signin?lang=en`, { method: 'POST', headers: { ...FORM, ...from() }, body: new URLSearchParams({ email: 'parent@example.org', password: PASSWORD }), redirect: 'manual' });
  const gCookie = (gs.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const gPage = await (await fetch(`${coreUrl}/guardian?lang=en`, { headers: { cookie: gCookie } })).text();
  const gCsrf = /name="csrf" value="([^"]+)"/.exec(gPage)?.[1] ?? '';
  const widened = await fetch(`${coreUrl}/guardian/teens/${teen.id}?lang=en`, { method: 'POST', headers: { ...FORM, cookie: gCookie }, body: new URLSearchParams({ csrf: gCsrf, contact: 'everyone' }), redirect: 'manual' });
  const everyone = await minorRound();
  lines['5-minor'] = { signup: teenSignup.status, asked: asked.status, invited: invite.length > 0, beforeGuardian: pending.json['error'], authorized: authorized.status, friend: accepted.status, friendsOnly, widened: widened.status, everyone };
  passed['5'] =
    teenSignup.status === 201 &&
    pending.json['error'] === 'guardian-pending' &&
    authorized.status === 200 &&
    friendsOnly['friendHeardTeen']! > 0 &&
    friendsOnly['teenHeardFriend']! > 0 &&
    friendsOnly['strangerHeardTeen'] === 0 &&
    friendsOnly['teenHeardStranger'] === 0 &&
    friendsOnly['friendReadTeen']! > 0 &&
    friendsOnly['strangerReadTeen'] === 0 &&
    widened.status === 303 &&
    everyone['strangerHeardTeen']! > 0 &&
    everyone['teenHeardStranger']! > 0 &&
    everyone['strangerReadTeen']! > 0;

  // ------------------------------------------------------------------ 6. a report and its decision
  const filed = await api(ana, 'POST', '/api/v1/reports', {
    category: 'harassment',
    target: { kind: 'player', account: gus.id },
    text: 'Acceptance: insults in chat.',
    evidence: { world: { id: plaza.id, name: 'Owner Plaza', instance: 'relay' }, chat: [{ from: 'Gus', text: 'Acceptance evidence line', at: 1 }], near: [], times: { joined: 0, reported: 60_000, clipFrom: 45_000, clipTo: 60_000 } },
    clip: wav().toString('base64'),
  });
  const receipt = String(filed.json['receipt'] ?? '');
  const as = await fetch(`${coreUrl}/admin/signin`, { method: 'POST', headers: { ...FORM, ...from() }, body: new URLSearchParams({ email: owner.email, password: PASSWORD }), redirect: 'manual' });
  const aCookie = (as.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const queue = await (await fetch(`${coreUrl}/admin`, { headers: { cookie: aCookie } })).text();
  const aCsrf = /name="csrf" value="([^"]+)"/.exec(queue)?.[1] ?? '';
  const reportId = /action="\/admin\/reports\/([0-9a-f-]{36})"/.exec(queue)?.[1] ?? '';
  const clip = await fetch(`${coreUrl}/admin/reports/${reportId}/clip`, { headers: { cookie: aCookie } });
  const decided = await fetch(`${coreUrl}/admin/reports/${reportId}`, { method: 'POST', headers: { ...FORM, cookie: aCookie }, body: new URLSearchParams({ csrf: aCsrf, decision: 'actioned', note: 'Acceptance: the account was warned.' }), redirect: 'manual' });
  const mine = ((await api(ana, 'GET', '/api/v1/reports')).json['reports'] ?? []) as Array<{ receipt: string; status: string; decision: string }>;
  const answer = mine.find((r) => r.receipt === receipt);
  lines['6-report'] = { filed: filed.status, receipt, inQueue: queue.includes(receipt), evidence: queue.includes('Acceptance evidence line'), clip: clip.status, decided: decided.status, answer };
  passed['6'] =
    filed.status === 201 && queue.includes(receipt) && queue.includes('Acceptance evidence line') && clip.status === 200 && decided.status === 303 && answer?.status === 'actioned' && answer.decision === 'Acceptance: the account was warned.';

  // ------------------------------------------------------------------ 7. the abuse path's drill
  const drillOut = await admin('abuse', 'drill').catch((e: Error) => e.message);
  let drill: { ok?: boolean; csam?: { destinations?: string[]; intact?: boolean; allMarked?: boolean }; intimate?: { clock?: string } } = {};
  try {
    drill = JSON.parse(drillOut) as typeof drill;
  } catch {
    drill = {};
  }
  lines['7-abuse-drill'] = { ok: drill.ok === true, forms: drill.csam?.destinations, sealed: drill.csam?.intact, marked: drill.csam?.allMarked, clock: drill.intimate?.clock };
  passed['7'] = drill.ok === true;

  await stop(plaza.proc.proc);
  await stop(park.proc.proc);
  await stop(core.proc);
  ok = ['1', '2', '3', '4', '5', '6', '7'].every((k) => passed[k] === true);
} catch (err) {
  lines['error'] = { message: err instanceof Error ? err.message : String(err) };
} finally {
  clearInterval(ticking);
  for (const b of bots) b.stop();
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await run([process.execPath, join(CORE, 'scripts', 'db.ts'), 'stop', '--dir', join(dir, 'pg')]).catch(() => undefined);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
}
say('accept-stage3', { ok, passed, lines });
process.exit(ok ? 0 : 1);
