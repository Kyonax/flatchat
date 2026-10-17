-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Personal mutes (S3.08): the accounts a player does not want to hear, in every world. The client
-- drops their voice; a block (S3.11) goes further, both ways.

create table personal_mutes (
  account_id uuid not null references accounts(id) on delete cascade,
  muted_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null,
  primary key (account_id, muted_id)
);
