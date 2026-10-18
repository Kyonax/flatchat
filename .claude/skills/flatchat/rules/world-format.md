---
title: The World Format — world.toml, glTF Scenes With OMI and FlatChat Markers, Limits and the Validator
impact: HIGH
impactDescription: A world is strangers' content that hosts serve and every visitor downloads. A path that leaves the folder, a URL to fetch, a marker read without bounds, or a scene too heavy for the weak-laptop floor reaches every player who joins.
tags: world format, world.toml, worlds, scenes, glTF, GLB, OMI_spawn_point, OMI_seat, OMI_physics_shape, OMI_physics_body, KHR_audio_emitter, FLATCHAT_world, portal, zone, quiet zone, private zone, voice zone, reverb zone, spawn point, seat, collider, trigger, validator, validateWorld, parseManifest, inspectScene, readGltf, imageSize, packages/content, smol-toml, limits, triangles, texture size, S2.01
---

The world format (version 1, `docs/world-format.md`) is how worlds are made: FlatChat has no in-game editor. A world is a folder: `world.toml` plus glTF 2.0 scenes whose nodes carry markers. `packages/content` (Apache-2.0, Web APIs only) reads and checks it; the converter (S2.03) prepares what the world server serves.

## The Pieces

| Piece | Rule |
|---|---|
| `world.toml` | `format = 1`, a name (3 to 48 characters of plain text), capacity (recommended at most maximum, 1 to 1000), persistence (`reset` or `persistent`), `movement.flying`, avatar height range, `voice.range`, and `[[scenes]]` (ids of lowercase letters, digits and dashes; files are `.glb`/`.gltf` relative paths inside the folder). Unknown keys are warnings and are never used. A key written after `[[scenes]]` belongs to that scene, as TOML says |
| Markers | `OMI_spawn_point` (at least one in the first scene, the world's own; any scene may add spawn points with a `group`, which a portal names; faces the node's -z), `OMI_seat`, `OMI_physics_shape` with `OMI_physics_body` (collider or trigger), `KHR_audio_emitter`, and FlatChat's `FLATCHAT_world`: `part` (one of the base library's parts by id, S2.05: `packages/content/src/parts.ts` `BASE_PARTS`, each a set of boxes in the library's colours with their solids and seats; an unknown id is `marker-invalid`), `portal` (a box leading to a world by id and a spawn group there; the world server checks a player's position, their feet, so the box must reach below the floor) `zone` (`voice` with range and gain, `quiet`, `private`; `reverb` with `room` and `mix`, S6.06, the client's alone: rule `audio`) and `effect` (S6.01: `{ uri, scale? }`, an `.efkefc`/`.efk` relative path inside the folder, scale 0.01 to 100, default 1; `EffectPlacement` with the path made relative to the folder; the validator reads it with `readEffectFile`, never plays it: `effect-invalid`, `effect-too-new`, `effect-materials`, `effect-file-missing` (a warning for a sound) and `effect-texture` (not PNG)) |
| Transforms | Markers sit at their node's world transform (`localMatrix` from `matrix` or TRS, multiplied down from the scene's roots; a node with two parents is refused) |
| Paths | Buffers and images are inside the GLB or relative paths inside the folder: `safePath` refuses absolute paths, `..`, backslashes and any scheme (`http:`, `file:`); `data:` URIs over 1 MB are refused |
| Extensions | An unknown extension in `extensionsRequired` refuses the world; in `extensionsUsed` it is a warning (ignored) |
| Look | `[look]` in world.toml (S6.05): `sky`, `fog` (or `false`), `sun`, `ambient`, and the screen effects `bloom`, `shafts`, `reflections`, `filters` (on only when given), read by `readLook` with its ranges, unknown keys warned; kept in the built manifest only when given and read again by `parseBuiltWorld` (rule `looks`) |
| Overlays | `[[overlays]]` in world.toml (S6.02): at most four, `image` a PNG in the folder (1024 px a side), `hud`, `size` up to 1 (the whole screen), `opacity` up to 0.8, `motion`; the validator's `overlay-image`; the converter writes each image again as a file of kind `overlay` into `BuiltWorld.overlays` (only when there are some) and leaves the paths out of `world.json`'s manifest (rule `overlays`) |
| Limits | 512 MB a folder, 256 MB a file, 2 million triangles (a warning above 1 million), textures at most 4096 px a side (a warning above 2048; sizes read from PNG, JPEG and WebP headers, nothing decoded), 65,536 nodes, 1,000 spawn points and seats, 256 portals, zones and emitters, 64 effects (each per scene) |

## Using It

```ts
import { validateWorld } from '@flatchat/content';
const report = validateWorld(new Map([['world.toml', bytes], ['scenes/main.glb', glb]]));
if (!report.ok) for (const p of report.problems) console.log(p.severity, p.code, p.file, p.at, p.message);
```

`report.scenes[i]` holds the markers (`spawns`, `seats`, `shapes`, `bodies`, `emitters`, `portals`, `zones`), `triangles` and the files it `needs`. Tests build GLBs byte by byte (`packages/content/test/world.test.ts` has the `glb()` helper).

