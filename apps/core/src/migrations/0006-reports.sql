-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Reports (S3.02, OQ-12, OQ-18) and their triage (S3.07): what was reported, by whom (or by the
-- public form, with an optional contact), its evidence and the reporter's voice clip, its priority
-- (hours for abuse material, grooming and threats; days for the rest), the receipt the reporter
-- holds, and the decision they are told. Evidence is kept for about six months, a year for abuse
-- reports (S3.12), then purged.

create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references accounts(id) on delete set null,
  reporter_contact text not null default '',
  category text not null check (category in ('csam', 'grooming', 'threats', 'intimate', 'underage', 'harassment', 'other')),
  target_kind text not null check (target_kind in ('player', 'avatar', 'world', 'item', 'other')),
  target_account uuid references accounts(id) on delete set null,
  target_world uuid references worlds(id) on delete set null,
  target_ref text not null default '',
  text text not null default '',
  evidence jsonb not null default '{}',
  clip bytea,
  priority smallint not null,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  receipt text not null unique,
  created_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  decision text not null default '',
  keep_until timestamptz not null,
  purged boolean not null default false
);
create index reports_queue on reports (status, priority, created_at);
create index reports_by_reporter on reports (reporter_id, created_at desc);
