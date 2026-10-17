# The FlatChat world format, version 1

A world is a folder: one `world.toml` that says what the world is, and one or more glTF 2.0 scenes made in any tool (Blender first), whose nodes carry markers for what the platform needs to know: where players appear, where they sit, what is solid, what plays sound, where the portals and zones are. FlatChat has no in-game editor (Q-B10): this file format is how worlds are made. The reference validator is [`packages/content`](../packages/content) (TypeScript, Apache-2.0); the host tool's converter (step S2.03) turns a world folder into what a world server serves.

```
my-world/
  world.toml
  scenes/main.glb        # or main.gltf with its .bin and textures beside it
  sounds/fountain.ogg
```

## world.toml

```toml
format = 1                       # this specification's version
name = "Kyonax Plaza"            # 3 to 48 characters
description = "Where it starts." # optional, at most 280 characters

[capacity]
recommended = 40                 # the world list stops showing the world past this (Q-L19)
maximum = 60                     # the world server refuses joins past this

[persistence]
mode = "reset"                   # "reset": every start is fresh; "persistent": the world keeps its state (Q-L7)

[movement]
flying = false                   # whether players may fly here (Q-F3)

[avatars]
min_height = 0.5                 # metres: each player picks a height; the world fits it into this range (Q-M30)
max_height = 3.0

[voice]
range = 25                       # metres at which a voice has faded to nothing (Q-L17)

[[scenes]]
id = "main"
file = "scenes/main.glb"
```

| Key | Rule |
|---|---|
| `format` | Must be `1`. A newer number is refused by this version's tools, by name |
| `name`, `description` | Plain text: no control or direction characters |
| `capacity` | Whole numbers, 1 to 1000; `recommended` at most `maximum` |
| `persistence.mode` | `reset` or `persistent` |
| `avatars` | 0.1 to 20 m, `min_height` below `max_height` |
| `voice.range` | 1 to 100 m |
| `scenes` | At least one; ids are lowercase letters, digits and dashes, unique; files are relative paths inside the folder (no `..`, no absolute paths), ending in `.glb` or `.gltf`. The first scene is where players arrive |

Unknown keys are reported as warnings (a newer tool may know them), never silently used.

## Scenes and their markers

Scenes are glTF 2.0 (`.glb` binary, or `.gltf` JSON with its files beside it). Every buffer and image is either inside the GLB or a relative path inside the world folder: never `http:`, `https:`, `file:` or a `data:` URI over 1 MB. Distances are metres; y is up; a node's markers sit at its world transform (its own and its parents').

