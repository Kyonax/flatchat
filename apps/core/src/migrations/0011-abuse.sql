-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The abuse path (S3.12, OQ-17): remove, preserve, report. A case opens from a report of child
-- sexual abuse material or of intimate images shared without consent: the target comes down at
-- once, the evidence is sealed and kept a year, and the reports to the authorities are drafted for
-- the owner to file by hand (nothing is ever sent from here). Intimate images carry the 48-hour
-- clock of the TAKE IT DOWN Act. A drill runs it all with a harmless stand-in and is marked so.

create table abuse_cases (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete set null,
  kind text not null check (kind in ('csam', 'intimate')),
  drill boolean not null default false,
  -- what came down: a world (its approval) and/or an account (banned); no foreign keys, so the
  -- case outlives an account or a world deleted later
  target_world text not null default '',
  target_account text not null default '',
  uk_linked boolean not null default false,
  opened_at timestamptz not null,
  removed_at timestamptz,
  removal text not null default '',
  -- the sealed evidence (AES-256-GCM under a key derived from the core's secret) and its hash
  preserved bytea,
  preserved_sha256 text not null default '',
  preserve_until timestamptz not null,
  -- the 48-hour clock (intimate images): when it ends, and whether the removal came in time
  due_at timestamptz,
  clock text not null default '',
  opened_by text not null
);
create index abuse_cases_open on abuse_cases (opened_at desc);

create table abuse_forms (
  case_id uuid not null references abuse_cases(id) on delete cascade,
  destination text not null check (destination in ('te-protejo', 'cai-virtual', 'ncmec', 'nca')),
  draft text not null,
  sent_at timestamptz,
  reference text not null default '',
  primary key (case_id, destination)
);
