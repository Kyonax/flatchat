# The interface

FlatChat's interface (Stage 6's S6.07; Q-E5: clean and minimal with a light futuristic touch; Q-E7: the Kyonax design system with the platform's own accent and logo) starts from the Kyonax HUD: a black screen, translucent black panels, hairline borders, one monospace typeface, labels in capitals with wide tracking, and colour only for state. Where Kyonax has its yellow, FlatChat has a violet.

## The laws

1. No rounded corners, anywhere.
2. The screen is pure black; panels are translucent black, never grey cards, never shadowed.
3. Borders are hairlines, from three white-alpha tokens.
4. One typeface: Space Mono. Labels in capitals with wide tracking; values in their natural case.
5. Colour is for state, and rare: the accent for what is active or the one thing to do, cyan for links and sources, green for ok, red for a warning; at most one accent on an element.
6. No gradients.

`apps/client/test/ui.test.ts` holds every style in the renderer to the first, second and sixth.

## The tokens

`apps/client/src/renderer/src/ui/theme.css`:

| Token | Value | For |
|---|---|---|
| `--bg` | `#000000` | the screen |
| `--panel`, `--panel-solid`, `--panel-2` | `rgba(0,0,0,.72)`, `#050505`, `#0c0c0e` | panels over the world, opaque cards, fields |
| `--bright`, `--text`, `--muted`, `--dim`, `--faint` | `#fff`, `#c2c2c2`, `#8a8a8a`, `#4a4a4a`, `#242424` | the ink ramp: hierarchy by brightness, not hue |
| `--line`, `--line-strong`, `--line-faint`, `--track` | white at .12, .28, .06, .09 | borders, emphasis, row dividers, empty bars |
| `--accent` | `oklch(74% 0.19 315)` (`#d780fc`) | FlatChat's violet: focus, active, the primary button; 8.4:1 on black |
| `--cyan`, `--ok`, `--danger` | the Kyonax signal hues | links and sources, ok, warnings |
| `--font` | Space Mono, then JetBrains Mono and the system's monospace | everything |

## The mark

A square speech bubble with a stepped tail and three square dots, on a 16-unit grid (`apps/client/src/shared/logo.ts`): the bubble in the accent, the dots white. The same squares draw the mark in the interface (`ui/LogoMark.vue`, with the wordmark beside it in capitals at the widest tracking) and the program's icon (`scripts/icon.ts`; `npm run build` writes `out/icon.png`, 512 pixels, for the window and the Linux package). FlatChat is a codename: the mark has no letters, so a new name only changes the wordmark.

## Help, credits and the keys

- **Help** (`ui/HelpView.vue`), from the sign-in screen, the home screen and the settings: what FlatChat is, getting in, moving, talking, people and safety (the safe-mode key), the avatar and outfits, the settings, what to do when something goes wrong; then every key.
- **Credits** (`ui/CreditsView.vue`), from the help page and the settings: who made FlatChat, every model, sound, effect, font and data set with its creator and licence, and the software inside the client, read from the repository's `CREDITS.md` when the client is built (`ui/credits.ts`), so the file, the notices and the page never disagree. Sources are shown as text: the client opens no address a page hands it.
- **The keys** (`ui/KeysHelp.vue`): every action with the keys bound to it, as this player's keyboard prints them, in four groups (`ui/key-groups.ts`), and the safe-mode key. In a world the help key (F1 unless rebound) opens it over the view and closes it, Esc closes it, and the menu has a Keys button; the hint at the centre says which key opens it.

## Languages

English and Spanish (`i18n/en.ts`, `i18n/es.ts`). `apps/client/test/app.test.ts` holds both to the same keys, every one non-empty; `ui.test.ts` checks that every key the interface asks for (`t('…')` and `te('…')` in every `.vue` and `.ts` of the renderer, and the fixed start of every key built at run time) is in both.

## The font's licence

Space Mono is Colophon Foundry's, for Google Design, under the SIL Open Font License 1.1. The licence gate (`tools/harness/src/asset-check.ts`) accepts the OFL for fonts and nothing else; the font's record is `kits/provenance/space-mono.json` and the licence text travels in `kits/provenance/archive/space-mono-ofl.txt`.
