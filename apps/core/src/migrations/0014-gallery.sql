-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The free gallery (Stage 5: S5.06, ad-008, Q-M29, Q-J4). A publisher puts one of their ready avatars
-- or items in it under licence fields (VRM 1.0's terms, every field stated); anyone takes it, which
-- gives them their own ready copy (an avatars or items row naming the entry), worn like their own.
-- A withdrawn entry leaves the gallery; copies already taken stay. A removed one (a takedown,
-- S5.09) goes everywhere.

create table gallery (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('avatar', 'item')),
  publisher_id uuid not null references accounts(id) on delete cascade,
  avatar_id uuid references avatars(id) on delete cascade,
  item_id uuid references items(id) on delete cascade,
  manifest_sha256 text not null,
  source_sha256 text not null,
  name text not null,
  authors jsonb not null,
  licence jsonb not null,
  slot text,
  fits text not null default '',
  rank text,
  takes integer not null default 0,
  published_at timestamptz not null,
  withdrawn_at timestamptz,
  removed_at timestamptz,
  check ((kind = 'avatar') = (avatar_id is not null) and (kind = 'item') = (item_id is not null))
);
create unique index gallery_live_manifest on gallery (manifest_sha256) where withdrawn_at is null and removed_at is null;
create index gallery_live on gallery (kind, published_at desc) where withdrawn_at is null and removed_at is null;
create index gallery_source on gallery (source_sha256);

-- A taken copy names the entry it came from.
alter table avatars add column gallery_id uuid references gallery(id) on delete set null;
alter table items add column gallery_id uuid references gallery(id) on delete set null;
