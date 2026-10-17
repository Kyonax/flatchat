// SPDX-License-Identifier: AGPL-3.0-or-later
// The guardian link (S3.04): a teen signs up, names its guardian and agrees to supervision, and
// plays no world until the guardian authorizes from the mailed link (an adult account, the address
// the teen named, world servers abroad included); the proof is kept; the guardian's page shows the
// teen's friends and sets who may reach it, which the connect token carries; each country rule.
import { randomBytes } from 'node:crypto';
import { openToken } from '@flatchat/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import type { Mail, Mailer } from '../src/mail.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { approveWorld, registerWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

let db: Db;
let app: FastifyInstance;
const secret = randomBytes(32);
const mails: Mail[] = [];
const mailer: Mailer = { kind: 'folder', send: async (m) => void mails.push(m) };
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const year = new Date().getUTCFullYear();

beforeAll(async () => {
  db = await freshDb();
  app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 'privacy@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, signup: 'open', mailer, policy: { minors: true } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let people = 0;
const post = (url: string, fields: Record<string, string>, extra: Record<string, string> = {}) => {
  people += 1;
  return app.inject({ method: 'POST', url, remoteAddress: `10.93.${people}.1`, headers: { ...form, ...extra }, payload: new URLSearchParams(fields).toString() });
};
const signup = (email: string, birthYear: number, country = 'CO') =>
  post('/signup?lang=en', { invitation: '', email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: String(birthYear), country, consent: 'yes' });
const idOf = async (email: string) => (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]?.id;
const bearer = async (email: string) => ({ authorization: `Bearer ${(await startSession(db, (await idOf(email))!, new Date())).access}` });

describe('the guardian link', () => {
  it('keeps a teen out of worlds until its guardian authorizes, keeps the proof, and gives the guardian a say', async () => {
    const owner = await signup('host@example.org', 1980);
    expect(owner.statusCode).toBe(201);
    const world = await registerWorld(db, { name: 'Teen Plaza', ownerId: (await idOf('host@example.org'))!, address: 'relay', agreement: 1 }, new Date());
    const key = await approveWorld(db, sealingKey(secret), world.id, 'admin:test', '', new Date());
    const join = async (email: string) => app.inject({ method: 'POST', url: `/api/v1/worlds/${world.id}/join`, headers: await bearer(email) });

    // The teen's sign-up ends on the guardian step.
    const teen = await signup('teen@example.org', year - 15);
    expect(teen.statusCode).toBe(201);
    expect(teen.body).toContain('One more step');
    const step = /name="step" value="([^"]+)"/.exec(teen.body)![1]!;
    expect((await post('/guardian/ask?lang=en', { step, guardianEmail: 'parent@example.org' })).statusCode).toBe(400);
    expect((await post('/guardian/ask?lang=en', { step, guardianEmail: 'parent@example.org', agree: 'yes' })).statusCode).toBe(200);
    const mail = mails.find((m) => m.to === 'parent@example.org')!;
    expect(mail.subject).toBe('teen asked to use FlatChat');
    const invite = /invite=([^&\s]+)/.exec(mail.text)![1]!;

    // Before the authorization: no world, and the teen sees why.
    expect((await join('teen@example.org')).json()).toMatchObject({ error: 'guardian-pending' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('teen@example.org') })).json()).toMatchObject({ under18: true, supervision: 'pending' });

    // The guardian reads the summary, then authorizes; a minor, another address or a missing box are refused.
    const page = await app.inject({ method: 'GET', url: `/guardian/invite?invite=${invite}&lang=es` });
    expect(page.body).toContain('servidores de mundos en el exterior');
    expect(page.body).toContain('privacy@example.org');
    const newGuardian = (email: string, birthYear: number, boxes = { authorize: 'yes', abroad: 'yes' }) =>
      post('/guardian/authorize?lang=en', { invite, mode: 'new', email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '3', birthYear: String(birthYear), country: 'CO', consent: 'yes', ...boxes });
    expect((await newGuardian('parent@example.org', year - 40, { authorize: 'yes', abroad: '' })).body).toContain('Tick both boxes');
    expect((await newGuardian('sibling@example.org', year - 16)).body).toContain('must be 18 or over');
    expect((await newGuardian('stranger@example.org', year - 40)).body).toContain('Use the email address your teen named');
    const done = await newGuardian('parent@example.org', year - 40);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('teen can play now');

    const teenId = (await idOf('teen@example.org'))!;
    const [proof] = await db.query<{ guardian_id: string; method: string; summary_version: string; abroad: boolean; authorized_at: Date; teen_agreed_at: Date }>(
      'select guardian_id, method, summary_version, abroad, authorized_at, teen_agreed_at from guardian_links where teen_id = $1',
      [teenId],
    );
    expect(proof).toMatchObject({ guardian_id: await idOf('parent@example.org'), method: 'guardian page', abroad: true });
    expect(proof!.summary_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(proof!.teen_agreed_at.getTime()).toBeLessThanOrEqual(proof!.authorized_at.getTime());
    expect((await db.query('select 1 from consents where account_id = $1 and kind = $2', [teenId, 'guardian-authorization'])).length).toBe(1);

    // Now the teen plays, reached by friends only.
    const claims = async () => {
      const r = (await join('teen@example.org')).json() as { token: string };
      return (await openToken(new Uint8Array(Buffer.from(r.token, 'base64url')), { key, world: world.id, now: Math.floor(Date.now() / 1000) })).claims;
    };
    expect(await claims()).toMatchObject({ under18: true, contact: 'friends' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: await bearer('teen@example.org') })).json()).toMatchObject({ supervision: 'authorized' });

    // The guardian's page: the teen's friends, and who may reach it.
    await app.inject({ method: 'POST', url: `/api/v1/me/friends/${await idOf('host@example.org')}`, headers: await bearer('teen@example.org') });
    await app.inject({ method: 'POST', url: `/api/v1/me/friends/${teenId}`, headers: await bearer('host@example.org') });
    const signin = await post('/guardian/signin?lang=en', { email: 'parent@example.org', password: 'a long enough password' });
    const cookie = String(signin.headers['set-cookie']).split(';')[0]!;
    const guardianPage = (await app.inject({ method: 'GET', url: '/guardian?lang=en', headers: { cookie } })).body;
    expect(guardianPage).toContain('teen');
    expect(guardianPage).toContain('host');
    const csrf = /name="csrf" value="([^"]+)"/.exec(guardianPage)![1]!;
    expect((await post(`/guardian/teens/${teenId}?lang=en`, { csrf, contact: 'everyone' }, { cookie })).statusCode).toBe(303);
    expect((await claims()).contact).toBe('everyone');
    expect((await post(`/guardian/teens/${teenId}/unfriend/${await idOf('host@example.org')}?lang=en`, { csrf }, { cookie })).statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/friends', headers: await bearer('teen@example.org') })).json()).toMatchObject({ friends: [] });
    // Someone else's teen is not theirs to change.
    expect((await post(`/guardian/teens/${await idOf('host@example.org')}?lang=en`, { csrf, contact: 'everyone' }, { cookie })).statusCode).toBe(404);
  });
});

describe('the age rule’s country rules with minors on', () => {
  it('lets 13 to 17 in with a guardian, keeps Australia at 16 and over, and keeps Brazil’s minors waiting', async () => {
    // Born in January: by now each has had this year's birthday, so the age is year minus birth year.
    expect((await signup('co13@example.org', year - 13)).body).toContain('One more step');
    expect((await signup('au15@example.org', year - 15, 'AU')).statusCode).toBe(403);
    expect((await signup('au16@example.org', year - 16, 'AU')).body).toContain('One more step');
    expect((await signup('br17@example.org', year - 17, 'BR')).statusCode).toBe(403);
    expect((await signup('kid@example.org', year - 12)).statusCode).toBe(403);
    expect(await idOf('au15@example.org')).toBeUndefined();
    expect(await idOf('br17@example.org')).toBeUndefined();
  });
});
