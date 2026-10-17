-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Friends and blocks (S3.10, S3.11): friendship asked and accepted, and the two-way block that
-- follows an account into every world. Worlds learn a minor's friends and the blocked pairs from
-- the connect token, never these tables.

create table friends (
  a uuid not null references accounts(id) on delete cascade,
  b uuid not null references accounts(id) on delete cascade,
  since timestamptz not null,
  primary key (a, b),
  check (a < b)
);
create index friends_b on friends (b);

create table friend_requests (
  from_id uuid not null references accounts(id) on delete cascade,
  to_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null,
  primary key (from_id, to_id)
);
create index friend_requests_to on friend_requests (to_id);

create table blocks (
  account_id uuid not null references accounts(id) on delete cascade,
  blocked_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null,
  primary key (account_id, blocked_id)
);
create index blocks_blocked on blocks (blocked_id);
