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

[look]                           # optional (S6.05): the sky, fog and light, and screen effects
sky = "#2b2d42"
fog = { colour = "#2b2d42", near = 25, far = 90 }   # fog = false for none
sun = { colour = "#ffb38a", intensity = 1.4, direction = [-0.7, 0.35, -0.3] }
bloom = { strength = 0.9, threshold = 0.75 }        # neon glow
filters = { vignette = 0.35, grain = 0.15, saturation = 1.1 }

[[overlays]]                     # optional, at most four (S6.02)
image = "overlays/frame.png"     # a PNG in the folder, 1024 px a side at most
hud = "centre"                   # its screen point
size = 1                         # its longer side as a share of the screen's height: 1 is the whole screen
opacity = 0.5
motion = "none"                  # none, pulse, bob or spin
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
| `look` | The world's look ([world looks](world-looks.md)): `sky`, `fog` (or `false`), `sun`, `ambient`, and the screen effects `bloom`, `shafts`, `reflections` and `filters`, each on only when given; every visitor may switch each screen effect off. Left out, a world keeps the look every world had before |
| `overlays` | Screen overlays every visitor sees until they switch worlds' overlays off (S6.02, [overlays](overlays.md)): at most four; `image` a PNG in the folder, 1024 px a side at most; `hud` one of the nine screen points (`centre` by default); `size` 0.03 to 1 (0.15 by default); `opacity` 0.1 to 0.8 (0.8 by default); `motion` `none`, `pulse`, `bob` or `spin` |

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
| Zone | `FLATCHAT_world`: `{ zone: { kind, size: [x,y,z], range?, gain?, room?, mix? } }` | A box where sound changes. Voice, applied by the world server (S3.08): `kind` is `voice` (`range` in metres, 1 to 200, and `gain`, 0 to 4, for everyone inside: a stage carries farther and louder, and listeners hear it fade over the same range), `quiet` (no voice heard or sent: Q-L18), or `private` (voice only among those inside); a minor's voice keeps the world's range and gain. The room's echo, in each client (S6.06, [3D audio](audio.md)): `reverb`, with `room` (`small`, `room`, `hall`, `cave` or `cathedral`; `room` when left out) and `mix` (0 to 1, how much of the room is heard; 0.35 when left out); a listener in two reverb zones hears the smaller. Screen effects are the world's `[look]` ([world looks](world-looks.md)) |
| Effect | `FLATCHAT_world`: `{ effect: { uri, scale? } }` | A particle effect made in Effekseer's editor (S6.01) that loops at the node, seen by everyone in the world: `uri` is its `.efkefc` file (or an older `.efk`), a relative path inside the world folder, with the textures, models and sounds it names at their paths beside it; `scale` is 0.01 to 100 (1 by default). It plays in the platform's runtime, Effekseer 1.8, with Effekseer's own materials (no material files yet) and PNG textures; its sounds are kept but do not play yet. The converter and every client play it before it is used, and the world's effects together have a budget ([effects](effects.md)) |

A scene may use any other extension the converter accepts (`KHR_materials_*`, `KHR_texture_transform`, `KHR_mesh_quantization`, `EXT_meshopt_compression`, `KHR_texture_basisu`); one listed in `extensionsRequired` that FlatChat does not know refuses the world.

## Limits (v1)

| What | Limit | Why |
|---|---|---|
| The whole folder | 512 MB | A world downloads over the world connection from a home PC (S2.04) |
| One file | 256 MB | |
| Triangles in view-independent total | 2,000,000 per world; a warning above 1,000,000 | The weak-laptop floor draws 0.5 to 1 million at 30 fps (BUDGETs) |
| Texture size | 4096 px a side; a warning above 2048 | Memory on integrated graphics |
| Nodes | 65,536 | |
| Markers | 1,000 spawn points, 1,000 seats, 256 portals, 256 zones, 256 sound emitters, 64 effects (each per scene) | |
| Names | 128 characters, plain text | Shown to players |

## What the validator reports

Each problem has a code, a severity (`error` refuses the world, `warning` lets it through), where it is (a file, and a JSON path in a scene) and a sentence. Errors include `toml-syntax`, `format-unsupported`, `field`, `scene-missing`, `path-unsafe`, `gltf-syntax`, `gltf-version`, `extension-unsupported`, `uri-external`, `index-out-of-range`, `no-spawn`, `too-big`, `too-many-triangles`, `texture-too-large` and `marker-invalid`; a world overlay's image adds `overlay-image` (not a PNG, or too big); an effect marker adds `effect-invalid` (not an Effekseer file), `effect-too-new` (saved by an editor newer than the runtime), `effect-materials` (it uses material files), `effect-file-missing` (a texture or model it names is not beside it; a missing sound is a warning) and `effect-texture` (a texture that is not PNG). The validator reads an effect and never plays it.

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

The host tool's converter ([tools/converter](../tools/converter/README.md)) turns a folder that passes into a built world: `world.json` (the markers in world space, the files by their SHA-256) and the files themselves. Each scene becomes one GLB with meshopt-compressed geometry and KTX2 textures; a mesh of 2,000 triangles or more gets two simpler copies, its levels of detail, which the client switches to with distance, so a detailed world stays drawable on a weak laptop; the solids become `collision.bin`, and a navigation mesh is built for click-to-move. Each effect is played in the pinned runtime for 600 frames, three times, over a context that draws nothing (the dry run, [effects](effects.md)), then packed with exactly the files it names into one file of kind `effect`; the built world lists it by scene with its place, scale and the most it ever drew. An effect that does not play, or that is over a world's limits for one effect, refuses the world (`effect-refused`), and so do effects that together could draw more than a world may (`effects-over-budget`: 2,000 particles, 8,000 quads and 100,000 model triangles, the same effect counted once per marker). Each screen overlay's image is written again (one still frame, nothing else) as a file of kind `overlay`, listed in `world.json` with its look. Nothing in the folder needs to change for this.

## Versions

Version 1 (Stage 2, S2.01): the folder, `world.toml`, the markers above. The effect marker came in Stage 6 (S6.01) and `[[overlays]]` in S6.02; a tool from before them leaves effects out and warns of an unknown key, and builds the rest. A change that older tools would misread raises `format`.
