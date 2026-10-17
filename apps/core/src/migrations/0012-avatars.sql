-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Avatars (Stage 4: S4.01 uploads, S4.04 the store). An upload is asked for (its size and SHA-256),
-- sent to a signed slot, converted in a sandboxed process, and then ready (its manifest's SHA-256
-- names the converted avatar in the file store), refused (with the converter's reasons) or failed.
-- An account wears one of its ready avatars; deleting one keeps its row (reports may name it).

create table avatars (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references accounts(id) on delete cascade,
  name text not null default '',
  status text not null check (status in ('uploading', 'converting', 'ready', 'refused', 'failed')),
  source_sha256 text not null,
  source_bytes integer not null,
  manifest_sha256 text,
  rank text,
  problems text not null default '',
  created_at timestamptz not null,
  converted_at timestamptz,
  deleted_at timestamptz
);
create index avatars_owner on avatars (owner_id, created_at desc);
create index avatars_manifest on avatars (manifest_sha256);

alter table accounts add column avatar_id uuid references avatars(id) on delete set null;
