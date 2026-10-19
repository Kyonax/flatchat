-- SPDX-License-Identifier: AGPL-3.0-or-later
-- S7.02 gaps that need no decision: an emote or dance can be taken down and keeps a fingerprint
-- (the converted VRMA's SHA-256, stable for the same motion through this converter), a report on
-- legal hold is not purged, and every authority's request is logged.

alter table animations drop constraint animations_status_check;
alter table animations add constraint animations_status_check check (status in ('uploading', 'converting', 'ready', 'refused', 'failed', 'removed'));
alter table animations add column fingerprint text, add column removed_at timestamptz, add column removal text not null default '';
create index animations_fingerprint on animations (fingerprint) where status = 'removed';

alter table reports add column hold boolean not null default false;

create table authority_requests (
  id uuid primary key default gen_random_uuid(),
  asked_at timestamptz not null,
  authority text not null,
  who text not null,
  asked text not null,
  disclosed text not null default '',
  report_ids uuid[] not null default '{}',
  hold_until timestamptz
);
create index authority_requests_asked on authority_requests (asked_at desc);
