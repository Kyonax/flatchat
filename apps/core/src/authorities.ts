// SPDX-License-Identifier: AGPL-3.0-or-later
// A log of authorities' requests and the legal hold that keeps a report out of the purge (S7.02).
// The log records who asked, when, under what authority, what was asked and what was disclosed.
// A hold is the preservation: purgeReports leaves a held report's evidence where it is.
import type { Sql } from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthorityRequest {
  authority: string;
  who: string;
  asked: string;
  disclosed?: string;
  /** Reports whose evidence this request preserves. */
  reportIds?: string[];
  holdUntil?: Date;
}

/** Writes one request and, when it names reports, holds them so the purge skips their evidence. */
export async function logAuthorityRequest(db: Sql, req: AuthorityRequest, now: Date): Promise<string> {
  const ids = (req.reportIds ?? []).filter((id) => UUID.test(id));
  const [row] = await db.query<{ id: string }>(
    `insert into authority_requests (asked_at, authority, who, asked, disclosed, report_ids, hold_until)
     values ($1, $2, $3, $4, $5, $6::uuid[], $7) returning id`,
    [now, req.authority.slice(0, 200), req.who.slice(0, 200), req.asked.slice(0, 2000), (req.disclosed ?? '').slice(0, 2000), ids, req.holdUntil ?? null],
  );
  if (ids.length > 0) await db.query('update reports set hold = true where id = any($1::uuid[])', [ids]);
  return row!.id;
}
