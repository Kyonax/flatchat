---
title: Screen Overlays — the Format, the Consent Rule, the Viewer's Caps, Overlay Items, World Overlays and the Safe-Mode Key
impact: HIGH
impactDescription: An overlay shown without the viewer's consent puts a stranger's image on someone's screen; one that animates freely can flash; a world's image decoded before its header is checked lets a host exhaust a client's memory; a safe-mode key that misses a layer leaves something on screen the viewer asked to clear.
tags: overlays, screen overlay, HUD, HUD points, hud, OVERLAY_LIMITS, overlayVisible, overlayShown, readOverlayLook, overlayImageProblems, OverlayFit, BuiltOverlay, slot overlay, consent, allowed, audience, safe mode, Shift+Esc, impostor, ScreenOverlays.vue, OverlayLayer, world.toml overlays, kits/overlays, make-overlays.ts, S6.02, Q-M13, T-14, G-20
---

Stage 6's S6.02 (Q-M13, T-14, G-20): images on the screen, not in the world. The picture is `docs/overlays.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/overlay.ts` | `HUD_POINTS`, `OVERLAY_MOTIONS`, `OVERLAY_AUDIENCES`, `OVERLAY_LIMITS`; `readOverlayLook` (an item's or a world's), `overlayImageProblems(bytes, side)`, `checkOverlayFit`; `overlayVisible` (the consent rule) and `overlayShown` (the viewer's caps), both pure |
| `packages/content/src/image-size.ts` | `imageSize` from a header, nothing decoded (re-exported by `validate.ts`; its own file so `overlay.ts` and `validate.ts` do not import each other) |
| `packages/content/src/item.ts` | The slot `overlay` (not a point slot, not a model slot), its declaration fields (`hud`, `size`, `opacity`, `motion`, `audience`), `ItemManifest.overlay`, `wornKey` = `overlay at <hud>`, at most `OVERLAY_LIMITS.worn` in an outfit |
| `packages/content/src/manifest.ts`, `validate.ts`, `built.ts` | `[[overlays]]` in world.toml (`WorldOverlayEntry`), the validator's `overlay-image`, `BuiltWorld.overlays` (written only when a world has some) |
| `tools/converter/src/overlay.ts` | `overlayImage(upload, side)` (decode, check, write again: one still frame, no other chunks), `convertOverlayItem` (fingerprint = the image's perceptual hash); `item-cli.ts` routes `uploadFormat(...) === 'image'` here |
| `tools/converter/src/world.ts` | World overlays written again as files of kind `overlay`; the manifest's image paths left out of `world.json` |
| `apps/core/src/items.ts` | `readOverlayStarters` (kits/overlays/starters.json, each with its declaration, stored in the item row so the conversion gets `--declare`), `links['overlay']`, outfits keyed by screen point |
| `apps/client/src/renderer/src/world/overlays.ts`, `ui/ScreenOverlays.vue` | `OverlayLayer` (outfits from the roster, manifests and images through `itemFile(..., 'overlay')`, the world's from its files, blob URLs) and the view (each at its point, CSS motions, none under reduced motion, no clicks) |
| `apps/client/src/renderer/src/world/session.ts`, `avatar-policy.ts`, `ui/WorldView.vue` | Safe mode: `toggleSafeMode`, `Viewer.safe` (everyone else an impostor), effects off but the viewer's own; Shift+Esc in `onKey` before every other key; "Allow overlays" per person |
| `kits/overlays/`, `tools/converter/scripts/make-overlays.ts` | The two starter overlays (a star badge, a heart), drawn in code, the same bytes each time |

## The Rules

| Rule | Why |
|---|---|
| Decide every overlay with `overlayVisible`, never ad hoc | T-14: the viewer's choice always wins; one function is what the consent tests test |
| Another player's overlay needs `audience: 'everyone'` and the viewer's consent for that account (`settings.overlays.allowed`), friends included | T-14 asks consent per person (ad-010's "friends show everything" is about avatars); OQ-32 records the default |
| Show another player's for `OVERLAY_LIMITS.others.showS` after the viewer first sees it worn, at most 0.2 of the screen's height and 0.7 opaque, never at the centre, three from everyone together | An overlay on someone else's screen is an imposition: small, brief, out of the way |
| Overlays are still PNGs, written again by the converter; motions are CSS with a two-second cycle and a pulse to half the opacity | Nothing may flash (photosensitivity: three flashes a second is the line); an animated PNG or a strobe would |
| The client checks a world overlay's PNG header (`overlayImageProblems(bytes, OVERLAY_LIMITS.world.side)`) before making a blob URL | A world comes from its host: a 20,000 px PNG would be decoded into gigabytes |
| Safe mode clears all overlays (the viewer's own too), everyone else's effects and the world's, and shows every other avatar as its impostor; the key works whatever is open | T-14 and Stage 6's acceptance: the safe-mode key returns everything to fallbacks at once |
| Shift+Esc is fixed, not a rebindable action | A panic key must not be lost to a rebinding |
| The policy pass runs without an avatar layer too (`tunePolicy` no longer returns early) | Offline worlds and the overlays' ten-second expiry depend on it |
| Starter overlays keep their declaration in the item row (`StarterFile.declaration`) | A PNG cannot carry one; the conversion passes the row's declaration as `--declare` |
| `uploadFormat` says `image` by the PNG signature's bytes, never by decoded text | `TextDecoder('latin1')` is windows-1252: byte 0x89 decodes to '‰' |
| `BuiltWorld.overlays` only when a world has some | Every existing world's `world.json` (and the plaza's golden file) stays byte for byte the same |
