---
title: Building Plans — Semantic SVG Plans Built Into Worlds, the Trim Sheet, Baked Light and the Preview Skills
impact: MEDIUM
impactDescription: A face wound against its normal vanishes from the side that should see it; a slab's outside taken for its inside shades it black; a backdrop past the client's 40 m fog turns grey; a preview's floor taken in document order drops every wall; a committed scene that no longer matches its plan ships a stale world.
tags: building plans, svg plans, plan.svg, data-flatchat-plan, build-plan, plan-preview, readPlan, buildPlan, planSolids, parseSvg, PlanError, earClip, trim sheet, BANDS, baked light, vertex colours, COLOR_0, AMBIENT, CELL, mitered walls, openings, sill, lintel, stairs, strip, neon, space, star field, docking bay, kits/worlds/docking-bay, glb-writer, ImageSpec, P.01, dp-007, T-16, anatomy skill, iso-figures, S-SVG, docs/svg-plans.md, docs/spikes/s-svg.md
---

Track P's P.01 (dp-007): a building is a semantic SVG plan, a layer per floor, its shapes named by class and `data-` attributes, built by `tools/converter/src/plan/` into a world folder the validator and the host tool's converter take as they are. The format is `docs/svg-plans.md`; the spike report, with the numbers and the preview comparison, is `docs/spikes/s-svg.md`.

## The Files

| File | Job |
|---|---|
| `src/plan/svg.ts` | `parseSvg` (a small XML reader: comments, declarations, CDATA skipped, entities decoded), `transformOf`, `shapeOf` (rect, line, polyline, polygon, circle as a marker, path with M L H V Z; a curve throws `PlanError` with where it is) |
| `src/plan/plan.ts` | `readPlan`: floors (`<g class="floor">`), the classes slab, wall, opening, stairs, strip, prop, light, spawn; the page's x is x, down the page +z; heights in metres; a floor's `data-` attributes are its shapes' defaults; every problem at once |
| `src/plan/build.ts` | `buildPlan(plan, id)` → `{ glb, worldToml, triangles, materials, solids, parts }`; `planSolids` for previews; `earClip` |
| `src/plan/materials.ts` | The trim sheet (`BANDS`: hull, panel, kick, trim), the deck plate, the landing pad and the star field, drawn from a seeded generator |
| `src/glb-writer.ts` | Writes the scene: textures (`ImageSpec`), UVs, `COLOR_0`, emissive; unchanged output for meshes that use none |
| `scripts/make-hangout.ts` | The owner's hangout (S7.03): the docking bay built again from its plan as the scene `bay`, a lounge of base parts as `lounge` (benches, tables, lamps, a stage, planters), a hall reverb zone and a seeded hum, a station's `[look]`; writes `kits/worlds/hangout/` and converts it to check; the offline check plays it (`kit:hangout`) |
| `scripts/build-plan.ts`, `scripts/plan-preview.ts` | Build a plan into its folder; draw an isometric cut-away with the anatomy skill or iso-figures (`--kit DIR`, never vendored) |
| `test/plan.test.ts` | The reader, the problems, openings into sills and lintels, box or trimesh slabs, the light and its shadows, and the docking bay: the same bytes as committed, validated and converted with no warning |

## The Rules

| Rule | Why |
|---|---|
| Wind every face to its normal: `quad` and `polygon` flip their triangles when the corners' cross product opposes the normal they were given | Hand-ordered corners came out back to front on half the faces, and the client culls back faces |
| A ring's outside is `(dz, -dx)` of each edge when its signed area (x, z) is positive | The first slab edges faced inward |
| Map the trim sheet by cutting faces into strips, one band each, the strip's foot on the band's bottom row | A band cannot repeat up a wall on its own; the strips repeat it |
| Bake light with shadows against the same boxes and slab planes the solids are, from a point 2 cm off the face | A vertex on a solid's own face shadows itself otherwise |
| Cut only lit faces into cells (`CELL`); unlit ones (space, neon) stay whole | The star box tripled the triangles when its slabs were cut |
| Keep a `space` backdrop within 40 m of where players stand | The client gives every world its sky, sun and fog (from 40 m, light blue-grey): stars farther away turned grey. A world's own look is S6.05 |
| After changing the plan or the builder, run `build-plan.ts` again: the test compares the committed scene with a fresh build, byte for byte | A stale scene would ship a world that is not its plan |
| In a preview, find a solid's floor among the floors sorted by elevation; paint slabs by their top, before what stands on them | Document order found the space layer (−12 m) first and dropped every wall; a slab painted with its neighbours hid the stairs |
| The plan is the source; anatomy and iso-figures draw previews of it, never plans (T-16) | Neither writes floors, heights or openings |
| A heredoc with `<<EOF` expands `$VAR` once; a later edit that inserts `'$S/…'` writes literally | A screenshot script wrote into a folder named `$S` in the repository; check `git status` for stray paths after scratch runs |
