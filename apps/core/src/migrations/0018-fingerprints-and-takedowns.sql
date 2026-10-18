-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Fingerprints and takedowns (S5.09, Q-J4, cl-005, T-03, G-10). Each converted avatar and item keeps
-- its fingerprint (the converter's shapes and texture hashes), so a re-exported copy of something
-- taken down, or of someone else's gallery entry whose licence allows no copies, is caught once it
-- converts. A rights holder asks for a takedown on the public form; the admin page reviews it, and
-- removing takes the avatar or item down everywhere: its gallery entries, every row of its manifest
-- (the original, the copies taken from the gallery, exact re-uploads), the outfits that hold it, and
-- whoever wears it. A removed row keeps its fingerprint and the reason. A caught re-upload, and each
-- removal, is a strike on the account, which the admin page lists.

alter table avatars drop constraint avatars_status_check;
alter table avatars add constraint avatars_status_check check (status in ('uploading', 'converting', 'ready', 'refused', 'failed', 'removed'));
alter table avatars add column fingerprint jsonb, add column removed_at timestamptz, add column removal text not null default '';
alter table items drop constraint items_status_check;
alter table items add constraint items_status_check check (status in ('uploading', 'converting', 'ready', 'refused', 'failed', 'removed'));
alter table items add column fingerprint jsonb, add column removed_at timestamptz, add column removal text not null default '';
create index avatars_removed on avatars (removed_at) where status = 'removed';
create index items_removed on items (removed_at) where status = 'removed';

create table takedowns (
  id uuid primary key default gen_random_uuid(),
  receipt text not null unique,
  -- Who asks, and how to answer them.
  name text not null,
  contact text not null,
  -- The work they own and where it is; what on FlatChat copies it, as they wrote it, and the
  -- gallery entry it names, when it names one.
  work text not null,
  target text not null,
  gallery_id uuid references gallery(id) on delete set null,
  -- Their word: in good faith, accurate, and theirs (or their client's) to ask; and their name as a signature.
  statement boolean not null,
  signature text not null,
  status text not null default 'open' check (status in ('open', 'removed', 'rejected')),
  note text not null default '',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null
);
create index takedowns_open on takedowns (created_at) where status = 'open';

create table strikes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  -- removed: something of theirs was taken down; copy: they uploaded a copy of something taken down.
  kind text not null check (kind in ('removed', 'copy')),
  detail text not null,
  created_at timestamptz not null
);
create index strikes_account on strikes (account_id, created_at desc);
