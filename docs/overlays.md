# Screen overlays

Overlays are images shown on the screen rather than in the world (Stage 6's S6.02, Q-M13, T-14). There are three kinds, and the viewer's choice always wins:

- **On the wearer's own screen.** An overlay item is worn at one of nine screen points, the way Second Life's HUD attachments are worn: a badge in a corner, a frame along an edge.
- **On other players' screens.** An overlay worn "for others too" shows on another player's screen only when that player allowed the wearer, person by person. It shows small, see-through and away from the centre, for ten seconds after it is put on.
- **A world's own.** A world's maker lists overlays in its `world.toml`. They show for every visitor until the visitor switches worlds' overlays off.

Every viewer can clear all of them at once with the **safe-mode key** (below).

## The format

An overlay is a still PNG, at most 512 px a side (a world's, 1024 px), with a look:

| Field | Values | Default |
|---|---|---|
| `hud` | `top-left`, `top`, `top-right`, `left`, `centre`, `right`, `bottom-left`, `bottom`, `bottom-right` | an item names one; a world's is `centre` |
| `size` | its longer side as a share of the screen's height: 0.03 to 0.5 (a world's up to 1, the whole screen) | 0.15 |
| `opacity` | 0.1 to 1 (a world's up to 0.8) | 1 (a world's 0.8) |
| `motion` | `none`, `pulse`, `bob`, `spin` | `none` |
| `audience` (items only) | `self` (the wearer alone) or `everyone` (others too, with their consent) | `self` |

Nothing an overlay does can flash. The converter decodes the PNG and writes it again, so every client gets one still frame and nothing else (an animated PNG keeps its first frame; text and other chunks are dropped). Each motion takes two seconds a cycle, and a pulse fades only to half the opacity, far from the three flashes a second that photosensitivity guidance sets. The client leaves motion out when the system asks for reduced motion.

The rules live in `packages/content/src/overlay.ts`: `readOverlayLook`, `overlayImageProblems`, `overlayVisible` (who sees an overlay) and `overlayShown` (at what size and opacity).

## Overlay items

An overlay is an item in the slot `overlay`, uploaded the way any item is. A PNG keeps no declaration of its own, so the upload carries one: the overlay's name, its look, its audience and its authors (`DeclareItemForm.vue` asks for them). The converter (`tools/converter/src/overlay.ts`) checks the image, writes it again and fingerprints it by its perceptual hash, so a copy of an overlay taken down is caught as a texture is (S5.09).

- **In an outfit.** One overlay to a screen point, four at most. The core refuses an outfit that breaks this; the outfit menu keeps an outfit within it.
- **The starters.** [kits/overlays/starters.json](../kits/overlays/starters.json) lists two starter overlays any account takes with no upload: a star badge (top right, a slow pulse) and a heart (top left, a gentle bob), both shown to others who allow it. They are drawn in code by `tools/converter/scripts/make-overlays.ts`.

## A world's overlays

A world lists them in its `world.toml`, each an image in the folder:

```toml
[[overlays]]
image = "overlays/heart.png"
hud = "top"
size = 0.1
opacity = 0.8
motion = "pulse"
```

At most four. The validator checks each image (`overlay-image`, `file-missing`); the converter writes each again as a file of kind `overlay` and lists it in `world.json`. A world comes from its host, who is not trusted, so the client checks each image's header against the size limit again before it decodes it.

## Who sees what

`overlayVisible` decides, for each overlay on a viewer's screen:

| Whose | Shows when |
|---|---|
| The viewer's own | the viewer has not switched their own off (settings: "Show my screen overlays") |
| A world's | the viewer has not switched worlds' off (settings: "Show worlds' screen overlays") |
| Another player's | its wearer shows it to everyone, the viewer allowed that person ("Allow overlays" in the People list), the viewer does not hide or block that person, and it was put on less than ten seconds ago |

And none of them in safe mode. Another player's shows at most 0.2 of the screen's height and 0.7 opaque, never at the centre (moved to the top), and three at most from everyone together, the newest first.

## The safe-mode key

**Shift+Esc**, in a world, at any moment, whatever is open:

- every other player's avatar shows as its fallback (the impostor);
- every overlay goes, the viewer's own included;
- everyone else's effects stop, and the world's;
- the world's screen effects stop: bloom, light shafts, reflections and filters ([world looks](world-looks.md)).

A notice at the top of the screen says so. Shift+Esc again brings everything back as the viewer had it. When the mouse is captured, the key also frees it (the browser does that on Esc, Shift or not); it does not open the menu as Esc alone does.

## In the client

`apps/client/src/renderer/src/world/overlays.ts` follows what each player wears from the world's roster, fetches each overlay's manifest and image from the core (through the main process), and the world's from its downloaded files; `ui/ScreenOverlays.vue` places each over the world view, taking no clicks. The settings keep the viewer's choices (`overlays.mine`, `overlays.world`, and `overlays.allowed`, the accounts allowed).

## Tests

- **Consent.** `packages/content/test/overlay.test.ts`: another player's overlay only for a viewer who allowed that person, never one kept to its wearer or from a hidden person, gone after ten seconds; the viewer's own and a world's until switched off; none in safe mode; the viewer's caps.
- **The format.** The same file and `tools/converter/test/overlay.test.ts`: looks, images, declarations, outfits; an upload written again (its text chunk gone, its pixels the same), refused when too big or not a PNG, and converted in the sandbox as the core runs it.
- **End to end.** The end-to-end test takes the star badge at home, wears it in a world and sees it on screen, presses Shift+Esc (the badge goes, safe mode shows) and again (it is back), takes it off, then sees the garden's own overlay after travelling. The offline check sees the same overlay in the garden played as a folder.
