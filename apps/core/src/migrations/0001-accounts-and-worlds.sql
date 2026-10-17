-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Stage 1's core: accounts by invitation (S1.02), the age rule's record and the data-processing
-- authorization (S1.03), sign-in through the system browser and sessions (S1.04), worlds with their
-- approval record and key (S1.05). Secrets are stored as SHA-256 digests, never as given.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_key text not null unique,            -- the address trimmed and lower-cased, for lookups
  password_hash text not null,               -- Argon2id, PHC string
  display_name text not null,
  birth_year smallint not null,
  birth_month smallint not null check (birth_month between 1 and 12),
  country char(2) not null,                  -- ISO 3166-1 alpha-2
  email_verified boolean not null default false,
  trust smallint not null default 0 check (trust between 0 and 7),
  tester boolean not null default false,
  status text not null default 'active' check (status in ('active', 'suspended', 'banned')),
  created_at timestamptz not null default now()
);

-- One row per invitation the owner makes. The code itself is only shown once, in the admin
-- command line; a refusal by the age rule spends it (no second try with the same invitation).
create table invitations (
  code_hash bytea primary key,
  note text not null default '',
  email_key text,                            -- when set, only this address may use it
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references accounts(id) on delete set null,
  refused_at timestamptz                     -- the age rule refused it; nothing about the person is kept
);

-- The proof of the data-processing authorization (Decreto 1377 de 2013, arts. 7 and 8): which
-- notice, when, and how it was given.
create table consents (
  id bigint generated always as identity primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  kind text not null,
  notice_version text not null,
  method text not null,
  given_at timestamptz not null default now()
);

-- A client's sign-in through the system browser (DR-22, RFC 8252 and RFC 7636): the client keeps
-- the verifier, the core keeps the challenge, and the code goes only to the client's loopback port.
create table login_requests (
  id_hash bytea primary key,
  challenge text not null,
  port integer not null check (port between 1024 and 65535),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  account_id uuid references accounts(id) on delete cascade,
  code_hash bytea unique,
  code_expires_at timestamptz,
  used_at timestamptz
);

-- An account session: a short-lived access token and a refresh token that rotates on every use.
-- A refresh token used twice means one was copied, and the session ends.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  access_hash bytea not null unique,
  access_expires_at timestamptz not null,
  refresh_hash bytea not null unique,
  refresh_expires_at timestamptz not null,
  previous_refresh_hash bytea,
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create index sessions_previous_refresh on sessions (previous_refresh_hash) where previous_refresh_hash is not null;

-- Worlds: registered by an account, approved by the owner (S1.05, S2.10). The world key the core
-- shares with an approved world is sealed under the core's secret, bound to the world's id.
create table worlds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references accounts(id),
  address text not null,
  capacity integer not null default 50 check (capacity between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  key_sealed bytea,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  revoked_at timestamptz
);

-- The approval record: every change of a world's status, by whom and why.
create table world_events (
  id bigint generated always as identity primary key,
  world_id uuid not null references worlds(id) on delete cascade,
  kind text not null,
  actor text not null,
  note text not null default '',
  at timestamptz not null default now()
);
