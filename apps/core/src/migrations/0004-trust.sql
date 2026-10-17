-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Stage 3: trust levels (S3.09). An account's activity: the days on which it joined a world.
alter table accounts add column active_days integer not null default 0;
alter table accounts add column last_active_day date;
