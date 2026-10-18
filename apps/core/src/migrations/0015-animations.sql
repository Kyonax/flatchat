-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Emotes and dances (Stage 5: S5.07). An animation upload goes the way an avatar's does (asked for,
-- sent to a signed slot, converted in a sandboxed process, an FBX read by headless Blender first)
-- and ends ready (its manifest's SHA-256 names one VRMA in the file store), refused (the reasons)
-- or failed. Its use says how the world plays it: an emote once, a dance on a loop.

create table animations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references accounts(id) on delete cascade,
  name text not null default '',
  use text not null check (use in ('emote', 'dance')),
  status text not null check (status in ('uploading', 'converting', 'ready', 'refused', 'failed')),
  source_sha256 text not null,
  source_bytes integer not null,
  -- What the upload was: vrma, gltf, bvh or fbx (known once converted).
  source_format text,
  manifest_sha256 text,
  duration real,
  loop boolean,
  problems text not null default '',
  warnings text not null default '',
  created_at timestamptz not null,
  converted_at timestamptz,
  deleted_at timestamptz
);
create index animations_owner on animations (owner_id, created_at desc);
create index animations_manifest on animations (manifest_sha256);
