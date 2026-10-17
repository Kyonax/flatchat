-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Moderation (S3.07, G-11): the platform's decisions on accounts with their statements of reasons,
-- appeals against them and against worlds' bans, the bans a world must lift once its owner reverses
-- one on appeal, the one-time tokens a banned account appeals with, and the host agreement.

create table moderation_actions (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  action text not null check (action in ('suspend', 'ban', 'lift')),
  reason text not null,
  actor text not null,
  at timestamptz not null
);
create index moderation_actions_account on moderation_actions (account_id, at desc);

create table appeals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  -- null: an appeal against the platform's decision; else against that world's ban
  world_id uuid references worlds(id) on delete cascade,
  action_id bigint references moderation_actions(id) on delete set null,
  -- the reason the player was given, as the world gave it (world appeals)
  reason text not null default '',
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'upheld', 'reversed')),
  created_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  note text not null default ''
);
create index appeals_pending on appeals (status, created_at);
create unique index appeals_one_pending on appeals (account_id, coalesce(world_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'pending';

create table world_unbans (
  appeal_id uuid primary key references appeals(id) on delete cascade,
  world_id uuid not null references worlds(id) on delete cascade,
  account_id uuid not null,
  created_at timestamptz not null,
  delivered_at timestamptz
);

create table appeal_tokens (
  token_hash bytea primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  expires_at timestamptz not null
);

alter table worlds add column agreement_version integer;
alter table worlds add column agreement_at timestamptz;
