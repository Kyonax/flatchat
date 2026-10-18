-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The starter wardrobe (Track P's P.08): items any account takes with no upload, as it takes a
-- standard body. A taken one is an item like any other, marked with the wardrobe's id for it: its
-- file is the wardrobe's own (kits/items/wardrobe.json), converted once per start of the core and
-- reused, never taken for a copy, and never published to the gallery (it is everyone's already).
alter table items add column starter text;
create index items_starter on items (starter, source_sha256) where starter is not null;
