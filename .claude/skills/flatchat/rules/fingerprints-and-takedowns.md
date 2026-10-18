---
title: Fingerprints and Takedowns — MinHash Shapes, Perceptual Texture Hashes, Copies Caught at Upload, the Takedown Form, Removal Everywhere
impact: HIGH
impactDescription: An exact file hash misses every re-exported copy; a fingerprint measured after simplification or re-encoding stops matching what clients download; a texture hash taken on a synthetic checkerboard is noise; without setting aside what the standard bodies explain, every kit avatar is a "copy" of every other (the kits' skins are 4 bits apart); a removal that misses the taken copies, the worn avatar, the outfits or the delivery leaves it in the world; a missing status in the client's list cleaner makes removed rows vanish without a word.
tags: fingerprints, takedowns, S5.09, Q-J4, cl-005, T-03, G-10, OQ-11, Fingerprint, checkFingerprint, shapeSimilarity, textureDistance, matchOf, SHAPE_SLOTS, SHAPE_MIN_TOKENS, SHAPE_MATCH, TEXTURE_MATCH_BITS, TEXTURE_MAX, fingerprintOf, shapeOf, imageHash, MinHash, perceptual hash, pHash, kit-fingerprints.ts, kits/bodies/fingerprints.json, copies.ts, copyOf, beyondKits, readFingerprint, readKitFingerprints, strike, struckAccounts, strikes, takedowns.ts, fileTakedown, takedownStatus, takedownQueue, decideTakedown, removeContent, takedownProblem, /takedown, /takedown/status, /admin/takedowns, /admin/remove, migration 0018, status removed, removal, takedownByAddress, result.json fingerprint
---

An exact file hash (S5.06's copy check at the slot) misses a re-exported copy. So every upload is fingerprinted, and the core compares fingerprints after each conversion (S5.09, Q-J4, cl-005, T-03). A rights holder's takedown (G-10), reviewed on the admin page, removes the avatar or item everywhere. Guides: `docs/avatars.md` and `docs/items.md` (Copies and takedowns), `apps/core/README.md` (Fingerprints and Takedowns).

## The Fingerprint

| Part | How | Why |
|---|---|---|
| A shape | One per part: an avatar is one part; an item has one per fit, or one for its prop. Triangles in their drawn space (a skinned mesh's bind space, else the world). Each triangle is a token: its three edge lengths sorted, and its centre's distance from the area-weighted model centre, all divided by √(total area) and put in 1/1024 bins. A MinHash of the distinct tokens over 64 seeded MurmurHash3 finalisers | Invariant to vertex and triangle order, welding, placement, turns, mirrors and scale. Measured on the upload's GLB before LODs or quantization, so the converter's own LOD0 (what clients download) re-uploaded matches at 1.0 |
| Too simple | Fewer than `SHAPE_MIN_TOKENS` (96) distinct tokens gives no shape | A cube is any cube |
| A texture | 32 × 32 grey (cell means), a DCT, 8 × 8 low frequencies, each bit set when a coefficient is over the median of the 63 AC ones; 16 hex digits; flat images (variance under 4) left out; at most 8, largest first | A painted texture keeps 0 to 2 bits through JPEG at quality 70, and 0 through halving. A 64 px checkerboard does not: its energy is in the frequencies the hash leaves out, so never test robustness on one |
| A match | `matchOf`: any part pair at `SHAPE_MATCH` (0.75) or more of agreeing slots, else any texture pair within `TEXTURE_MATCH_BITS` (6) | Measured: copies 1.000; other models 0.0; the kits against each other at most 0.125 |

The converter writes it into `result.json` (`{ ok, id, manifest, fingerprint }`), never into the manifest: it is the server's.

## The Files

| File | Job |
|---|---|
| `packages/content/src/fingerprint.ts` | The type, the constants, `checkFingerprint`, `shapeSimilarity`, `textureDistance`, `matchOf` |
| `tools/converter/src/fingerprint.ts` | `shapeOf(nodes)`, `imageHash(rgba)`, `fingerprintOf(doc, parts)`; `convertAvatar` and `convertItem` return `fingerprint` |
| `tools/converter/scripts/kit-fingerprints.ts` → `kits/bodies/fingerprints.json` | The standard bodies' fingerprints, which the core sets aside; `test/fingerprint.test.ts` checks the file against the kits |
| `apps/core/src/migrations/0018-fingerprints-and-takedowns.sql` | `fingerprint`, `removed_at`, `removal` and status `removed` on avatars and items; `takedowns`; `strikes` |
| `apps/core/src/copies.ts` | `beyondKits` (drop shapes and textures a kit explains), `copyOf(db, f, owner, kits)` (removed rows first, then others' live entries with `allowRedistribution` false), `strike`, `struckAccounts` |
| `apps/core/src/takedowns.ts` | `fileTakedown` (a `T-XXXX-XXXX` receipt; a UUID in the target links the gallery entry), `takedownStatus`, `takedownQueue`, `decideTakedown` (remove or reject, note, optional manifest and ban), `removeContent` |
| `apps/core/src/avatars.ts`, `items.ts` | After `checkManifest`, before any file reaches the store: `readFingerprint(result.fingerprint)`, then `copyOf` (never for a kit's own conversion), refusal and a `copy` strike; the ready row keeps the fingerprint; lists show a removed row's `removal` as its problems |
| `apps/core/src/pages.ts`, `strings.ts`, `admin-web.ts`, `app.ts` | `/takedown`, `/takedown/status` (en/es, `takedownByAddress`); the admin page's Takedown requests, Remove an avatar or item and Repeat uploads; `POST /admin/takedowns/:id`, `POST /admin/remove`; the privacy notice says fingerprints and takedown requests are kept |
| `apps/client/src/main/core-api.ts`, `renderer/src/env.d.ts`, i18n | `removed` in `STATUSES` and the status unions; `avatars.status.removed` |
| `apps/world-server/src/net/relay.ts`, `server.ts`, `main.ts` | `removed` from the core → `onRemoved` → `takeDown(manifests)`: worn avatars and outfit items matching come off, everyone is told |

## The Rules

| Rule | Why |
|---|---|
| Fingerprint the upload as read, before simplification, texture fitting or KTX2 | What clients download (LOD0) and a re-export of it must measure the same as the original |
| Set aside what a kit explains before any comparison | The kits share their skin textures (4 bits apart) and anyone may make a kit avatar: without `beyondKits` every kit-based upload would be a copy of every removed one |
| A copy of something removed is a strike; a copy of a closed gallery entry is not | Q-J4's bans are for re-uploaded stolen items; a closed licence is the publisher's choice, refused with its reason |
| Remove by manifest, everywhere, in one transaction | The entry, the original, taken copies and exact re-uploads share the manifest; the worn avatar and outfit entries go too, so delivery refuses everywhere |
| Then tell every connected world: `{ type: 'removed', manifests }` on the host channel | The roster keeps the manifest a connect token vouched for until the player rejoins; `WorldServer.takeDown` (through `CoreRelay`'s `onRemoved`) takes the avatar and outfit entries off and announces it as a change |
| Never remove a standard body (`kit is not null`) | Everyone's base body would vanish |
| Removed rows keep their fingerprint | That is what catches the next re-export |
| The claimant reads the decision by reference; the uploader reads `removal` | No mail needed for either; both see why |
| Add any new status to the client's `STATUSES` | The list cleaner drops rows it does not know, silently |

## Tests

- `tools/converter/test/fingerprint.test.ts` covers:
  - copies through FBX, DAE, the converter's own LOD0, and a move, turn, mirror and scale (≥ 0.95);
  - the robot and the kits apart (< 0.25);
  - the tee's three parts, and one fit alone matching;
  - the cube with no shape;
  - determinism;
  - a painted texture through JPEG and two halvings;
  - a flat image with no hash;
  - `fingerprints.json` matching the kits.
- `apps/core/test/takedowns.test.ts`, run in order, covers:
  - the public form (a missing statement, the receipt, the status page, Spanish);
  - the admin queue showing the entry;
  - a rejection leaving everything as it was;
  - removal everywhere: the entry, the original with its reason, the copy, the worn avatar, `avatar-files` returning 404, the status page, the publisher's strike;
  - a content-rule removal by manifest (the outfit loses the tee, `item-files` returns 404, the uploader is banned, a manifest matching nothing);
  - a re-exported DAE of what was taken down refused with a `copy` strike shown on the admin page;
  - a DAE copy of another's closed entry refused with no strike, then taken once the licence allows copies;
  - a kit avatar taken down catching no other kit avatar.
- `apps/core/test/hosting.test.ts` checks that a removal reaches a connected world as `removed`. `apps/world-server/test/avatars.test.ts` checks that `takeDown` takes off the avatar and one of two items, and that the others see it. `hosting.test.ts` there checks that the relay passes only well-formed manifests.
