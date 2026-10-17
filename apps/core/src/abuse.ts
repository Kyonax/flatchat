// SPDX-License-Identifier: AGPL-3.0-or-later
// The abuse path (S3.12, OQ-17): remove, preserve, report. A case opens from a report of child
// sexual abuse material or of intimate images shared without consent. The target comes down at
// once (a world loses its approval and its running sessions, an account is banned); the evidence
// the core holds (the report, its chat lines and voice clip, the target's records, and from Stage 4
// the uploaded files) is sealed under a key derived from the core's secret and kept for a year; and
// the reports to the authorities are drafted: Te Protejo and the police's CAI Virtual in Colombia,
// NCMEC's CyberTipline (once the owner is registered as a provider), and the UK's National Crime
// Agency for UK-linked cases. Nothing is ever sent from here: the owner files each draft on the
// official site and records the reference it got. Intimate images come down at once too, and their
// 48-hour clock (the US TAKE IT DOWN Act) is logged with the case. Uploaded textures get a hash
// check once Microsoft's PhotoDNA accepts the platform; until then they are reviewed by hand.
//
// What the target is told stays neutral (a serious breach of the rules): a statement of reasons,
// without tipping off anyone that a report to the authorities is being drafted.
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Sql } from './db.ts';
import { moderateAccount } from './moderation.ts';
import { deleteAccount, fileReport } from './reports.ts';
import { evidenceKey, openBytes, sealBytes } from './secrets.ts';
import { registerWorld, revokeWorld } from './worlds.ts';

export const PRESERVE_DAYS = 365;
export const TAKE_DOWN_HOURS = 48;
export const ABUSE_KINDS = ['csam', 'intimate'] as const;
export type AbuseKind = (typeof ABUSE_KINDS)[number];

export const DESTINATIONS = {
  'te-protejo': { name: 'Te Protejo', where: 'https://www.teprotejo.org', note: 'Colombia’s line for reporting child sexual abuse material online.' },
  'cai-virtual': { name: 'CAI Virtual, Policía Nacional de Colombia', where: 'https://caivirtual.policia.gov.co', note: 'The Colombian police’s cybercrime desk.' },
  ncmec: { name: 'NCMEC CyberTipline', where: 'https://report.cybertip.org', note: 'Filed by a registered electronic service provider: the owner registers first.' },
  nca: { name: 'National Crime Agency, CEOP (United Kingdom)', where: 'https://www.ceop.police.uk/Safety-Centre/', note: 'For cases linked to the United Kingdom.' },
} as const;
export type Destination = keyof typeof DESTINATIONS;

/** What the target is shown: a statement of reasons that tips no one off. */
export const ACCOUNT_REASON = 'Banned for a serious breach of the community rules.';
export const WORLD_NOTE = 'Revoked for a serious breach of the host agreement.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AbuseError extends Error {}

export interface OpenCase {
  kind: AbuseKind;
  /** The report the case comes from: what it is about comes down. */
  reportId?: string;
  /** What comes down when there is no report (the command line). */
  target?: { world?: string; account?: string };
  /** A case linked to the United Kingdom: the NCA's form is drafted too (also when the account
   *  or the world's host is in the UK). */
  ukLinked?: boolean;
  /** A drill with a harmless stand-in: every step runs, and every draft says not to send it. */
  drill?: boolean;
  /** Files to preserve with the case, by name (the drill's stand-in; Stage 4's uploads). */
  files?: Record<string, Uint8Array>;
  actor: string;
  /** Who runs the platform and how the authorities reach them, for the drafts. */
  operator: string;
  contact: string;
}

export interface OpenedCase {
  id: string;
  removed: string[];
  /** The world whose approval went: the caller ends its running sessions over the host channel. */
  revokedWorld: string | undefined;
  sha256: string;
  destinations: Destination[];
  clock: string;
}

interface ReportRow {
  id: string;
  receipt: string;
  status: string;
  category: string;
  target_kind: string;
  target_account: string | null;
  target_world: string | null;
  target_ref: string;
  text: string;
  evidence: unknown;
  clip: Buffer | null;
  created_at: Date;
  reporter_id: string | null;
}

