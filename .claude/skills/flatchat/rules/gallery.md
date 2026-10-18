---
title: The Free Gallery — Licence Fields, Publishing, Taking, Withdrawing and Copies
impact: HIGH
impactDescription: A gallery that takes a licence with a field missing, or one looser than the avatar's own file, publishes what its maker never allowed; a taken copy that is not an ordinary row cannot be worn or saved in an outfit; a cursor on the time alone skips entries published together; SQL spliced at run time trips T18.
tags: gallery, free gallery, S5.06, ad-008, Q-M29, Q-J4, licence, licence fields, VRM meta, avatarPermission, commercialUsage, creditNotation, allowRedistribution, modification, allowExcessivelyViolentUsage, allowExcessivelySexualUsage, allowPoliticalOrReligiousUsage, allowAntisocialOrHateUsage, licenseUrl, otherLicenseUrl, readLicence, LicenceError, licenceOfFile, looserThan, galleryProblems, STRICT_LICENCE, USAGE_FLAGS, publish, take, withdraw, copyRefused, browse, PUBLISH_TRUST, GALLERY_PAGE, gallery_id, published, fromGallery, migration 0014, GalleryPanel, PublishForm, LicenceSummary, publish-trust
---

The free gallery (S5.06, ad-008) holds avatars and items anyone may wear, each under licence fields; new players start from the standard bodies and the gallery (Q-M29); ripping is accepted and mitigated (Q-J4): licence fields now, fingerprints and takedowns in S5.09. Effects join it when Stage 6 makes them. Creators' guide: `docs/items.md`, The free gallery.

## The Files

| File | Job |
|---|---|
| `packages/content/src/licence.ts` | `Licence` (VRM 1.0's terms: `avatarPermission`, `commercialUsage`, `creditNotation`, `allowRedistribution`, `modification`, the four `USAGE_FLAGS`, `licenseUrl`, `otherLicenseUrl`), `readLicence` (every field required, every reason at once, `LicenceError`), `licenceOfFile` (an avatar manifest's `licence`: VRM 1.0's fields as they are, VRM 0.x's `allowedUserName`, `*UssageName` and `licenseName` read as the converter reads them), `looserThan` (the fields where a publisher allows more than the file), `galleryProblems` (only `everyone` may wear), `STRICT_LICENCE` (the form's starting point) |
| `apps/core/src/gallery.ts` | `publish` (trust ≥ `PUBLISH_TRUST` 2 or tester, the publisher's `affirm`, `readLicence`, `galleryProblems`, the account's own ready row that is not a taken copy, `looserThan` the avatar's file, authors from the file or the item's declaration, else the publisher's name; one live entry per manifest), `entry`, `browse` (fixed SQL with nullable parameters: kind, slot, body, words; newest first by `(published_at, id)`, `GALLERY_PAGE` 40, `next` = `time|id`), `take` (in a transaction: the same copy again, the publisher's original for the publisher, the account's limits, a new `avatars`/`items` row copying the original's files with `gallery_id`, `takes` + 1), `withdraw`, `copyRefused` (an exact source SHA-256 of someone else's live entry without `allowRedistribution`) |
| `apps/core/src/migrations/0014-gallery.sql` | `gallery` (kind, publisher, the original avatar or item, manifest and source SHA-256, name, authors, licence, slot, fits, rank, takes, published, withdrawn, removed), one live entry per manifest, `avatars.gallery_id` and `items.gallery_id` on taken copies |
| `apps/core/src/app.ts` | `GET /api/v1/gallery`, `GET /api/v1/gallery/:id`, `POST /api/v1/gallery`, `POST /api/v1/gallery/:id/take`, `DELETE /api/v1/gallery/:id`; both upload slots ask `copyRefused` first (403 `licence`); `remove` of an avatar or item withdraws its entry; the lists carry `published` and `fromGallery` |
| `apps/client/src/renderer/src/ui/GalleryPanel.vue`, `PublishForm.vue`, `LicenceSummary.vue` | The home screen's gallery (Avatars / Items, words, Take, the licence on demand, an avatar's thumbnail through `avatarFile(…, 'thumbnail')` as a blob URL, More), the publish form beside an own ready avatar or item (fields from `STRICT_LICENCE`, the affirmation, a plain JSON copy across IPC), the licence in words; `flatchat:gallery`, `:gallery:publish` (`readLicence` again in the main process), `:gallery:take`, `:gallery:withdraw`; `cleanGallery` drops an entry whose licence does not read |
| `apps/core/test/gallery.test.ts`, `packages/content/test/licence.test.ts` | Publishing's rules, browsing's filters and order, taking (worn, in an outfit, once, the publisher's original), withdrawing and deleting (copies stay, files still delivered), copies refused or let through by the licence |

## The Rules

| Rule | Why |
|---|---|
| Every licence field is required; nothing defaults on the core's side | A field left to a default is a permission nobody gave |
| An avatar's published licence is never looser than its file's (`looserThan`) | The file's terms are its maker's; the publisher may be someone else sharing it |
| The gallery takes only `avatarPermission: everyone` | Taking means wearing; a gallery entry nobody may wear is a broken promise |
| A taken copy is an ordinary ready row with `gallery_id` (the same manifest and source) | Wearing, outfits (own ready items), delivery and limits then work unchanged; withdrawing leaves it, a takedown (S5.09) must reach it through `gallery_id` and the manifest |
| A copy of an entry cannot be published again (`gallery_id is null`) | Only the original's publisher speaks for its licence |
| Order and page by `(published_at, id)` | Entries published in the same instant (a test clock, a batch) would tie and a time-only cursor would skip some |
| Build each query's text fixed (one per kind, nullable filters) | T18: SQL text spliced at run time; only ALL_CAPS constants may go in a template |
| Publishing needs trust level 2 (`PUBLISH_TRUST`) | A public gallery is moderated after the fact (S5.09); an agent default, the owner's to change (with G-04's thresholds) |

## Not Yet

Thumbnails for items (the item converter makes none: the list shows the slot), effects (Stage 6), changed copies (S5.09's fingerprints) and takedowns that remove an entry everywhere (S5.09, `removed_at`).
