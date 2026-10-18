-- SPDX-License-Identifier: AGPL-3.0-or-later
-- An emote's or a dance's sound (S5.07): asked for with the animation (its size and SHA-256), sent
-- to a slot of its own, and converted with it once both have arrived; Rhubarb Lip Sync then makes
-- its mouth track. Each part's arrival is kept.

alter table animations add column audio_sha256 text;
alter table animations add column audio_bytes integer;
alter table animations add column source_received boolean not null default false;
alter table animations add column audio_received boolean not null default false;
