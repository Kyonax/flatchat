---
title: The World Format — world.toml, glTF Scenes With OMI and FlatChat Markers, Limits and the Validator
impact: HIGH
impactDescription: A world is strangers' content that hosts serve and every visitor downloads. A path that leaves the folder, a URL to fetch, a marker read without bounds, or a scene too heavy for the weak-laptop floor reaches every player who joins.
tags: world format, world.toml, worlds, scenes, glTF, GLB, OMI_spawn_point, OMI_seat, OMI_physics_shape, OMI_physics_body, KHR_audio_emitter, FLATCHAT_world, portal, zone, quiet zone, private zone, voice zone, spawn point, seat, collider, trigger, validator, validateWorld, parseManifest, inspectScene, readGltf, imageSize, packages/content, smol-toml, limits, triangles, texture size, S2.01
---

The world format (version 1, `docs/world-format.md`) is how worlds are made: FlatChat has no in-game editor. A world is a folder: `world.toml` plus glTF 2.0 scenes whose nodes carry markers. `packages/content` (Apache-2.0, Web APIs only) reads and checks it; the converter (S2.03) prepares what the world server serves.

## The Pieces

| Piece | Rule |
|---|---|
| `world.toml` | `format = 1`, a name (3 to 48 characters of plain text), capacity (recommended at most maximum, 1 to 1000), persistence (`reset` or `persistent`), `movement.flying`, avatar height range, `voice.range`, and `[[scenes]]` (ids of lowercase letters, digits and dashes; files are `.glb`/`.gltf` relative paths inside the folder). Unknown keys are warnings and are never used. A key written after `[[scenes]]` belongs to that scene, as TOML says |
| Markers | `OMI_spawn_point` (at least one in the first scene; faces the node's -z), `OMI_seat`, `OMI_physics_shape` with `OMI_physics_body` (collider or trigger), `KHR_audio_emitter`, and FlatChat's `FLATCHAT_world`: `portal` (a box leading to a world by id) and `zone` (`voice` with range and gain, `quiet`, `private`) |
| Transforms | Markers sit at their node's world transform (`localMatrix` from `matrix` or TRS, multiplied down from the scene's roots; a node with two parents is refused) |
| Paths | Buffers and images are inside the GLB or relative paths inside the folder: `safePath` refuses absolute paths, `..`, backslashes and any scheme (`http:`, `file:`); `data:` URIs over 1 MB are refused |
| Extensions | An unknown extension in `extensionsRequired` refuses the world; in `extensionsUsed` it is a warning (ignored) |
| Limits | 512 MB a folder, 256 MB a file, 2 million triangles (a warning above 1 million), textures at most 4096 px a side (a warning above 2048; sizes read from PNG, JPEG and WebP headers, nothing decoded), 65,536 nodes, 1,000 spawn points and seats, 256 portals, zones and emitters |

## Using It

```ts
import { validateWorld } from '@flatchat/content';
const report = validateWorld(new Map([['world.toml', bytes], ['scenes/main.glb', glb]]));
if (!report.ok) for (const p of report.problems) console.log(p.severity, p.code, p.file, p.at, p.message);
```

`report.scenes[i]` holds the markers (`spawns`, `seats`, `shapes`, `bodies`, `emitters`, `portals`, `zones`), `triangles` and the files it `needs`. Tests build GLBs byte by byte (`packages/content/test/world.test.ts` has the `glb()` helper).

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
