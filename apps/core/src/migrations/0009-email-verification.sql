-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Email verification (S3.03): a one-time link mailed after sign-up, kept as its digest for a day.

create table email_verifications (
  token_hash bytea primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  email_key text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index email_verifications_account on email_verifications (account_id, created_at desc);
