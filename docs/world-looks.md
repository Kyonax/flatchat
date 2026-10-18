# World looks

A world sets its own look (Stage 6's S6.05, Q-E6): its sky, its fog, its sun and ambient light, and screen effects drawn over the picture. The screen effects are bloom and neon glow, light shafts from the sun, reflections on glossy surfaces, and screen filters (colour grading, a CRT's curve and scanlines, film grain, a vignette). Every visitor can switch each screen effect off (T-14: on until switched off), the safe-mode key clears them all, and a world without a look keeps the one every world had before.

## In world.toml

```toml
[look]
sky = "#2b2d42"                                       # the background
fog = { colour = "#2b2d42", near = 25, far = 90 }     # fog = false for none
sun = { colour = "#ffb38a", intensity = 1.4, direction = [-0.7, 0.35, -0.3] }
ambient = { sky = "#dfe8f5", ground = "#3a3f33", intensity = 1.6 }
bloom = { strength = 0.9, threshold = 0.75, radius = 0.4 }
shafts = { strength = 0.6 }
reflections = { strength = 0.5 }
filters = { crt = 0.5, grain = 0.2, vignette = 0.35, saturation = 1.1, contrast = 1.05, exposure = 1.0, tint = "#eef4ff" }
```

| Key | What it does | Values (default) |
|---|---|---|
| `sky` | The colour behind everything | `#rrggbb` (`#9fb8d0`) |
| `fog` | Fog from `near` to `far` metres in `colour` (the sky's when left out); `false` for none | 0 to 10,000 m (`near` 40; `far` 0.9 of the world's size) |
| `sun` | The directional light: `colour`, `intensity`, the `direction` it shines from | intensity 0 to 10 (`#fff1dc`, 1.8, [0.4, 1, 0.3]) |
| `ambient` | The sky and ground light | intensity 0 to 10 (`#dfe8f5`, `#3a3f33`, 1.6) |
| `bloom` | Bright surfaces glow: neon signs, emissive materials | `strength` 0 to 3 (0.8), `threshold` 0 to 1 (0.8), `radius` 0 to 1 (0.4) |
| `shafts` | Light shafts from the sun through gaps; they turn on the sun's shadows | `strength` 0 to 2 (0.6) |
| `reflections` | Screen-space reflections on glossy and metal surfaces | `strength` 0 to 2 (0.5) |
| `filters` | `crt` (curve, scanlines, colour bleed), `grain`, `vignette`, each 0 to 1; `saturation`, `contrast`, `exposure`, each 0 to 2; `tint` | (0, 0, 0, 1, 1, 1, `#ffffff`) |

A screen effect runs only when the world gives its table. Unknown keys are warnings, as everywhere in `world.toml`; a value out of range refuses the world. The built world keeps the look in `world.json`, and every client reads it again (a host is not trusted). The rules are `packages/content/src/look.ts` (`readLook`, `DEFAULT_LOOK`).

## In the client

`apps/client/src/renderer/src/world/look.ts` sets the sky, fog and lights when a world loads (`applyLook`), then builds one three.js render pipeline (`LookPipeline`) from the screen effects the world asks for and the viewer allows:

1. the scene pass (with normals and metalness when reflections are on);
2. reflections (three's SSR node), blended by their strength;
3. light shafts (three's godrays node; the sun casts shadows and everything in the world casts and receives them while shafts are on);
4. bloom (three's bloom node), added;
5. filters: exposure, saturation and contrast, the tint, a CRT's colour bleed, curve and scanlines, a vignette, film grain.

With no screen effect there is no pipeline and the scene draws as before. The pipeline is made again only when what is on changes (a setting, safe mode, a new world). Effekseer's effects draw after it, over the picture, with the scene pass's depth. The settings have a switch for each screen effect (bloom, light shafts, reflections, filters); safe mode turns all four off.

## Measuring them

`flatchat --bench=SECONDS --bench-look=1 [--bench-size=WxH] [--bench-out=FILE]` draws a scene made for them (a glossy floor, boxes casting shadows, neon bars, fog) with no screen effect, with each alone, then with all of them, frame after frame after a warm-up, each waited for on the GPU (WebGPU's queue; on WebGL2 a fence, since Chromium's `finish()` does not wait), and reports each one's frame times and its cost against none. Run it in a window on a real GPU: the reference laptop's numbers are the ones the plan asks for (S6.05's Verify). CI runs it for a second each on its software renderer, where the times mean nothing, to prove every effect builds and draws.

## Tests

- `packages/content/test/look.test.ts`: defaults, a full `[look]`, ranges, unknown keys, a host's look read again.
- The end-to-end test's garden has a dusk look with bloom and filters (`make-travel.ts --look`), and the test checks both are drawn there.
