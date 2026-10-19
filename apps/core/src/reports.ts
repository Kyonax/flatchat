// SPDX-License-Identifier: AGPL-3.0-or-later
// Reports (S3.02, OQ-12, OQ-18) and their triage queue (S3.07). A player reports a player, an
// avatar, a world or an item from the client, with its evidence: the chat excerpt, the world and
// instance, who was near, the times, and a short voice clip from the reporter's own client; a person
// without an account uses the public form. The reporter gets a receipt, then the decision. The
// queue puts abuse material, grooming and threats to life first (hours), the rest after (days). A
// report that an account is under age suspends it until the owner looks; a confirmed one deletes
// the account. Evidence is kept for about six months (a year for abuse material and grooming:
// S3.12), then purged.
import { randomBytes } from 'node:crypto';
import type { Db, Sql } from './db.ts';
import { moderateAccount } from './moderation.ts';

export const REPORT_CATEGORIES = ['csam', 'grooming', 'threats', 'intimate', 'underage', 'harassment', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const TARGET_KINDS = ['player', 'avatar', 'world', 'item', 'other'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Within hours: child sexual abuse material, grooming, threats to life. */
export const URGENT: ReadonlySet<ReportCategory> = new Set(['csam', 'grooming', 'threats']);
/** How long a report's evidence is kept, in days. */
export const KEEP_DAYS = { ordinary: 183, abuse: 365 };
/** The voice clip's largest size: about 20 s of 16 kHz WAV. */
export const CLIP_MAX = 700 * 1024;
export const TEXT_MAX = 2000;

export class ReportError extends Error {}

export interface Evidence {
  world?: { id: string; name: string; instance: string };
  chat?: Array<{ from: string; text: string; at: number }>;
  near?: Array<{ account: string; name: string; distance: number }>;
  speech?: Array<{ account: string; name: string; from: number; to: number }>;
  times?: { joined: number; reported: number; clipFrom?: number; clipTo?: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** What the client sends as evidence, kept to known fields and sizes. */
export function cleanEvidence(raw: unknown): Evidence {
  const e = obj(raw);
  const out: Evidence = {};
  const w = obj(e['world']);
  if (typeof w['id'] === 'string' && UUID.test(w['id'])) out.world = { id: w['id'], name: text(w['name'], 64), instance: text(w['instance'], 200) };
  if (Array.isArray(e['chat'])) out.chat = arr(e['chat'], 50).map((l) => ({ from: text(obj(l)['from'], 64), text: text(obj(l)['text'], 300), at: num(obj(l)['at']) }));
  if (Array.isArray(e['near'])) out.near = arr(e['near'], 64).flatMap((p) => (typeof obj(p)['account'] === 'string' && UUID.test(obj(p)['account'] as string) ? [{ account: obj(p)['account'] as string, name: text(obj(p)['name'], 64), distance: Math.round(num(obj(p)['distance']) * 10) / 10 }] : []));
  if (Array.isArray(e['speech'])) out.speech = arr(e['speech'], 200).flatMap((s) => (typeof obj(s)['account'] === 'string' && UUID.test(obj(s)['account'] as string) ? [{ account: obj(s)['account'] as string, name: text(obj(s)['name'], 64), from: num(obj(s)['from']), to: num(obj(s)['to']) }] : []));
  const t = obj(e['times']);
  if (Object.keys(t).length > 0) out.times = { joined: num(t['joined']), reported: num(t['reported']), ...(t['clipFrom'] !== undefined ? { clipFrom: num(t['clipFrom']), clipTo: num(t['clipTo']) } : {}) };
  return out;
}

/** A short reference the reporter keeps: R-XXXX-XXXX (Crockford's base 32). */
function receipt(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const b = randomBytes(8);
  const c = [...b].map((x) => alphabet[x % 32]).join('');
  return `R-${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

/** A WAV file, as the client's clip recorder writes it (RIFF, PCM). */
export function isWav(clip: Uint8Array): boolean {
  return clip.length > 44 && Buffer.from(clip.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(clip.subarray(8, 12)).toString('latin1') === 'WAVE';
}

export interface ReportInput {
  reporter?: string;
  contact?: string;
  category: ReportCategory;
  target: { kind: TargetKind; account?: string; world?: string; ref?: string };
  text: string;
  evidence?: Evidence;
  clip?: Uint8Array;
}

/** Files a report and answers its receipt. A report that an account is under age suspends it,
 *  with a reason it can appeal, until the owner decides. */
export async function fileReport(db: Db, r: ReportInput, now: Date): Promise<{ id: string; receipt: string }> {
  if (r.clip && (r.clip.length > CLIP_MAX || !isWav(r.clip))) throw new ReportError('the clip is not a WAV file of 700 KB at most');
  const account = r.target.account && UUID.test(r.target.account) ? r.target.account : null;
  const world = r.target.world && UUID.test(r.target.world) ? r.target.world : null;
  const abuse = r.category === 'csam' || r.category === 'grooming';
  const keep = new Date(now.getTime() + (abuse ? KEEP_DAYS.abuse : KEEP_DAYS.ordinary) * 86_400_000);
  const [row] = await db.query<{ id: string; receipt: string }>(
    `insert into reports (reporter_id, reporter_contact, category, target_kind, target_account, target_world, target_ref, text, evidence, clip, priority, receipt, created_at, keep_until)
     select $1, $2, $3, $4, (select id from accounts where id = $5), (select id from worlds where id = $6), $7, $8, $9, $10, $11, $12, $13, $14 returning id, receipt`,
    [r.reporter ?? null, (r.contact ?? '').slice(0, 254), r.category, r.target.kind, account, world, (r.target.ref ?? '').slice(0, 300), r.text.slice(0, TEXT_MAX), JSON.stringify(r.evidence ?? {}), r.clip ? Buffer.from(r.clip) : null, URGENT.has(r.category) ? 0 : 1, receipt(), now, keep],
  );
  if (r.category === 'underage' && account) {
    const [a] = await db.query<{ status: string }>('select status from accounts where id = $1', [account]);
    if (a?.status === 'active') await moderateAccount(db, account, 'suspend', 'Reported as under the minimum age. The account stays suspended until the age is checked.', `report:${row!.receipt}`, now);
  }
  return row!;
}

export interface MyReport {
  receipt: string;
  category: ReportCategory;
  target: TargetKind;
  status: 'open' | 'actioned' | 'dismissed';
  decision: string;
  createdAt: Date;
  decidedAt: Date | null;
}

/** The reports an account filed: the receipt, then the decision. */
export async function myReports(db: Sql, accountId: string): Promise<MyReport[]> {
  const rows = await db.query<{ receipt: string; category: ReportCategory; target_kind: TargetKind; status: MyReport['status']; decision: string; created_at: Date; decided_at: Date | null }>(
    'select receipt, category, target_kind, status, decision, created_at, decided_at from reports where reporter_id = $1 order by created_at desc limit 50',
    [accountId],
  );
  return rows.map((r) => ({ receipt: r.receipt, category: r.category, target: r.target_kind, status: r.status, decision: r.decision, createdAt: r.created_at, decidedAt: r.decided_at }));
}

export interface QueuedReport {
  id: string;
  receipt: string;
  category: ReportCategory;
  urgent: boolean;
  target: string;
  targetAccount: string | null;
  text: string;
  evidence: Evidence;
  hasClip: boolean;
  reporter: string;
  createdAt: Date;
}

/** The open reports, urgent ones first, then oldest first. */
export async function reportQueue(db: Sql): Promise<QueuedReport[]> {
  const rows = await db.query<{ id: string; receipt: string; category: ReportCategory; priority: number; target_kind: string; target_ref: string; target_account: string | null; target_name: string | null; world_name: string | null; text: string; evidence: Evidence; has_clip: boolean; reporter: string | null; contact: string; created_at: Date }>(
    `select r.id, r.receipt, r.category, r.priority, r.target_kind, r.target_ref, r.target_account, t.display_name as target_name, w.name as world_name, r.text, r.evidence,
            r.clip is not null as has_clip, p.display_name as reporter, r.reporter_contact as contact, r.created_at
       from reports r left join accounts t on t.id = r.target_account left join worlds w on w.id = r.target_world left join accounts p on p.id = r.reporter_id
      where r.status = 'open' order by r.priority, r.created_at limit 200`,
  );
  return rows.map((r) => ({
    id: r.id,
    receipt: r.receipt,
    category: r.category,
    urgent: r.priority === 0,
    target: [r.target_kind, r.target_name ?? '', r.world_name ? `in ${r.world_name}` : '', r.target_ref].filter(Boolean).join(' '),
    targetAccount: r.target_account,
    text: r.text,
    evidence: r.evidence,
    hasClip: r.has_clip,
    reporter: r.reporter ?? (r.contact ? `public form (${r.contact})` : 'public form'),
    createdAt: r.created_at,
  }));
}

export type ReportDecision = 'actioned' | 'dismissed' | 'underage-confirmed' | 'underage-cleared';

/** The owner's decision; the reporter reads `note`. For an under-age report: confirmed deletes the
 *  account (and any world it owns), cleared lifts its suspension. */
export async function decideReport(db: Db, id: string, decision: ReportDecision, note: string, actor: string, now: Date): Promise<boolean> {
  const [r] = await db.query<{ category: ReportCategory; target_account: string | null }>("select category, target_account from reports where id = $1 and status = 'open'", [id]);
  if (!r) return false;
  if (decision === 'underage-confirmed' || decision === 'underage-cleared') {
    if (r.category !== 'underage' || !r.target_account) return false;
    if (decision === 'underage-confirmed') await deleteAccount(db, r.target_account);
    else await moderateAccount(db, r.target_account, 'lift', 'The age report was checked: the account may play.', actor, now);
  }
  const status = decision === 'dismissed' || decision === 'underage-cleared' ? 'dismissed' : 'actioned';
  await db.query("update reports set status = $2, decided_at = $3, decided_by = $4, decision = $5 where id = $1 and status = 'open'", [id, status, now, actor, note.slice(0, 1000)]);
  return true;
}

/** Deletes an account confirmed under age (S3.07): its worlds, sessions and records go with it;
 *  reports about it keep their evidence until purged. */
export async function deleteAccount(db: Db, accountId: string): Promise<void> {
  await db.tx(async (sql) => {
    await sql.query('delete from worlds where owner_id = $1', [accountId]);
    await sql.query('delete from accounts where id = $1', [accountId]);
  });
}

/** A report's voice clip, for the owner's admin page. */
export async function reportClip(db: Sql, id: string): Promise<Buffer | undefined> {
  if (!UUID.test(id)) return undefined;
  const [r] = await db.query<{ clip: Buffer | null }>('select clip from reports where id = $1', [id]);
  return r?.clip ?? undefined;
}

/** Drops the evidence of reports past their keeping time: the text, the evidence and the clip go;
 *  the category, the decision and the dates stay. A report on legal hold is left whole, whatever
 *  its date. Answers how many were purged. */
export async function purgeReports(db: Sql, now: Date): Promise<number> {
  const rows = await db.query("update reports set text = '', evidence = '{}', clip = null, target_ref = '', reporter_contact = '', purged = true where keep_until <= $1 and not purged and not hold returning id", [now]);
  return rows.length;
}
