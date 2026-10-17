// SPDX-License-Identifier: AGPL-3.0-or-later
// The abuse path (S3.12): a report of abuse material takes the world down at once (its approval
// goes and its running sessions end over the host channel), the evidence is sealed and kept a
// year, and the authorities' forms are drafted for the owner to file by hand, nothing sent; the
// UK's form joins for UK-linked cases; an intimate-image report bans the account and logs the
// 48-hour clock; what the core cannot remove waits for a removal by hand; what the target is told
// stays neutral; the drill runs it all with a harmless stand-in; the packages go after their year.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abuseCases, ACCOUNT_REASON, exportCase, markRemoved, openAbuseCase, purgeCases, runDrill, STAND_IN, WORLD_NOTE } from '../src/abuse.ts';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { standing } from '../src/moderation.ts';
import { fileReport } from '../src/reports.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld, worldEvents } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
let base = '';
const secret = randomBytes(32);
const PASSWORD = 'a long enough password';
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const who = { actor: 'admin:test', operator: 'T', contact: 't@example.org' };

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let people = 0;
async function account(email: string, country = 'CO'): Promise<{ id: string; bearer: Record<string, string> }> {
  people += 1;
  const code = (await createInvitation(db, {}, new Date())).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.91.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: PASSWORD, displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country, consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  return { id, bearer: { authorization: `Bearer ${(await startSession(db, id, new Date())).access}` } };
}

async function admin(email: string): Promise<{ cookie: string; csrf: string; page: () => Promise<string> }> {
  const { id } = await account(email);
  await db.query('update accounts set admin = true where id = $1', [id]);
  const r = await app.inject({ method: 'POST', url: '/admin/signin', remoteAddress: '10.90.0.1', headers: form, payload: new URLSearchParams({ email, password: PASSWORD }).toString() });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const page = async (): Promise<string> => (await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body;
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(await page())![1]!, page };
}

const post = (url: string, cookie: string, fields: Record<string, string>) => app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(fields).toString() });

/** A WAV file as the client's recorder writes it: 16 kHz, mono, 16-bit. */
function wav(samples = 800): Buffer {
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
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * 6000), 44 + i * 2);
  return b;
}

