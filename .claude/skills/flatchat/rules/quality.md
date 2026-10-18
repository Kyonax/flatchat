---
title: Quality Settings — Presets per Tier, the Frame-Rate Tuner's Steps, the Pixel Ratio, the Stats Panel and the Forced-Quality Test Runs
impact: MEDIUM
impactDescription: A tuner that steps every window flickers; one that turns screen effects off makes every check of a look depend on the machine's speed; a preset that does not cap the viewer's switches lets the low tier pay for reflections; a resolution change that rebuilds the renderer stalls; draw counts read after the look's passes reset count only the last pass; a test run on a measured tier passes or fails by the runner.
tags: quality, graphics, preset, low, medium, high, auto, custom, PRESETS, presetOf, qualityOf, QualityTuner, TUNER_STEPS, allowedLook, pixelRatioFor, renderScale, pixelRatio, antialias, frame-rate tuner, autoTune, tier, TIER_POLICY, stats panel, StatsPanel, statsNow, renderer.info, drawCalls, triangles, F3, --quality, asRun, settings.graphics, QUALITY_PRESETS, S6.08, Q-M4, Q-D7, Q-B1
---

Stage 6's S6.08 (Q-M4, Q-D7, Q-B1): what to render and at what quality. The picture is `docs/quality.md`.

## The Files

| File | Job |
|---|---|
| `apps/client/src/renderer/src/world/quality.ts` | `PRESETS` (low: 0.75 scale, ratio 1, no MSAA, bloom and filters only, no reverb; medium: ratio 1.5, no reflections; high: everything), `presetOf` (auto and custom follow the measured tier), `qualityOf` (custom: the player's values, every screen effect allowed), `QualityTuner` (`TUNER_STEPS`: avatars 1/.75/.5/.5/.25, scale 1/1/.85/.7/.6, then reflections and shafts off, then bloom), `allowedLook`, `pixelRatioFor` |
| `apps/client/src/shared/settings.ts` | `graphics` (`preset`, `renderScale` .5–1, `pixelRatio` 1–2, `antialias`, `stats`), `QUALITY_PRESETS`, the `stats` action (F3) |
| `apps/client/src/renderer/src/world/session.ts` | `quality` (getter), MSAA at the renderer's making, the pixel ratio checked each frame (`setPixelRatio` only on a change), the look through `allowedLook`, the echo through `quality.reverb`, the avatars at the preset's tier and the tuner's share, `renderer.info.autoReset = false` with a reset at each frame's start, `statsNow()` twice a second while the panel is on |
| `apps/client/src/renderer/src/ui/StatsPanel.vue` | The panel (`data-test=stats`, `data-draws`, `data-preset`); `WorldView` toggles `settings.graphics.stats` on the stats key |
| `apps/client/src/main/index.ts`, `flags.ts` | `--quality=low|medium|high`: `asRun` sets the preset and turns the tuner off for that run, never saved |

## The Rules

| Rule | Why |
|---|---|
| The tuner decides on the p90 of two-second windows (20 frames at least), steps down past 33 ms, up only after three windows under 20 ms, and waits four seconds after any step | One slow window must not flicker the picture; recovery must be sure |
| Its order: avatars first, then resolution, then reflections and shafts, then bloom | The cheapest to lose first; a world's look goes last |
| The viewer's switches decide within the preset's and the tuner's caps (`allowedLook`); the echo needs both `sound.reverb` and `quality.reverb` | The preset limits, it never turns on what the viewer turned off |
| The resolution through the pixel ratio (`pixelRatioFor`, never under 0.5), applied only when it changes | `setPixelRatio` resizes the canvas; doing it every frame stalls |
| MSAA comes with the renderer: a new preset's smoothed edges apply from the next world | WebGPURenderer cannot change it in place |
| Draw counts: `info.autoReset = false` and `info.reset()` at the frame's start | With the look's pipeline a frame is many render calls; auto-reset keeps only the last |
| Test runs force a preset (`--quality`), which also turns the tuner off: CI's first e2e at high, the TURN one at low (S6.08's Verify), where the room's echo is off by the preset | On a measured tier and with the tuner, a check of bloom or the echo passes or fails by the runner's speed |
| A new action needs a name in both languages and a row in `KEY_GROUPS` (the UI tests fail otherwise) | The keys help lists every action |