## The Converter (`tools/converter`, S2.03)

| Step | Rule |
|---|---|
| Input | `readFolder(dir)` (relative paths with forward slashes; symbolic links refused; the size limits), then `validateWorld`: any error refuses the world (`ConvertError` carries the report) |
| Markers | Read by `packages/content` before glTF-Transform touches the scene, because glTF-Transform drops extensions it does not know: the built GLB carries visuals only, and `world.json` carries the markers in world space |
| Visuals | `dedup`, `prune`, `weld`, `meshopt` (EXT_meshopt_compression: the client needs three.js's `MeshoptDecoder`) |
| Levels of detail | `addLevelsOfDetail` after `weld`: a mesh of 2,000 triangles or more (`LOD_MIN_TRIANGLES`; triangles only, no morph targets) gets two copies simplified by meshoptimizer's simplifier (`LODS`: 35 % of the triangles within 1 % of its radius, then 10 % within 5 %); each node that draws it hands the mesh to a child marked `extras.flatchatLod: 0` beside children 1 and 2 (siblings, because meshopt's quantization moves a mesh off a node that has children); skinned or morphed nodes are left alone. The client gathers them into a `THREE.LOD` (`levelsOfDetail` in `scene-loader.ts`) at 8 and 20 times the mesh's radius, never nearer than 12 m and 30 m |
| Textures | PNG and JPEG decoded in plain JavaScript (pngjs, jpeg-js), halved until 2048 px a side and the whole world fits 128 MB of compressed GPU memory, then KTX2 through ktx2-encoder (Basis Universal as WebAssembly; ETC1S for colour, UASTC for normal maps; the decoded pixels go in through its `imageDecoder` option). Other formats stay as they are, with a warning |
| Solids | `collision.bin` (`packages/content/src/collision.ts`): boxes, spheres, capsules, cylinders and triangle meshes in world space, from `OMI_physics_body`; a world that marks none gets every mesh as a static triangle mesh, with a warning |
| Navigation mesh | Recast through recast-navigation-js at 20 cm cells (15 cm runs its WebAssembly memory out on a 128 m world), the player's height, radius and step from `packages/sim` |
| Output | `world.json` (`packages/content/src/built.ts`; `parseBuiltWorld` checks every field of one read from elsewhere) and `content/<sha256>`; deterministic, pinned by `test/golden/plaza.world.json` |
| Base parts | `partColliders`: each solid box of each placed part as a box collider, turned and scaled by its node; part seats join the scene's seats; `world.json`'s scenes list `parts` (id, position, rotation, scale; `parseBuiltWorld` accepts none in an older world and refuses an unknown id). The client draws them (`world/parts.ts`), so a parts-only world downloads its plan alone. `writeGlb` leaves meshes, buffers and the BIN chunk out of a scene of markers only |
| Test worlds | `scripts/make-park.ts` writes `kits/worlds/park` (69 parts, no geometry); `scripts/make-plaza.ts` writes `kits/worlds/plaza`; `scripts/make-travel.ts OUT --worlds ID_A,ID_B [--kits plaza,park]` writes two worlds whose extra `travel` scene holds a portal to the other and an `arrival` spawn group (on the plaza an arch mesh 6 m south of the spawn and the fountain's sound; on the park the base library's arch, so it stays geometry-free; `--effect` adds Effekseer's ForceFieldTornado sample at scale 0.25 (about a person's height), 6 m ahead of the arrival point and 3 m to its right (where the camera behind a new arrival sees it), with its texture under `scenes/effects/`), and builds them (the hop test uses two plazas, the end-to-end the plaza and the park) |
| Effects | Each scene's effect markers: `folderEffect(files, path)` gathers the effect with the files it names, `convertEffect(..., { where: 'world', scale, runner })` dry-runs it in a `DryRunner` worker (or in this thread with `effectsInThread`: the core's sandbox and the tests), one run per path and scale; `put(bundle, 'effect')`; the scene lists `BuiltEffect { file, matrix, scale, peak }` (`parseBuiltWorld`: at most 64, none in an older world). A refusal is `ConvertError` code `effect-refused` at the marker's node; then every marker's peak is added and a world over `EFFECT_LIMITS.world` is `effects-over-budget`. The runner is closed in a `finally`, however the scenes end. The client measures each effect again (rules/effects.md) |
| Typing | The converter's tsconfig uses Bundler resolution: recast-navigation's declaration files use extensionless imports that NodeNext cannot follow |

## Correct vs. Incorrect

**Incorrect:** joining a scene's URI to the folder as given.
```ts
const data = await readFile(join(worldDir, image.uri));
```
**Correct:** only paths `safePath` accepts, decoded, inside the folder.
```ts
const path = decodeURIComponent(image.uri);
if (!safePath(path)) throw new Error('outside the world folder');
```
**Why:** `../../.ssh/id_ed25519` or `/etc/passwd` in a stranger's world would otherwise be read and served to every visitor.
