// SPDX-License-Identifier: AGPL-3.0-or-later
// Reports (S3.02) and their triage (S3.07): every category is taken with its evidence and voice
// clip, the reporter holds a receipt and later reads the decision; the queue puts abuse, grooming
// and threats first; an under-age report suspends the account, and the owner deletes it or lifts
// it; the public form takes reports without an account; only a WAV clip is kept, and only the
// owner hears it; evidence is purged after its time.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { KEEP_DAYS, purgeReports, REPORT_CATEGORIES } from '../src/reports.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
const PASSWORD = 'a long enough password';
const form = { 'content-type': 'application/x-www-form-urlencoded' };

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret: randomBytes(32), publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let people = 0;
async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  people += 1;
  const code = (await createInvitation(db, {}, new Date())).code;
  const r = await app.inject({
    method: 'POST',
    url: '/signup',
    remoteAddress: `10.88.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: code, email, password: PASSWORD, displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
  expect(r.statusCode).toBe(201);
  const id = (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;
  return { id, bearer: { authorization: `Bearer ${(await startSession(db, id, new Date())).access}` } };
}

async function admin(email: string): Promise<{ cookie: string; csrf: string; page: () => Promise<string> }> {
  const { id } = await account(email);
  await db.query('update accounts set admin = true where id = $1', [id]);
  const r = await app.inject({ method: 'POST', url: '/admin/signin', remoteAddress: '10.89.0.1', headers: form, payload: new URLSearchParams({ email, password: PASSWORD }).toString() });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const page = async (): Promise<string> => (await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body;
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(await page())![1]!, page };
}

/** A WAV file as the client's recorder writes it: 16 kHz, mono, 16-bit. */
function wav(samples = 1600): Buffer {
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
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  return b;
}

const evidence = (about: string) => ({
  world: { id: '0f8e2c1a-5b3d-4e6f-8a9b-1c2d3e4f5a6b', name: 'Plaza', instance: 'relay' },
  chat: [{ from: about, text: 'meet me somewhere private', at: 1 }],
  near: [{ account: '0f8e2c1a-5b3d-4e6f-8a9b-1c2d3e4f5a6b', name: about, distance: 3.2 }],
  times: { joined: 0, reported: 60_000, clipFrom: 45_000, clipTo: 60_000 },
});

describe('reports from the client', () => {
  it('take every category with its evidence and clip, give a receipt, queue the urgent first, and tell the decision', async () => {
    const owner = await admin('reports-admin@example.org');
    const reporter = await account('reporter@example.org');
    const target = await account('reported@example.org');
    const receipts: Record<string, string> = {};
    for (const category of REPORT_CATEGORIES.filter((c) => c !== 'underage')) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: reporter.bearer,
        payload: { category, target: { kind: 'player', account: target.id }, text: `about ${category}`, evidence: evidence('reported'), clip: wav().toString('base64') },
      });
      expect(r.statusCode, category).toBe(201);
      receipts[category] = (r.json() as { receipt: string }).receipt;
      expect(receipts[category]).toMatch(/^R-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
    const page = await owner.page();
    // Urgent first: abuse material, grooming and threats ahead of the rest.
    const order = [...page.matchAll(/<strong>(URGENT · )?([a-z]+)<\/strong>/g)].map((m) => m[2]);
    expect(order.slice(0, 3).sort()).toEqual(['csam', 'grooming', 'threats']);
    expect(page).toContain('meet me somewhere private');
    const mine = (await app.inject({ method: 'GET', url: '/api/v1/reports', headers: reporter.bearer })).json() as { reports: Array<{ receipt: string; status: string; decision: string }> };
    expect(mine.reports.find((r) => r.receipt === receipts['threats'])).toMatchObject({ status: 'open', decision: '' });

    const id = (await db.query<{ id: string }>('select id from reports where receipt = $1', [receipts['threats']]))[0]!.id;
    const decided = await app.inject({ method: 'POST', url: `/admin/reports/${id}`, headers: { ...form, cookie: owner.cookie }, payload: new URLSearchParams({ csrf: owner.csrf, decision: 'actioned', note: 'The account was banned.' }).toString() });
    expect(decided.statusCode).toBe(303);
    const after = (await app.inject({ method: 'GET', url: '/api/v1/reports', headers: reporter.bearer })).json() as { reports: Array<{ receipt: string; status: string; decision: string }> };
    expect(after.reports.find((r) => r.receipt === receipts['threats'])).toMatchObject({ status: 'actioned', decision: 'The account was banned.' });

    // The clip: only the owner hears it.
    const clip = await app.inject({ method: 'GET', url: `/admin/reports/${id}/clip`, headers: { cookie: owner.cookie } });
    expect(clip.statusCode).toBe(200);
    expect(clip.headers['content-type']).toBe('audio/wav');
    expect(clip.rawPayload.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect((await app.inject({ method: 'GET', url: `/admin/reports/${id}/clip` })).statusCode).toBe(404);
  });

  it('refuses a clip that is not a WAV, an unknown category and a body over its limit', async () => {
    const reporter = await account('reporter2@example.org');
    const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/reports', headers: reporter.bearer, payload });
    expect((await send({ category: 'harassment', target: { kind: 'player' }, text: 'x', clip: Buffer.from('not a wave file at all, not at all, not at all').toString('base64') })).json()).toMatchObject({ error: 'bad-clip' });
    expect((await send({ category: 'spam', target: { kind: 'player' }, text: 'x' })).statusCode).toBe(400);
    expect((await send({ category: 'harassment', target: { kind: 'player' }, text: 'x', clip: 'A'.repeat(1_200_000) })).statusCode).toBe(413);
  });
});

describe('an under-age report', () => {
  it('suspends the account at once; the owner deletes it once the age is confirmed, or lifts it', async () => {
    const owner = await admin('age-admin@example.org');
    const reporter = await account('age-reporter@example.org');
    const young = await account('young@example.org');
    const old = await account('old-enough@example.org');
    const report = async (who: string) => app.inject({ method: 'POST', url: '/api/v1/reports', headers: reporter.bearer, payload: { category: 'underage', target: { kind: 'player', account: who }, text: 'They said they are 11.' } });
    await report(young.id);
    await report(old.id);
    const statusOf = async (id: string) => (await db.query<{ status: string }>('select status from accounts where id = $1', [id]))[0]?.status;
    expect(await statusOf(young.id)).toBe('suspended');
    expect(await statusOf(old.id)).toBe('suspended');
    const reportId = async (target: string) => (await db.query<{ id: string }>('select id from reports where target_account = $1', [target]))[0]!.id;
    const decide = async (id: string, decision: string) => app.inject({ method: 'POST', url: `/admin/reports/${id}`, headers: { ...form, cookie: owner.cookie }, payload: new URLSearchParams({ csrf: owner.csrf, decision, note: '' }).toString() });
    const youngReport = await reportId(young.id);
    expect((await decide(await reportId(old.id), 'underage-cleared')).statusCode).toBe(303);
    expect(await statusOf(old.id)).toBe('active');
    expect((await decide(youngReport, 'underage-confirmed')).statusCode).toBe(303);
    expect(await statusOf(young.id)).toBeUndefined();
    // The report itself stays, with its evidence, until it is purged.
    expect((await db.query<{ status: string }>('select status from reports where id = $1', [youngReport]))[0]!.status).toBe('actioned');
  });
});

describe('the public report form', () => {
  it('takes a report without an account, in both languages, and gives a receipt', async () => {
    expect((await app.inject({ method: 'GET', url: '/report?lang=es' })).body).toContain('Material sexual con un niño, niña o adolescente');
    const empty = await app.inject({ method: 'POST', url: '/report?lang=en', remoteAddress: '10.90.0.1', headers: form, payload: new URLSearchParams({ category: 'threats', what: '', text: ' ' }).toString() });
    expect(empty.statusCode).toBe(400);
    const sent = await app.inject({
      method: 'POST',
      url: '/report?lang=en',
      remoteAddress: '10.90.0.1',
      headers: form,
      payload: new URLSearchParams({ category: 'threats', what: 'flatchat://world/0f8e2c1a-5b3d-4e6f-8a9b-1c2d3e4f5a6b', text: 'Someone threatened a friend.', contact: 'parent@example.org' }).toString(),
    });
    expect(sent.statusCode).toBe(200);
    const receipt = /R-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(sent.body)![0];
    const [row] = await db.query<{ reporter_id: string | null; reporter_contact: string; priority: number; target_kind: string }>('select reporter_id, reporter_contact, priority, target_kind from reports where receipt = $1', [receipt]);
    expect(row).toEqual({ reporter_id: null, reporter_contact: 'parent@example.org', priority: 0, target_kind: 'world' });
  });
});

describe('keeping evidence', () => {
  it('purges the evidence and the clip after six months, a year for abuse and grooming', async () => {
    const reporter = await account('purge@example.org');
    const send = (category: string) => app.inject({ method: 'POST', url: '/api/v1/reports', headers: reporter.bearer, payload: { category, target: { kind: 'other' }, text: 'evidence', evidence: evidence('x'), clip: wav().toString('base64') } });
    const ordinary = (await send('harassment')).json() as { receipt: string };
    const abuse = (await send('grooming')).json() as { receipt: string };
    const later = new Date(Date.now() + (KEEP_DAYS.ordinary + 1) * 86_400_000);
    await purgeReports(db, later);
    const row = async (receipt: string) => (await db.query<{ text: string; clip: Buffer | null; purged: boolean }>('select text, clip, purged from reports where receipt = $1', [receipt]))[0]!;
    expect(await row(ordinary.receipt)).toEqual({ text: '', clip: null, purged: true });
    expect((await row(abuse.receipt)).purged).toBe(false);
    await purgeReports(db, new Date(Date.now() + (KEEP_DAYS.abuse + 1) * 86_400_000));
    expect((await row(abuse.receipt)).purged).toBe(true);
  });
});
