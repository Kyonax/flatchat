-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The guardian link (S3.04, rr-015): a player aged 13 to 17 names a parent or guardian and agrees
-- to supervision (its own say, the right to be heard); the guardian authorizes from a mailed
-- link, after reading a plain summary, including world servers abroad; the core keeps the proof.
-- The guardian widens or narrows who may reach the teen (S3.10's `contact`).

create table guardian_links (
  teen_id uuid primary key references accounts(id) on delete cascade,
  guardian_email_key text not null,
  invite_hash bytea unique,
  invite_expires timestamptz,
  teen_agreed_at timestamptz not null,
  guardian_id uuid references accounts(id) on delete set null,
  authorized_at timestamptz,
  method text not null default '',
  summary_version text not null default '',
  abroad boolean not null default false,
  contact text not null default 'friends' check (contact in ('friends', 'everyone', 'none')),
  created_at timestamptz not null
);
create index guardian_links_guardian on guardian_links (guardian_id);

-- A teen's first step after sign-up: a one-time token for the guardian form, an hour.
create table guardian_steps (
  token_hash bytea primary key,
  teen_id uuid not null references accounts(id) on delete cascade,
  expires_at timestamptz not null
);

-- The guardian's own page, signed in apart from the client: like the admin page's sessions.
create table guardian_sessions (
  id_hash bytea primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  csrf text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
