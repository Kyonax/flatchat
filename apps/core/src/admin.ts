// SPDX-License-Identifier: AGPL-3.0-or-later
// The admin command line (S1.01): the owner's hands on the core, straight to its database. It reads
// the same environment as the core (src/config.ts).
//
//   node --env-file=PATH src/admin.ts secret                       a new FLATCHAT_CORE_SECRET (no database needed)
//   node --env-file=PATH src/admin.ts migrate                      apply the database migrations
//   node --env-file=PATH src/admin.ts invite [--email E] [--note N] [--days 14]
//   node --env-file=PATH src/admin.ts invites                      every invitation and its state
//   node --env-file=PATH src/admin.ts accounts
//   node --env-file=PATH src/admin.ts account EMAIL [--tester on|off] [--trust 0-7] [--status active|suspended|banned --reason R] [--admin on|off]
//                                                                  a status change needs the reason the account is shown (S3.07)
//   node --env-file=PATH src/admin.ts worlds [--status pending|approved|revoked]
//   node --env-file=PATH src/admin.ts world register --name N --owner EMAIL --address URL [--capacity 50] [--unlisted]
//                                                                  the operator's own world: the host agreement counts as accepted
//   node --env-file=PATH src/admin.ts world approve ID [--note N]  prints the world's key, once
//   node --env-file=PATH src/admin.ts world revoke ID [--note N]
//   node --env-file=PATH src/admin.ts world events ID
//   node --env-file=PATH src/admin.ts abuse drill                  the abuse path end to end with a harmless stand-in (S3.12); sends nothing
//   node --env-file=PATH src/admin.ts abuse cases                  every case, its removal, its clock and its forms
//   node --env-file=PATH src/admin.ts abuse export ID --out FILE   the sealed package, opened for a lawful request (written 0600)
//   node --env-file=PATH src/admin.ts abuse sent ID DESTINATION --reference R
//   node --env-file=PATH src/admin.ts abuse removed ID --how H     something the core could not remove, removed by hand
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { toHex } from '@flatchat/protocol';
import { abuseCases, exportCase, markRemoved, markSent, runDrill } from './abuse.ts';
import { accountByEmail, createInvitation } from './accounts.ts';
import { ConfigError, readEnv } from './config.ts';
import { Db, migrate } from './db.ts';
import { sealingKey } from './secrets.ts';
import { HOST_AGREEMENT_VERSION, moderateAccount } from './moderation.ts';
import { approveWorld, cleanAddress, cleanWorldName, listWorlds, MAX_CAPACITY, registerWorld, revokeWorld, worldById, worldEvents } from './worlds.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    note: { type: 'string', default: '' },
    days: { type: 'string', default: '14' },
    tester: { type: 'string' },
    trust: { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
    admin: { type: 'string' },
    name: { type: 'string' },
    owner: { type: 'string' },
    address: { type: 'string' },
    capacity: { type: 'string', default: '50' },
    unlisted: { type: 'boolean', default: false },
    out: { type: 'string' },
    reference: { type: 'string' },
    how: { type: 'string' },
  },
});

function fail(message: string): never {
  process.stderr.write(`admin: ${message}\n`);
  process.exit(2);
}

const say = (line: string): void => void process.stdout.write(`${line}\n`);
const when = (d: Date | null | undefined): string => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '-');

const [command, sub, arg] = positionals;
if (command === 'secret') {
  say(`FLATCHAT_CORE_SECRET=${randomBytes(32).toString('hex')}`);
  process.exit(0);
}

let env;
try {
  env = readEnv(process.env, (command === 'world' && sub === 'approve') || command === 'abuse');
} catch (err) {
  fail(err instanceof ConfigError ? err.message : String(err));
}
const db = new Db(env.db, 2);
const now = new Date();
const actor = `admin:${process.env['USER'] ?? 'owner'}`;

