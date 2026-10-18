-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Items and outfits (Stage 5: S5.05). An item upload goes the way an avatar's does (asked for, sent
-- to a signed slot, converted in a sandboxed process with the standard bodies at hand) and ends
-- ready (its manifest's SHA-256 names it in the file store, with its slot and the bodies it fits),
-- refused (the converter's reasons) or failed. An outfit is an account's saved set of items, each
-- with a prop's adjustment; the client sends one to the world as it is worn. An avatar whose source
-- is a standard body's exact bytes is that body (`kit`), so the items made for it fit.

create table items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references accounts(id) on delete cascade,
  name text not null default '',
  status text not null check (status in ('uploading', 'converting', 'ready', 'refused', 'failed')),
  source_sha256 text not null,
  source_bytes integer not null,
  manifest_sha256 text,
  slot text,
  -- The bodies it fits, comma-separated (an attachment fits every avatar: empty).
  fits text not null default '',
  problems text not null default '',
  warnings text not null default '',
  created_at timestamptz not null,
  converted_at timestamptz,
  deleted_at timestamptz
);
create index items_owner on items (owner_id, created_at desc);
create index items_manifest on items (manifest_sha256);

create table outfits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  -- [{ "item": manifest SHA-256, "adjust"?: { x, y, z, rx, ry, rz, scale } }], as the protocol's outfit.
  items jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index outfits_owner on outfits (owner_id, updated_at desc);

alter table avatars add column kit text;
