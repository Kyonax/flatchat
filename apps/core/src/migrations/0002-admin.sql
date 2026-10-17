-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Stage 2: the owner's admin page (S2.10). An account may administer the core; the admin page signs
-- in on its own, with a session cookie and a CSRF token per session, kept as digests.
alter table accounts add column admin boolean not null default false;

create table admin_sessions (
  id_hash bytea primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  csrf text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
