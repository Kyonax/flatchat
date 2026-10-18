---
title: The Interface — the Kyonax HUD Tokens with FlatChat's Violet, Space Mono, the Mark and Icon, Help, Credits, the Keys Help and Translation Coverage
impact: MEDIUM
impactDescription: A rounded corner, a gradient or a second accent breaks the house style the owner chose; a colour literal outside theme.css drifts from the tokens; a credits list kept by hand disagrees with CREDITS.md; an action without a row in the keys help is a key nobody finds; a key missing from one language shows its path on screen; a font under a licence the gate does not know stops every publication.
tags: ui, interface, theme, theme.css, tokens, Kyonax, HUD, design system, accent, violet, oklch, Space Mono, font, woff2, OFL, OFL-1.1, FONT_ONLY_LICENCES, logo, mark, LogoMark, LOGO_RECTS, logo.ts, icon, icon.ts, make-icon, out/icon.png, electron-builder icon, HelpView, CreditsView, credits.ts, readCredits, CREDITS.md?raw, KeysHelp, key-groups, KEY_GROUPS, F1, help action, keysHint, translation coverage, i18n, en, es, S6.07, Q-E5, Q-E7, Q-H4, Q-J3
---

Stage 6's S6.07 (Q-E5, Q-E7): the interface's look, its mark, and the help, credits and keys pages. The picture is `docs/ui.md`; the source design system is the brain's Kyonax HUD doc (its TOKENs and THE 7 LAWs).

## The Files

| File | Job |
|---|---|
| `apps/client/src/renderer/src/ui/theme.css` | The tokens (`--bg` black, `--panel*`, the ink ramp `--bright` to `--faint`, hairlines `--line*`, `--accent` FlatChat's violet `oklch(74% 0.19 315)`, `--cyan`, `--ok`, `--danger`, `--font` Space Mono, the type sizes), the `@font-face` rules, the global laws (`border-radius: 0`, no shadows), buttons in capitals, the primary in the accent |
| `apps/client/src/renderer/src/assets/fonts/` | Space Mono Regular and Bold (woff2, OFL-1.1; record `kits/provenance/space-mono.json`, text `kits/provenance/archive/space-mono-ofl.txt`) |
| `apps/client/src/shared/logo.ts` | `LOGO_RECTS` on `LOGO_GRID` 16, `LOGO_ACCENT` (the accent in sRGB), `LOGO_BRIGHT`: the mark's only definition |
| `apps/client/src/renderer/src/ui/LogoMark.vue` | The mark as an SVG of those squares in `var(--accent)` and `var(--bright)`; `wordmark` adds `app.name` |
| `apps/client/scripts/icon.ts`, `make-icon.ts` | `iconPixels`, `iconPng` (PNG by Node's zlib); `npm run build` writes `out/icon.png` (512), used by the window (`main/index.ts` `icon`) and `electron-builder.yml`'s `linux.icon` |
| `ui/HelpView.vue`, `ui/CreditsView.vue`, `ui/KeysHelp.vue`, `ui/key-groups.ts`, `ui/credits.ts` | The help page (sections from `help.sections.*`, then the keys), the credits page (rows from `CREDITS.md`), the keys help (in four groups, the safe-mode key) |
| `shared/settings.ts` | The `help` action (default F1, rebindable) |

## The Rules

| Rule | Why |
|---|---|
| Colours only as tokens from `theme.css`; at most one accent on an element | The owner chose the Kyonax system: hierarchy by brightness, colour for state |
| No `border-radius` but 0, no `gradient(`, no `box-shadow` but none, in any renderer style (`test/ui.test.ts` scans them) | The HUD's laws; a component's old rounded corner is the first thing that drifts back |
| The accent in CSS and `LOGO_ACCENT` are the same colour (the test converts the oklch) | The icon and the interface must match |
| The mark has no letters; the name is a codename (README) | A new name changes the wordmark only |
| The credits page reads `CREDITS.md` at build time (`?raw`), assets and the packages that ship in the client; sources shown as text, never opened | One list for the file, the notices and the page; the client opens no address a page hands it (trap T16) |
| Every action is in `KEY_GROUPS` exactly once (tested); the help key toggles the keys help in a world and Esc closes it; the menu's Keys opens it | A key nobody can find is a key nobody uses |
| Every `t('…')`/`te('…')` key in the renderer exists in both languages, and every run-time key's fixed start is a section (tested) | A missing key shows its path on screen |
| A font may be OFL-1.1, nothing else may (`FONT_ONLY_LICENCES` in the licence gate, tested) | The Kyonax font is Space Mono, under the OFL; the gate accepts it for fonts only |
| The e2e opens the help (`home-help`), the credits and, in a world, the keys help (F1), and counts what they show (`helpPage`, `creditsPage`, `keysHelp`) | The pages must render in the packaged client, with the real CREDITS.md |