/** Opens a case: removes the target, seals the evidence, drafts the reports, starts the clock. */
export async function openAbuseCase(db: Db, secret: Uint8Array, o: OpenCase, now: Date): Promise<OpenedCase> {
  if (!ABUSE_KINDS.includes(o.kind)) throw new AbuseError('the abuse path is for abuse material and intimate images');
  let r: ReportRow | undefined;
  if (o.reportId !== undefined) {
    if (!UUID.test(o.reportId)) throw new AbuseError('no such report');
    [r] = await db.query<ReportRow>(
      'select id, receipt, status, category, target_kind, target_account, target_world, target_ref, text, evidence, clip, created_at, reporter_id from reports where id = $1',
      [o.reportId],
    );
    if (!r) throw new AbuseError('no such report');
  }
  // A report about a world takes the world down; one about a player, an avatar or an item, the
  // account behind it. Anything else (a file outside the platform) is removed by hand.
  const target = r ? (r.target_kind === 'world' ? { world: r.target_world ?? undefined } : { account: r.target_account ?? undefined }) : (o.target ?? {});
  const [world] = target.world && UUID.test(target.world)
    ? await db.query<{ id: string; name: string; owner_id: string; owner_country: string | null; address: string; status: string; created_at: Date; approved_at: Date | null }>(
        'select w.id, w.name, w.owner_id, a.country as owner_country, w.address, w.status, w.created_at, w.approved_at from worlds w left join accounts a on a.id = w.owner_id where w.id = $1',
        [target.world],
      )
    : [];
  const [account] = target.account && UUID.test(target.account)
    ? await db.query<{ id: string; display_name: string; email: string; country: string; created_at: Date; status: string }>('select id, display_name, email, country, created_at, status from accounts where id = $1', [target.account])
    : [];
  const uk = o.ukLinked === true || account?.country === 'GB' || world?.owner_country === 'GB';
  const drill = o.drill === true;
  const [c] = await db.query<{ id: string }>(
    `insert into abuse_cases (report_id, kind, drill, target_world, target_account, uk_linked, opened_at, preserve_until, due_at, opened_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      r?.id ?? null,
      o.kind,
      drill,
      world?.id ?? '',
      account?.id ?? '',
      uk,
      now,
      new Date(now.getTime() + PRESERVE_DAYS * 86_400_000),
      o.kind === 'intimate' ? new Date((r?.created_at ?? now).getTime() + TAKE_DOWN_HOURS * 3_600_000) : null,
      o.actor,
    ],
  );
  const id = c!.id;
  const tag = drill ? 'Drill: ' : '';

  // 1. Remove, at once.
  const removed: string[] = [];
  if (world) {
    if (world.status !== 'revoked') await revokeWorld(db, world.id, o.actor, `${tag}${WORLD_NOTE}`, now);
    removed.push('the world’s approval is revoked and its sessions end: no one can join it');
  }
  if (account) {
    if (account.status !== 'banned') await moderateAccount(db, account.id, 'ban', `${tag}${ACCOUNT_REASON}`, o.actor, now);
    removed.push('the account is banned: it can neither sign in nor join');
  }
  const removedAt = removed.length > 0 ? now : null;
  const removal = removed.length > 0 ? removed.join('; ') : 'nothing the core can remove: remove it by hand, then record it';

  // 2. Preserve: the report with its evidence and clip, the target's records and the files,
  //    sealed (the case id is the label, so a sealed package cannot pass for another case's).
  const pack = {
    case: id,
    drill,
    kind: o.kind,
    opened: now.toISOString(),
    removal,
    ukLinked: uk,
    world: world ?? null,
    account: account ?? null,
    report: r
      ? { receipt: r.receipt, category: r.category, target: { kind: r.target_kind, account: r.target_account, world: r.target_world, ref: r.target_ref }, text: r.text, evidence: r.evidence, clipWav: r.clip ? r.clip.toString('base64') : null, created: r.created_at.toISOString(), reporter: r.reporter_id }
      : null,
    files: Object.fromEntries(Object.entries(o.files ?? {}).map(([name, bytes]) => [name, { sha256: sha256(bytes), base64: Buffer.from(bytes).toString('base64') }])),
  };
  const plain = Buffer.from(JSON.stringify(pack), 'utf8');
  const hash = sha256(plain);
  await db.query('update abuse_cases set removed_at = $2, removal = $3, preserved = $4, preserved_sha256 = $5 where id = $1', [id, removedAt, removal, sealBytes(evidenceKey(secret), id, plain), hash]);

  // 3. Report: drafts for the owner to file by hand on each official site.
  const destinations: Destination[] = o.kind === 'csam' ? ['te-protejo', 'cai-virtual', 'ncmec', ...(uk ? (['nca'] as const) : [])] : [];
  for (const d of destinations) {
    const text = draft(d, { id, drill, kind: o.kind, opened: now, removal, removedAt, world, account, report: r, sha256: hash, operator: o.operator, contact: o.contact });
    await db.query('insert into abuse_forms (case_id, destination, draft) values ($1, $2, $3)', [id, d, text]);
  }

  // 4. The 48-hour clock for intimate images, from the report.
  const clock = o.kind === 'intimate' ? await logClock(db, id, r?.created_at ?? now, removedAt) : '';

  // The report is answered: its reporter sees that it was acted on.
  if (r?.status === 'open') {
    await db.query("update reports set status = 'actioned', decided_at = $2, decided_by = $3, decision = $4 where id = $1 and status = 'open'", [r.id, now, o.actor, 'Removed. Thank you for reporting it.']);
  }
  return { id, removed, revokedWorld: world?.id, sha256: hash, destinations, clock };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function logClock(db: Sql, id: string, from: Date, removedAt: Date | null): Promise<string> {
  const due = new Date(from.getTime() + TAKE_DOWN_HOURS * 3_600_000);
  let clock: string;
  if (removedAt) {
    const hours = (removedAt.getTime() - from.getTime()) / 3_600_000;
    clock = `removed ${hours.toFixed(1)} h after the report, ${removedAt <= due ? 'within' : 'past'} the ${TAKE_DOWN_HOURS}-hour limit (due ${due.toISOString()})`;
  } else {
    clock = `due by ${due.toISOString()}: not removed yet`;
  }
  await db.query('update abuse_cases set clock = $2 where id = $1', [id, clock]);
  return clock;
}

interface DraftFacts {
  id: string;
  drill: boolean;
  kind: AbuseKind;
  opened: Date;
  removal: string;
  removedAt: Date | null;
  world: { id: string; name: string; owner_id: string; address: string } | undefined;
  account: { id: string; display_name: string; country: string } | undefined;
  report: ReportRow | undefined;
  sha256: string;
  operator: string;
  contact: string;
}

function draft(d: Destination, c: DraftFacts): string {
  const dest = DESTINATIONS[d];
  const where = [
    c.world ? `world "${c.world.name}" (${c.world.id}), hosted by account ${c.world.owner_id} at ${c.world.address}` : '',
    c.account ? `account ${c.account.id}, display name "${c.account.display_name}", country ${c.account.country}` : '',
    c.report?.target_ref ? `reported item: ${c.report.target_ref}` : '',
  ].filter(Boolean);
  return [
    ...(c.drill ? ['DRILL: DO NOT SEND. This draft comes from the abuse path drill, with a harmless stand-in file.', ''] : []),
    `To: ${dest.name}, ${dest.where}. ${dest.note}`,
    `From: FlatChat, a social world platform. Operator: ${c.operator}. Contact: ${c.contact}.`,
    `Case: ${c.id}${c.report ? `, from report ${c.report.receipt} of ${c.report.created_at.toISOString()}` : ''}; opened ${c.opened.toISOString()}.`,
    `What: ${c.kind === 'csam' ? 'suspected child sexual abuse material' : 'intimate images shared without consent'}.`,
    `Where: ${where.length > 0 ? where.join('; ') : 'see the preserved evidence'}.`,
    `Removed: ${c.removedAt ? `${c.removedAt.toISOString()}, ${c.removal}` : c.removal}.`,
    `Evidence: preserved and sealed (SHA-256 ${c.sha256}), kept for a year, and given to the authorities on a lawful request.`,
    ...(c.report?.text ? ['', `The reporter wrote: ${c.report.text}`] : []),
  ].join('\n');
}

export interface CaseRow {
  id: string;
  kind: AbuseKind;
  drill: boolean;
  target: string;
  openedAt: Date;
  removedAt: Date | null;
  removal: string;
  preserveUntil: Date;
  preserved: boolean;
  sha256: string;
  clock: string;
  forms: Array<{ destination: Destination; draft: string; sentAt: Date | null; reference: string }>;
}

/** The cases, newest first, with their drafts, for the admin page. */
export async function abuseCases(db: Sql, limit = 50): Promise<CaseRow[]> {
  const cases = await db.query<{ id: string; kind: AbuseKind; drill: boolean; target_world: string; target_account: string; opened_at: Date; removed_at: Date | null; removal: string; preserve_until: Date; preserved: boolean; preserved_sha256: string; clock: string }>(
    'select id, kind, drill, target_world, target_account, opened_at, removed_at, removal, preserve_until, preserved is not null as preserved, preserved_sha256, clock from abuse_cases order by opened_at desc limit $1',
    [limit],
  );
  const out: CaseRow[] = [];
  for (const c of cases) {
    const forms = await db.query<{ destination: Destination; draft: string; sent_at: Date | null; reference: string }>('select destination, draft, sent_at, reference from abuse_forms where case_id = $1 order by destination', [c.id]);
    out.push({
      id: c.id,
      kind: c.kind,
      drill: c.drill,
      target: [c.target_world ? `world ${c.target_world}` : '', c.target_account ? `account ${c.target_account}` : ''].filter(Boolean).join(', ') || 'removed by hand',
      openedAt: c.opened_at,
      removedAt: c.removed_at,
      removal: c.removal,
      preserveUntil: c.preserve_until,
      preserved: c.preserved,
      sha256: c.preserved_sha256,
      clock: c.clock,
      forms: forms.map((f) => ({ destination: f.destination, draft: f.draft, sentAt: f.sent_at, reference: f.reference })),
    });
  }
  return out;
}

/** The owner filed a draft on the official site: the reference it got. */
export async function markSent(db: Sql, caseId: string, destination: string, reference: string, now: Date): Promise<boolean> {
  if (!UUID.test(caseId) || !(destination in DESTINATIONS)) return false;
  return (await db.query('update abuse_forms set sent_at = $3, reference = $4 where case_id = $1 and destination = $2 and sent_at is null returning case_id', [caseId, destination, now, reference.trim().slice(0, 200)])).length > 0;
}

/** Something the core could not remove was removed by hand: when, how, and the clock. */
export async function markRemoved(db: Sql, caseId: string, how: string, now: Date): Promise<boolean> {
  if (!UUID.test(caseId)) return false;
  const [c] = await db.query<{ kind: AbuseKind; opened_at: Date; reported_at: Date | null }>(
    'select c.kind, c.opened_at, r.created_at as reported_at from abuse_cases c left join reports r on r.id = c.report_id where c.id = $1 and c.removed_at is null',
    [caseId],
  );
  if (!c) return false;
  await db.query('update abuse_cases set removed_at = $2, removal = $3 where id = $1', [caseId, now, `removed by hand: ${how.trim().slice(0, 300)}`]);
  if (c.kind === 'intimate') await logClock(db, caseId, c.reported_at ?? c.opened_at, now);
  return true;
}

/** The preserved package, opened for a lawful request (the admin command line only). */
export async function exportCase(db: Sql, secret: Uint8Array, caseId: string): Promise<{ pack: Record<string, unknown>; intact: boolean } | undefined> {
  if (!UUID.test(caseId)) return undefined;
  const [c] = await db.query<{ preserved: Buffer | null; preserved_sha256: string }>('select preserved, preserved_sha256 from abuse_cases where id = $1', [caseId]);
  if (!c?.preserved) return undefined;
  const plain = openBytes(evidenceKey(secret), caseId, c.preserved);
  return { pack: JSON.parse(plain.toString('utf8')) as Record<string, unknown>, intact: sha256(plain) === c.preserved_sha256 };
}

/** Drops sealed packages past their year; each case's record stays. */
export async function purgeCases(db: Sql, now: Date): Promise<number> {
  return (await db.query('update abuse_cases set preserved = null where preserve_until <= $1 and preserved is not null returning id', [now])).length;
}

// --------------------------------------------------------------------------- the drill

/** The harmless stand-in the drill preserves in place of real material. */
export const STAND_IN = new TextEncoder().encode('FlatChat abuse path drill: a harmless stand-in file. It shows nothing.\n');

export interface DrillResult {
  ok: boolean;
  csam: OpenedCase & { intact: boolean; standIn: boolean; drafts: number; allMarked: boolean };
  intimate: OpenedCase;
}

/** Runs the abuse path end to end with a stand-in world, account and file, sending nothing: a
 *  report of abuse material takes the stand-in world down, preserves and seals the stand-in, and
 *  drafts every form marked DRILL; a report of intimate images bans the stand-in account and logs
 *  the 48-hour clock. The stand-ins are deleted afterwards; the drill's cases stay, marked so. */
export async function runDrill(db: Db, secret: Uint8Array, who: { actor: string; operator: string; contact: string }, now: Date): Promise<DrillResult> {
  const tag = randomBytes(6).toString('hex');
  const [stand] = await db.query<{ id: string }>(
    "insert into accounts (email, email_key, password_hash, display_name, birth_year, birth_month, country, created_at) values ($1, $1, '!', 'Abuse path drill', 1990, 1, 'GB', $2) returning id",
    [`drill-${tag}@drill.invalid`, now],
  );
  const accountId = stand!.id;
  try {
    const world = await registerWorld(db, { name: 'Abuse path drill', ownerId: accountId, address: 'http://127.0.0.1:9/drill', listed: false, agreement: 1 }, now);
    await db.query("update worlds set status = 'approved', approved_at = $2 where id = $1", [world.id, now]);
    const opts = { drill: true, ...who };

    const report = await fileReport(db, { category: 'csam', target: { kind: 'world', world: world.id }, text: 'Drill: a stand-in for abuse material in this world.' }, now);
    const csam = await openAbuseCase(db, secret, { kind: 'csam', reportId: report.id, files: { 'stand-in.txt': STAND_IN }, ...opts }, now);
    const opened = await exportCase(db, secret, csam.id);
    const files = (opened?.pack['files'] ?? {}) as Record<string, { sha256: string; base64: string }>;
    const standIn = files['stand-in.txt']?.sha256 === sha256(STAND_IN) && Buffer.from(files['stand-in.txt']?.base64 ?? '', 'base64').equals(Buffer.from(STAND_IN));
    const drafts = await db.query<{ draft: string }>('select draft from abuse_forms where case_id = $1', [csam.id]);
    const [w] = await db.query<{ status: string }>('select status from worlds where id = $1', [world.id]);

    const intimateReport = await fileReport(db, { category: 'intimate', target: { kind: 'player', account: accountId }, text: 'Drill: a stand-in for intimate images of me.' }, now);
    const intimate = await openAbuseCase(db, secret, { kind: 'intimate', reportId: intimateReport.id, ...opts }, now);
    const [a] = await db.query<{ status: string }>('select status from accounts where id = $1', [accountId]);

    const allMarked = drafts.every((d) => d.draft.startsWith('DRILL: DO NOT SEND'));
    const result = {
      csam: { ...csam, intact: opened?.intact === true, standIn, drafts: drafts.length, allMarked },
      intimate,
    };
    const ok =
      w?.status === 'revoked' && a?.status === 'banned' && result.csam.intact && standIn && allMarked && csam.destinations.length === 4 && drafts.length === 4 && intimate.clock.includes('within the 48-hour limit');
    return { ok, ...result };
  } finally {
    await deleteAccount(db, accountId);
  }
}