try {
  switch (command) {
    case 'migrate': {
      const applied = await migrate(db);
      say(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
      break;
    }
    case 'invite': {
      const days = Number(values.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days must be 1 to 90');
      const { code, expiresAt } = await createInvitation(db, { note: values.note, ...(values.email ? { email: values.email } : {}), days }, now);
      say(`invitation for ${values.email ?? 'anyone with the link'}, valid until ${when(expiresAt)}:`);
      say(`${env.publicUrl}/signup?invite=${code}`);
      break;
    }
    case 'invites': {
      const rows = await db.query<{ note: string; email_key: string | null; created_at: Date; expires_at: Date; used_at: Date | null; refused_at: Date | null }>(
        'select note, email_key, created_at, expires_at, used_at, refused_at from invitations order by created_at',
      );
      for (const r of rows) {
        const state = r.refused_at ? 'refused' : r.used_at ? 'used' : r.expires_at.getTime() <= now.getTime() ? 'expired' : 'open';
        say(`${when(r.created_at)}  ${state.padEnd(8)}  ${(r.email_key ?? '-').padEnd(32)}  ${r.note}`);
      }
      break;
    }
    case 'accounts': {
      const rows = await db.query<{ id: string; email: string; display_name: string; trust: number; tester: boolean; status: string; created_at: Date }>(
        'select id, email, display_name, trust, tester, status, created_at from accounts order by created_at',
      );
      for (const r of rows) say(`${r.id}  ${r.status.padEnd(9)}  trust ${r.trust}${r.tester ? ' tester' : ''}  ${r.email}  ${JSON.stringify(r.display_name)}  ${when(r.created_at)}`);
      break;
    }
    case 'account': {
      const email = sub ?? fail('account EMAIL');
      const a = (await accountByEmail(db, email)) ?? fail(`no account ${email}`);
      if (values.tester !== undefined) {
        if (!['on', 'off'].includes(values.tester)) fail('--tester on|off');
        await db.query('update accounts set tester = $2 where id = $1', [a.id, values.tester === 'on']);
      }
      if (values.trust !== undefined) {
        const t = Number(values.trust);
        if (!Number.isInteger(t) || t < 0 || t > 7) fail('--trust 0 to 7');
        await db.query('update accounts set trust = $2 where id = $1', [a.id, t]);
      }
      if (values.admin !== undefined) {
        if (!['on', 'off'].includes(values.admin)) fail('--admin on|off');
        await db.query('update accounts set admin = $2 where id = $1', [a.id, values.admin === 'on']);
      }
      if (values.status !== undefined) {
        if (!['active', 'suspended', 'banned'].includes(values.status)) fail('--status active|suspended|banned');
        const reason = values.reason?.trim() || fail('--reason: the account is shown why (and may appeal)');
        const action = values.status === 'active' ? 'lift' : values.status === 'suspended' ? 'suspend' : 'ban';
        const ended = await moderateAccount(db, a.id, action, reason, 'admin command line', now);
        if (action !== 'lift') say(`ended ${ended} session(s)`);
      }
      const b = (await accountByEmail(db, email))!;
      say(`${b.id}  ${b.status}  trust ${b.trust}  tester ${b.tester ? 'on' : 'off'}  email ${b.emailVerified ? 'verified' : 'not verified'}  ${JSON.stringify(b.displayName)}  since ${when(b.createdAt)}`);
      break;
    }
    case 'worlds': {
      const status = values.status as 'pending' | 'approved' | 'revoked' | undefined;
      if (status && !['pending', 'approved', 'revoked'].includes(status)) fail('--status pending|approved|revoked');
      for (const w of await listWorlds(db, status)) say(`${w.id}  ${w.status.padEnd(8)}  cap ${String(w.capacity).padStart(4)}  ${w.listed ? 'listed  ' : 'unlisted'}  ${JSON.stringify(w.name)}  ${w.address}`);
      break;
    }
    case 'world': {
      if (sub === 'register') {
        const name = cleanWorldName(values.name ?? '') ?? fail('--name: 3 to 48 characters');
        const address = cleanAddress(values.address ?? '') ?? fail('--address: an https URL, or http on a private address');
        const owner = (await accountByEmail(db, values.owner ?? '')) ?? fail(`--owner: no account ${values.owner ?? ''}`);
        const capacity = Number(values.capacity);
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) fail(`--capacity 1 to ${MAX_CAPACITY}`);
        const w = await registerWorld(db, { name, ownerId: owner.id, address, capacity, listed: !values.unlisted, agreement: HOST_AGREEMENT_VERSION }, now);
        say(`registered ${w.id} (pending): approve it with: world approve ${w.id}`);
      } else if (sub === 'approve') {
        const id = arg ?? fail('world approve ID');
        if (!(await worldById(db, id))) fail(`no world ${id}`);
        const key = await approveWorld(db, sealingKey(env.secret), id, actor, values.note, now);
        say(`approved ${id}. The world server's environment needs this key (shown once; approving again replaces it):`);
        say(`FLATCHAT_WORLD_KEY=${toHex(key)}`);
        say(`FLATCHAT_WORLD_ID=${id}`);
      } else if (sub === 'revoke') {
        const id = arg ?? fail('world revoke ID');
        await revokeWorld(db, id, actor, values.note, now);
        say(`revoked ${id}: no new connect tokens; its key is gone`);
      } else if (sub === 'events') {
        const id = arg ?? fail('world events ID');
        for (const e of await worldEvents(db, id)) say(`${when(e.at)}  ${e.kind.padEnd(10)}  ${e.actor}  ${e.note}`);
      } else {
        fail('world register|approve|revoke|events');
      }
      break;
    }
    case 'abuse': {
      if (sub === 'drill') {
        const r = await runDrill(db, env.secret, { actor, operator: env.operator, contact: env.contact }, now);
        say(JSON.stringify({ event: 'abuse-drill', ...r }, null, 2));
        if (!r.ok) process.exitCode = 1;
      } else if (sub === 'cases') {
        for (const c of await abuseCases(db, 500)) {
          say(`${c.id}  ${c.drill ? 'DRILL ' : ''}${c.kind}  opened ${when(c.openedAt)}  removed ${when(c.removedAt)}  ${c.target}`);
          if (c.clock) say(`    clock: ${c.clock}`);
          for (const f of c.forms) say(`    ${f.destination.padEnd(12)} ${f.sentAt ? `filed ${when(f.sentAt)} ${f.reference}` : 'to file'}`);
        }
      } else if (sub === 'export') {
        const id = arg ?? fail('abuse export ID --out FILE');
        const out = values.out ?? fail('--out FILE: the package holds the evidence, so it never goes to the terminal');
        const opened = (await exportCase(db, env.secret, id)) ?? fail(`no preserved package for case ${id}`);
        writeFileSync(out, JSON.stringify(opened.pack, null, 2), { mode: 0o600, flag: 'wx' });
        say(`wrote ${out} (0600). The package ${opened.intact ? 'matches' : 'DOES NOT MATCH'} its recorded SHA-256.`);
      } else if (sub === 'sent') {
        const [, , id, destination] = positionals;
        if (!id || !destination || !values.reference) fail('abuse sent ID DESTINATION --reference R');
        if (!(await markSent(db, id, destination, values.reference, now))) fail(`no unfiled ${destination} form on case ${id}`);
        say(`recorded: ${destination} filed, reference ${values.reference}`);
      } else if (sub === 'removed') {
        const id = arg ?? fail('abuse removed ID --how H');
        if (!values.how) fail('--how: how it was removed');
        if (!(await markRemoved(db, id, values.how, now))) fail(`case ${id} has no removal waiting`);
        say(`recorded: case ${id} removed by hand`);
      } else {
        fail('abuse drill|cases|export|sent|removed');
      }
      break;
    }
    default:
      fail('usage: admin.ts secret|migrate|invite|invites|accounts|account|worlds|world|abuse … (see the header of src/admin.ts)');
  }
} finally {
  await db.close();
}