Markers use the open extensions of the [OMI group](https://github.com/omigroup/gltf-extensions) where one exists, and FlatChat's own for the rest:

| Marker | Extension (on a node unless said) | Meaning |
|---|---|---|
| Spawn point | `OMI_spawn_point`: `{ title?, team?, group? }` | Where players appear, facing the node's -z. At least one per world (in its first scene): players who join from the browser appear at the first scene's. Any scene may add more with a `group`, the group a portal in another world names; a portal's arrivals appear there |
| Seat | `OMI_seat`: `{ back: [x,y,z], foot: [x,y,z], knee: [x,y,z], angle }` | Where an avatar sits (Q-F1); points in the node's space |
| Solid | `OMI_physics_shape` (on the document: `shapes`) and `OMI_physics_body` (on a node: `{ motion?, collider?: { shape }, trigger?: { shape } }`) | What players collide with (Q-F2): box, sphere, capsule, cylinder, convex or trimesh shapes; a `trigger` detects without blocking |
| Base part | `FLATCHAT_world`: `{ part: { id } }` | One of the base library's parts (below), placed, turned and scaled by the node: drawn by every client from its own library, so it adds nothing to download; its solid boxes and its seats join the scene's |
| Sound | `KHR_audio_emitter` (document: `audio`, `sources`, `emitters`; node: `{ emitter }`) | Ambience, music, positional sounds (Q-H1). The sound file sits beside the scene (`uri`), in a format the client's browser engine decodes (MP3, Ogg, WAV, FLAC). Emitters with `autoPlay` start when a player arrives, positional ones from their node's place with the emitter's `refDistance` and `maxDistance`; the others wait for plugins (Stage 3). At most 64 play at once |
| Portal | `FLATCHAT_world`: `{ portal: { world, spawn?, size: [x,y,z] } }` | Walking into the box (`size` in metres, centred on the node) takes a player to another world (Q-L11): `world` is its id, `spawn` an optional spawn group there. The world server checks the player's feet, so let the box reach a little below the floor |
| Zone | `FLATCHAT_world`: `{ zone: { kind, size: [x,y,z], range?, gain? } }` | A box where voice changes: `kind` is `voice` (`range` and `gain` for everyone inside, a stage), `quiet` (no voice heard or sent: Q-L18), or `private` (voice only among those inside); reverb and screen effects come in Stage 6 |

A scene may use any other extension the converter accepts (`KHR_materials_*`, `KHR_texture_transform`, `KHR_mesh_quantization`, `EXT_meshopt_compression`, `KHR_texture_basisu`); one listed in `extensionsRequired` that FlatChat does not know refuses the world.

## Limits (v1)

| What | Limit | Why |
|---|---|---|
| The whole folder | 512 MB | A world downloads over the world connection from a home PC (S2.04) |
| One file | 256 MB | |
| Triangles in view-independent total | 2,000,000 per world; a warning above 1,000,000 | The weak-laptop floor draws 0.5 to 1 million at 30 fps (BUDGETs) |
| Texture size | 4096 px a side; a warning above 2048 | Memory on integrated graphics |
| Nodes | 65,536 | |
| Markers | 1,000 spawn points, 1,000 seats, 256 portals, 256 zones, 256 sound emitters | |
| Names | 128 characters, plain text | Shown to players |

## What the validator reports

Each problem has a code, a severity (`error` refuses the world, `warning` lets it through), where it is (a file, and a JSON path in a scene) and a sentence. Errors include `toml-syntax`, `format-unsupported`, `field`, `scene-missing`, `path-unsafe`, `gltf-syntax`, `gltf-version`, `extension-unsupported`, `uri-external`, `index-out-of-range`, `no-spawn`, `too-big`, `too-many-triangles`, `texture-too-large` and `marker-invalid`.

## The base library (S2.05)

Parts every client carries, which a world places by id instead of shipping their geometry: a world made only of parts downloads its plan and nothing else (the kit `kits/worlds/park`, written by `tools/converter/scripts/make-park.ts`, is 69 parts and a spawn point; built, about 37 KB). Each part's origin is the centre of its footprint on the floor, its front facing -z. Version 1 is a greybox kit; later art may change how a part looks, never its id, its size or its solids.

| Id | What it is | Solids and seats |
|---|---|---|
| `flatchat:floor-4`, `flatchat:floor-8` | Paving, 4 or 8 m square, 0.2 m thick, its top at the node | Solid |
| `flatchat:platform-4` | A 4 m block, 1.5 m high | Solid |
| `flatchat:stairs-4` | Six 0.25 m steps up toward -z over 4 m, 2 m wide | Solid; climbs onto a platform |
| `flatchat:wall-4`, `flatchat:wall-door-4` | A 4 m wall, 3 m high, 0.2 m thick; with a 1.2 m doorway | Solid |
| `flatchat:arch-4` | Two posts and a lintel over 4 m, 4 m high | Solid |
| `flatchat:pillar` | 0.5 m square, 3 m high | Solid |
| `flatchat:fence-4` | Two posts and two rails over 4 m, 1 m high | Solid |
| `flatchat:bench` | A 1.6 m bench | Solid; two seats |
| `flatchat:table` | A 1.6 by 1 m table | Solid |
| `flatchat:crate`, `flatchat:rock` | A 1 m crate; a low rock | Solid |
| `flatchat:lamp` | A 2.85 m lamp post | The post is solid, the lamp is not |
| `flatchat:tree` | A trunk and two boxes of leaves, 4.2 m high | The trunk is solid, the leaves are not |

At most 10,000 parts in a world.

## What the converter makes of it

The host tool's converter ([tools/converter](../tools/converter/README.md)) turns a folder that passes into a built world: `world.json` (the markers in world space, the files by their SHA-256) and the files themselves. Each scene becomes one GLB with meshopt-compressed geometry and KTX2 textures; a mesh of 2,000 triangles or more gets two simpler copies, its levels of detail, which the client switches to with distance, so a detailed world stays drawable on a weak laptop; the solids become `collision.bin`, and a navigation mesh is built for click-to-move. Nothing in the folder needs to change for this.

## Versions

Version 1 (Stage 2, S2.01): the folder, `world.toml`, the markers above. A change that older tools would misread raises `format`.
