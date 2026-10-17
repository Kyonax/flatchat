// SPDX-License-Identifier: AGPL-3.0-or-later
// Trust levels (S3.09): earned by age, a verified email and active days; a hand-set level is a
// floor; the thresholds are the core's setting; joins count once a day; tokens carry the level.
import { randomBytes } from 'node:crypto';
import { openToken } from '@flatchat/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvitation } from '../src/accounts.ts';
import { buildCore } from '../src/app.ts';
import { ConfigError, readEnv } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import { sealingKey, TEST_COST } from '../src/secrets.ts';
import { startSession } from '../src/sessions.ts';
import { earnedTrust, parseTrust, trustOf } from '../src/trust.ts';
import { approveWorld } from '../src/worlds.ts';
import { freshDb } from './db.ts';

const day = 86_400_000;
const now = new Date('2026-10-17T12:00:00Z');
const facts = (ageDays: number, activeDays: number, emailVerified = true, trust = 0) => ({ trust, emailVerified, activeDays, createdAt: new Date(now.getTime() - ageDays * day) });

describe('trust levels', () => {
  it('are earned by age and active days, never without a verified email', () => {
    expect(earnedTrust(facts(0, 0), now)).toBe(0);
    expect(earnedTrust(facts(3, 1), now)).toBe(1);
    expect(earnedTrust(facts(30, 1), now)).toBe(1);
    expect(earnedTrust(facts(14, 5), now)).toBe(2);
    expect(earnedTrust(facts(60, 20), now)).toBe(3);
    expect(earnedTrust(facts(400, 400, false), now)).toBe(0);
    // A hand-set level is a floor; 4 to 7 only by hand.
    expect(trustOf(facts(0, 0, false, 5), now)).toBe(5);
    expect(trustOf(facts(60, 20, true, 1), now)).toBe(3);
  });

  it('follow the core’s setting, and refuse a setting that does not climb', () => {
    const rules = parseTrust('1:0,2:1,3:2');
    expect(earnedTrust(facts(2, 1), now, rules)).toBe(2);
    for (const bad of ['1:0,2:1', '5:1,3:1,9:9', 'x:1,2:2,3:3']) expect(() => parseTrust(bad)).toThrow();
    expect(() => readEnv({ FLATCHAT_CORE_DB: 'postgresql://x', FLATCHAT_CORE_SECRET: '00'.repeat(32), FLATCHAT_CORE_TRUST: '1:0' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});

let db: Db;
const secret = randomBytes(32);
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

describe('trust in tokens', () => {
  it('counts a day with joins once and puts the level in the connect token', async () => {
    let clock = new Date('2026-10-17T12:00:00Z');
    const app = await buildCore({ db, secret, publicUrl: 'http://127.0.0.1:1', operator: 'T', contact: 't@example.org', cost: TEST_COST, ice: { stun: [], turnUrls: [] }, now: () => clock, trust: parseTrust('0:1,0:2,0:3') });
    const code = (await createInvitation(db, { email: 'tru@example.org' }, clock)).code;
    const r = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ invitation: code, email: 'tru@example.org', password: 'a long enough password', displayName: 'Tru', birthMonth: '1', birthYear: '1990', country: 'CO', consent: 'yes' }).toString(),
    });
    expect(r.statusCode).toBe(201);
    const id = (await db.query<{ id: string }>("select id from accounts where email_key = 'tru@example.org'"))[0]!.id;
    const world = (await db.query<{ id: string }>("insert into worlds (name, owner_id, address) values ('T', $1, 'relay') returning id", [id]))[0]!.id;
    const key = await approveWorld(db, sealingKey(secret), world, 'admin:test', '', clock);
    // A day later the old access token has lapsed: each call signs in at the test's clock.
    const auth = async (): Promise<{ authorization: string }> => ({ authorization: `Bearer ${(await startSession(db, id, clock)).access}` });
    const join = async (): Promise<number> => {
      const t = (await app.inject({ method: 'POST', url: `/api/v1/worlds/${world}/join`, headers: await auth() })).json() as { token: string };
      return (await openToken(new Uint8Array(Buffer.from(t.token, 'base64url')), { key, world, now: Math.floor(clock.getTime() / 1000) })).claims.trust;
    };
    // An invitation for an email verifies it. The first join is the first active day: level 1.
    expect(await join()).toBe(1);
    expect(await join()).toBe(1);
    clock = new Date(clock.getTime() + day);
    expect(await join()).toBe(2);
    clock = new Date(clock.getTime() + day);
    expect(await join()).toBe(3);
    expect((await db.query<{ active_days: number }>('select active_days from accounts where id = $1', [id]))[0]!.active_days).toBe(3);
    expect(((await app.inject({ method: 'GET', url: '/api/v1/me', headers: await auth() })).json() as { trust: number }).trust).toBe(3);
    await app.close();
  });
});
