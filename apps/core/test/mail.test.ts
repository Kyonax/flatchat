// SPDX-License-Identifier: AGPL-3.0-or-later
// Email sign-up (S3.03): open sign-up takes anyone through the age rule, and mails a verification
// link through Resend's API (here a mail catcher on loopback, as in CI); the link verifies the
// address once; a new link waits ten minutes; a failing mail service leaves the account usable;
// the settings refuse a Resend mailer without its key.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/app.ts';
import { ConfigError, readEnv } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import { resendMailer } from '../src/mail.ts';
import { TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { freshDb } from './db.ts';

interface Caught {
  /** The Authorization header the catcher saw. */
  header: string;
  body: { from: string; to: string[]; subject: string; text: string };
}

let db: Db;
let app: FastifyInstance;
let catcher: Server;
const caught: Caught[] = [];
let failing = false;
let clock = new Date('2026-10-17T12:00:00Z');
const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
const form = { 'content-type': 'application/x-www-form-urlencoded' };

beforeAll(async () => {
  db = await freshDb();
  // The mail catcher: Resend's POST /emails, kept in memory.
  catcher = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (failing) {
        res.writeHead(500).end();
        return;
      }
      const header = req.headers['authorization'] ?? '';
      caught.push({ header, body: JSON.parse(data) as Caught['body'] });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"test"}');
    });
  });
  await new Promise<void>((r) => catcher.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(catcher.address() as AddressInfo).port}`;
  app = await buildCore({
    db,
    secret: randomBytes(32),
    publicUrl: 'http://127.0.0.1:1',
    operator: 'T',
    contact: 't@example.org',
    cost: TEST_COST,
    ice: { stun: [], turnUrls: [] },
    now: () => clock,
    signup: 'open',
    mailer: resendMailer({ key: 're_test_key', from: 'FlatChat <noreply@example.org>', base }),
    log: (event, fields = {}) => void logs.push({ event, fields }),
  });
});
afterAll(async () => {
  await app.close();
  await db.close();
  catcher.close();
});

let people = 0;
const signup = (email: string) => {
  people += 1;
  return app.inject({
    method: 'POST',
    url: '/signup?lang=en',
    remoteAddress: `10.92.${people}.1`,
    headers: form,
    payload: new URLSearchParams({ invitation: '', email, password: 'a long enough password', displayName: email.split('@')[0]!, birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
  });
};
const idOf = async (email: string) => (await db.query<{ id: string }>('select id from accounts where email_key = $1', [email]))[0]!.id;

describe('open sign-up', () => {
  it('shows the form without an invitation, mails a link, and the link verifies the address once', async () => {
    expect((await app.inject({ method: 'GET', url: '/signup?lang=en' })).statusCode).toBe(200);
    const r = await signup('open@example.org');
    expect(r.statusCode).toBe(201);
    expect(r.body).toContain('We sent you an email');
    expect(caught).toHaveLength(1);
    expect(caught[0]).toMatchObject({ header: 'Bearer re_test_key', body: { from: 'FlatChat <noreply@example.org>', to: ['open@example.org'], subject: 'Confirm your email for FlatChat' } });
    const link = /http:\/\/127\.0\.0\.1:1(\/verify\?token=[^\s&]+&lang=en)/.exec(caught[0]!.body.text)![1]!;
    const id = await idOf('open@example.org');
    const verified = async () => (await db.query<{ email_verified: boolean }>('select email_verified from accounts where id = $1', [id]))[0]!.email_verified;
    expect(await verified()).toBe(false);
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(200);
    expect(await verified()).toBe(true);
    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(410);
    // The log never holds an address or a link.
    expect(JSON.stringify(logs)).not.toContain('open@example.org');
    expect(JSON.stringify(logs)).not.toContain('verify?token');
  });

  it('sends a new link at most every ten minutes', async () => {
    await signup('again@example.org');
    const before = caught.length;
    const auth = { authorization: `Bearer ${(await startSession(db, await idOf('again@example.org'), clock)).access}` };
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/verify', headers: auth })).statusCode).toBe(429);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/verify', headers: auth })).statusCode).toBe(202);
    expect(caught.length).toBe(before + 1);
  });

  it('keeps the account when the mail service fails, and says so in the log without the address', async () => {
    failing = true;
    const r = await signup('nomail@example.org');
    failing = false;
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain('We sent you an email');
    expect(logs.find((l) => l.event === 'mail-failed')?.fields).toEqual({ kind: 'resend', why: 'the mail service answered 500' });
  });
});

describe('the mail settings', () => {
  it('need a Resend key and a sender', () => {
    const base = { FLATCHAT_CORE_DB: 'postgresql://x', FLATCHAT_CORE_SECRET: '00'.repeat(32) };
    expect(() => readEnv({ ...base, FLATCHAT_CORE_MAIL: 'resend', FLATCHAT_CORE_MAIL_FROM: 'a <b@c.d>' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => readEnv({ ...base, FLATCHAT_CORE_MAIL: 'resend', FLATCHAT_CORE_RESEND_KEY: 'k' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(readEnv({ ...base, FLATCHAT_CORE_MAIL: 'resend', FLATCHAT_CORE_RESEND_KEY: 'k', FLATCHAT_CORE_MAIL_FROM: 'a <b@c.d>' } as NodeJS.ProcessEnv).mail.kind).toBe('resend');
    expect(readEnv(base as NodeJS.ProcessEnv)).toMatchObject({ signup: 'invite', mail: { kind: 'none' } });
    expect(() => readEnv({ ...base, FLATCHAT_CORE_SIGNUP: 'anyone' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});
