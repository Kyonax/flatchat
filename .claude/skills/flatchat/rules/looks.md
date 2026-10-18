---
title: World Looks — [look] in world.toml, the Sky, Fog and Light, and the Screen Effects Pipeline (Bloom, Light Shafts, Reflections, Filters)
impact: MEDIUM
impactDescription: A look read without its ranges lets a host set any colour string or a fog that hides the world; a pipeline rebuilt every frame stalls the client; light shafts without the sun's shadows draw nothing; effects drawn after the pipeline with three's own depth sit in front of everything; a bench timed without waiting for the GPU measures only how fast commands were queued.
tags: look, world look, [look], WorldLook, readLook, DEFAULT_LOOK, applyLook, LookPipeline, lookEffects, RenderPipeline, PostProcessing, pass, mrt, bloom, BloomNode, godrays, GodraysNode, ssr, SSRNode, film, FilmNode, CRT, scanlines, vignette, barrelUV, colour grading, fog, sky, sun, shadows, settings.look, safe mode, look bench, --bench-look, S6.05, Q-E6, T-14
---

Stage 6's S6.05 (Q-E6, T-14): a world's sky, fog and light, and its screen effects. The picture is `docs/world-looks.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/look.ts` | `WorldLook`, `DEFAULT_LOOK` (the plaza scene's old look), `readLook` (ranges, colours `#rrggbb`, fog `false`, screen effects only when given), `LOOK_TABLE_KEYS` (unknown-key warnings) |
| `packages/content/src/manifest.ts`, `built.ts` | `[look]` into `WorldManifest.look` (only when given, so older worlds stay byte for byte); `manifestOf` reads a built world's look again (`lookOf`: a host is not trusted) |
| `apps/client/src/renderer/src/world/look.ts` | `applyLook` (background, fog, the hemisphere and the sun of `buildWorldScene`), `lookEffects` (the world's ask AND the viewer's switches; none in safe mode), `LookPipeline` (`THREE.RenderPipeline`: scene pass [+MRT normal and metalrough], SSR, godrays, bloom, filters; `depth()` for the Effekseer layer) |
| `apps/client/src/renderer/src/world/session.ts` | `updateLook` each frame (rebuilt only when its key changes), the pipeline's `render()` in place of `renderer.render`, `effects.frame(camera, dt, pipeline.depth())`, `state.look` (`[data-test=look]`) |
| `apps/client/src/renderer/src/crowd/look-bench.ts` | `--bench=S --bench-look=1`: none, each effect, all; a warm-up of 20 frames and 1 s, then frames back to back, each waited for on the GPU (`gpuDone`), the page let breathe by a message (`breathe`) |

## The Rules

| Rule | Why |
|---|---|
| Use `THREE.RenderPipeline`, not `PostProcessing` | r183 renamed it; the old name warns on every construction |
| Rebuild the pipeline only when what is on changes (`lookKey`), and dispose the old one | Building passes and render targets every frame stalls the client |
| Light shafts turn on the renderer's shadows, the sun's `castShadow` and every world mesh's cast/receive; dispose turns them off again | three's godrays need a full shadow setup or draw nothing |
| Reflections need the scene pass's MRT (`output`, `normalView`, metalness and roughness) | SSR reads normals and per-pixel metalness and roughness |
| The Effekseer layer draws after the pipeline with the scene pass's depth (`frame(..., depth)`) | With a pipeline, three's frame-buffer depth is not the scene's |
| A look nobody can make here (the pipeline throws) falls back to the plain picture | A screen effect never takes the world away |
| Safe mode turns every screen effect off | T-14: the safe-mode key clears what the world puts on the screen too |
| Time a bench frame to the GPU's finish: WebGPU's `onSubmittedWorkDone`; on WebGL2 a fence (`fenceSync`, polled between tasks), never `gl.finish` (Chromium only flushes) or a pixel read (it resolves the canvas's samples after some frames and not others); yield by a `MessageChannel`, never a timer; frames back to back, in a window on a real GPU | Without the wait it measured command submission (thousands of fps in software, effects cheaper than none); timers in a window Chromium thinks hidden fire once a second (CI got 30 frames an effect); headless software and headless Vulkan give no real numbers (the second crashed the GPU process) |
