-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Stage 2: the world browser (S2.09). A world is on the public list or reached by its id only (its
-- host decides), and each account keeps its favourite worlds.
alter table worlds add column listed boolean not null default true;

create table favourites (
  account_id uuid not null references accounts(id) on delete cascade,
  world_id uuid not null references worlds(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, world_id)
);
create index favourites_world on favourites (world_id);