/** A world on its host channel: proves its key, keeps what the core sends, and how it closed. */
function connectWorld(id: string, key: Uint8Array): Promise<{ got: Array<Record<string, unknown>>; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/v1/worlds/${id}/host`, 'flatchat-host-1');
    const got: Array<Record<string, unknown>> = [];
    let online = false;
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      got.push(m);
      if (m['type'] === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: createHmac('sha256', key).update(`flatchat host v1 ${String(m['nonce'])}`).digest('base64url') }));
      if (m['type'] === 'ice' && !online) {
        online = true;
        resolve({ got, closed });
      }
    });
    ws.addEventListener('close', () => online || reject(new Error('closed before it was online')));
  });
}

describe('the abuse path', () => {
  it('takes a reported world down at once, ends its sessions, seals the evidence and drafts the reports, sending nothing', async () => {
    const owner = await admin('abuse-admin@example.org');
    const host = await account('abuse-host@example.org');
    const reporter = await account('abuse-reporter@example.org');
    const made = await app.inject({ method: 'POST', url: '/api/v1/worlds', headers: host.bearer, payload: { name: 'Dark Corner', address: 'relay', agreement: 1 } });
    const worldId = (made.json() as { id: string }).id;
    const world = await connectWorld(worldId, await approveWorld(db, sealingKey(secret), worldId, 'admin:test', '', new Date()));

    const clip = wav();
    const filed = await app.inject({ method: 'POST', url: '/api/v1/reports', headers: reporter.bearer, payload: { category: 'csam', target: { kind: 'world', world: worldId }, text: 'The world shows abuse images on its walls.', clip: clip.toString('base64') } });
    expect(filed.statusCode).toBe(201);
    const receipt = (filed.json() as { receipt: string }).receipt;
    const reportId = (await db.query<{ id: string }>('select id from reports where receipt = $1', [receipt]))[0]!.id;

    // The queue offers the path, open, on a report of abuse material; a wrong kind is refused.
    const queue = await owner.page();
    expect(queue).toContain(`<details open><summary>Abuse path</summary>\n<form method="post" action="/admin/reports/${reportId}/abuse">`);
    expect((await post(`/admin/reports/${reportId}/abuse`, owner.cookie, { csrf: owner.csrf, kind: 'spam' })).statusCode).toBe(400);
    expect((await post(`/admin/reports/${randomUUID()}/abuse`, owner.cookie, { csrf: owner.csrf, kind: 'csam' })).statusCode).toBe(404);
    const opened = await post(`/admin/reports/${reportId}/abuse`, owner.cookie, { csrf: owner.csrf, kind: 'csam' });
    expect(opened.statusCode).toBe(303);
    expect(opened.headers['location']).toBe('/admin?done=abuse');

    // Removed: the approval is gone, the running world was told and its channel closed; the host
    // reads a neutral reason.
    expect((await db.query<{ status: string }>('select status from worlds where id = $1', [worldId]))[0]!.status).toBe('revoked');
    expect(await world.closed).toBe(4010);
    expect(world.got.at(-1)).toEqual({ type: 'revoked' });
    expect((await worldEvents(db, worldId)).at(-1)).toMatchObject({ kind: 'revoked', note: WORLD_NOTE });

    // Drafted for Colombia's two desks and NCMEC (not the UK's: nothing links it there), unsent.
    const [c] = await abuseCases(db);
    expect(c).toMatchObject({ kind: 'csam', drill: false, preserved: true, target: `world ${worldId}` });
    expect(c!.forms.map((f) => f.destination)).toEqual(['cai-virtual', 'ncmec', 'te-protejo']);
    expect(c!.forms.every((f) => f.sentAt === null && !f.draft.includes('DRILL'))).toBe(true);
    const ncmec = c!.forms.find((f) => f.destination === 'ncmec')!.draft;
    expect(ncmec).toContain('NCMEC CyberTipline');
    expect(ncmec).toContain(receipt);
    expect(ncmec).toContain('Dark Corner');
    expect(ncmec).toContain(`SHA-256 ${c!.sha256}`);
    expect(ncmec).toContain('The reporter wrote: The world shows abuse images on its walls.');

    // Preserved and sealed: no clear text in the database, and the package opens whole, clip included.
    const [sealed] = await db.query<{ preserved: Buffer }>('select preserved from abuse_cases where id = $1', [c!.id]);
    expect(sealed!.preserved.includes(Buffer.from('abuse images'))).toBe(false);
    const pack = (await exportCase(db, secret, c!.id))!;
    expect(pack.intact).toBe(true);
    const report = pack.pack['report'] as { receipt: string; clipWav: string; text: string };
    expect(report).toMatchObject({ receipt, text: 'The world shows abuse images on its walls.' });
    expect(Buffer.from(report.clipWav, 'base64').equals(clip)).toBe(true);
    expect((await exportCase(db, randomBytes(32), c!.id).catch(() => 'refused'))).toBe('refused');

    // The reporter reads that it was acted on.
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/reports', headers: reporter.bearer })).json() as { reports: Array<{ receipt: string; status: string; decision: string }> };
    expect(mine.reports.find((r) => r.receipt === receipt)).toMatchObject({ status: 'actioned', decision: 'Removed. Thank you for reporting it.' });

    // The owner files a draft by hand and records the reference it gave.
    const page = (await app.inject({ method: 'GET', url: '/admin?done=abuse', headers: { cookie: owner.cookie } })).body;
    expect(page).toContain('Taken down and preserved.');
    expect(page).toContain('NCMEC CyberTipline: to file');
    expect((await post(`/admin/abuse/${c!.id}/sent`, owner.cookie, { csrf: owner.csrf, destination: 'ncmec', reference: 'CT-12345' })).statusCode).toBe(303);
    expect((await post(`/admin/abuse/${c!.id}/sent`, owner.cookie, { csrf: owner.csrf, destination: 'ncmec', reference: 'again' })).statusCode).toBe(404);
    expect(await owner.page()).toMatch(/NCMEC CyberTipline: filed \d{4}-\d{2}-\d{2}, CT-12345/);
  });

  it('bans a reported account on an intimate-image report, tells it a neutral reason, and logs the 48-hour clock', async () => {
    const shared = await account('abuse-sharer@example.org');
    const t0 = new Date('2026-10-17T10:00:00Z');
    const r1 = await fileReport(db, { category: 'intimate', target: { kind: 'player', account: shared.id }, text: 'Pictures of me, shared without my consent.' }, t0);
    const quick = await openAbuseCase(db, secret, { kind: 'intimate', reportId: r1.id, ...who }, new Date(t0.getTime() + 3 * 3_600_000));
    expect(quick.destinations).toEqual([]);
    expect(quick.clock).toBe('removed 3.0 h after the report, within the 48-hour limit (due 2026-10-19T10:00:00.000Z)');
    expect((await db.query<{ status: string }>('select status from accounts where id = $1', [shared.id]))[0]!.status).toBe('banned');
    expect(await standing(db, shared.id)).toMatchObject({ action: 'ban', reason: ACCOUNT_REASON });

    const other = await account('abuse-sharer2@example.org');
    const r2 = await fileReport(db, { category: 'intimate', target: { kind: 'player', account: other.id }, text: 'Pictures of me again.' }, t0);
    const late = await openAbuseCase(db, secret, { kind: 'intimate', reportId: r2.id, ...who }, new Date(t0.getTime() + 50 * 3_600_000));
    expect(late.clock).toContain('past the 48-hour limit');
  });

  it('drafts the UK’s form for a UK-linked case', async () => {
    const uk = await account('abuse-uk@example.org', 'GB');
    const r = await fileReport(db, { category: 'csam', target: { kind: 'avatar', account: uk.id }, text: 'The avatar is abuse material.' }, new Date());
    expect((await openAbuseCase(db, secret, { kind: 'csam', reportId: r.id, ...who }, new Date())).destinations).toEqual(['te-protejo', 'cai-virtual', 'ncmec', 'nca']);
    const other = await account('abuse-co@example.org');
    const r2 = await fileReport(db, { category: 'csam', target: { kind: 'player', account: other.id }, text: 'Seen with a UK victim.' }, new Date());
    expect((await openAbuseCase(db, secret, { kind: 'csam', reportId: r2.id, ukLinked: true, ...who }, new Date())).destinations).toContain('nca');
  });

  it('keeps a case the core cannot remove waiting for a removal by hand, with its clock', async () => {
    const t0 = new Date('2026-10-17T10:00:00Z');
    const r = await fileReport(db, { category: 'intimate', target: { kind: 'other', ref: 'a picture posted outside FlatChat' }, text: 'It is me.' }, t0);
    const c = await openAbuseCase(db, secret, { kind: 'intimate', reportId: r.id, ...who }, t0);
    expect(c.removed).toEqual([]);
    expect(c.clock).toBe('due by 2026-10-19T10:00:00.000Z: not removed yet');
    expect(await markRemoved(db, c.id, 'the site took it down at our request', new Date(t0.getTime() + 10 * 3_600_000))).toBe(true);
    expect(await markRemoved(db, c.id, 'twice', new Date())).toBe(false);
    const [row] = await db.query<{ removal: string; clock: string }>('select removal, clock from abuse_cases where id = $1', [c.id]);
    expect(row).toEqual({ removal: 'removed by hand: the site took it down at our request', clock: 'removed 10.0 h after the report, within the 48-hour limit (due 2026-10-19T10:00:00.000Z)' });
  });

  it('runs the drill end to end with a harmless stand-in, marks every draft, and leaves no stand-in behind', async () => {
    const count = async () => Number((await db.query<{ n: string }>('select count(*) as n from accounts'))[0]!.n);
    const before = await count();
    const r = await runDrill(db, secret, who, new Date());
    expect(r.ok).toBe(true);
    expect(r.csam).toMatchObject({ intact: true, standIn: true, drafts: 4, allMarked: true, destinations: ['te-protejo', 'cai-virtual', 'ncmec', 'nca'] });
    expect(r.intimate.clock).toContain('within the 48-hour limit');
    const pack = (await exportCase(db, secret, r.csam.id))!.pack;
    expect(Buffer.from((pack['files'] as Record<string, { base64: string }>)['stand-in.txt']!.base64, 'base64').equals(Buffer.from(STAND_IN))).toBe(true);
    expect((await db.query("select 1 from accounts where email_key like '%@drill.invalid'")).length).toBe(0);
    expect((await db.query("select 1 from worlds where name = 'Abuse path drill'")).length).toBe(0);
    expect(await count()).toBe(before);
    const cases = (await abuseCases(db)).filter((c) => c.drill);
    expect(cases).toHaveLength(2);
    expect(cases.flatMap((c) => c.forms).every((f) => f.draft.startsWith('DRILL: DO NOT SEND'))).toBe(true);
  });

  it('drops the sealed packages after their year and keeps the cases', async () => {
    const all = await abuseCases(db, 500);
    // Every case here opened within a few days of now, so 400 days on, every package is past its year.
    expect(await purgeCases(db, new Date(Date.now() + 400 * 86_400_000))).toBe(all.length);
    expect(await exportCase(db, secret, all[0]!.id)).toBeUndefined();
    const after = await abuseCases(db, 500);
    expect(after).toHaveLength(all.length);
    expect(after.every((c) => !c.preserved && c.sha256.length === 64)).toBe(true);
  });
});
