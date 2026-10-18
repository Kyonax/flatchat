# Effects

Particles, auras, trails and bursts made in [Effekseer](https://effekseer.github.io), the free effect editor, are FlatChat's effects (Stage 6's S6.01, Q-M8, Q-M9), for avatars' attachment points and for worlds' scenes. One runtime plays them, pinned to one version, and a guard layer holds strangers' effects to a budget, so an effect can neither stall a weak laptop nor crash the client.

## The runtime

Effects play in **Effekseer 1.80.7**, in EffekseerForWeb's runtime ([packages/effects/third_party/effekseer/](../packages/effects/third_party/effekseer/README.md)).

- **Two builds.** The client draws with three.js's WebGPU renderer, so the runtime records into the client's own WebGPU render pass; where the renderer falls back to WebGL2, the WebGL build draws into the same context. Both builds come from one commit.
- **Built from source.** EffekseerForWeb has no release yet, so it is built here with Emscripten 6.0.7. Without FlatChat's patch the build equals upstream's own CI build, byte for byte; with it, the files in the repository. `build.sh` does both.
- **The patch.** Each playing effect's particle count, spawning off for one effect, and the GPU timer; ES module output; a 1 GB memory ceiling.
- **Never on.** GPU particles (the runtime never makes their system), distortion (it draws over a copy of the frame, which the client never hands over) and an avatar's effect sounds (Q-H1). A world's effect sounds are kept in its bundle, and stay off until the client plays sound in 3D (S6.06).

## Effect files

The editor saves an effect as an `.efkefc` (Effekseer 1.5 and later; the older `.efk` is its runtime body alone). `packages/content/src/effect.ts` reads one without running it:

- **The version.** The body's version against the runtime's: at most 1810, Effekseer 1.8's. The runtime refuses a newer editor's files.
- **The resources.** The files it names, by kind and in the order the runtime reads them: textures (colour, normal, distortion), sounds, models, material files and curves. A material file (`.efkmat`) is a node-graph shader, so a creator shader (S6.03).

The platform keeps an effect as one bundle (FCFX: the effect and the files it uses, by path), named by its SHA-256 like every converted file, so a client fetches one file per effect.

## Uploading an effect

An effect is an item worn at an attachment point (the slot `effect`), uploaded the way any item is (`POST /api/v1/items`, then the file to its slot's link). An effect file keeps no declaration of its own, so the upload carries one: the effect's name, its point, the scale it plays at (0.01 to 100; 1 when not given) and its authors. An upload is one of these:

- **One effect file.** An `.efkefc` or an older `.efk` that names no other files.
- **An Effekseer package.** An `.efkpkg`, the editor's export, with every file the effect uses.
- **A zip.** One effect and its files at the paths the effect names, relative to it, at any depth.
- **The platform's bundle.** An FCFX bundle may carry its declaration, as a GLB carries its own; the starter effects are made so.

The converter (`tools/converter/src/effect/`) checks the effect, bundles exactly the files it names and dry-runs it. Everything a client will ever load of the effect is in its bundle.

| Rule | Why |
|---|---|
| The effect's version is at most 1810 (Effekseer 1.8) | The runtime refuses a newer editor's files; the refusal names the editor the file came from |
| No material files (`.efkmat`) | They are creator shaders (S6.03) |
| Every file the effect names is in the upload | Nothing it names can be missing or swapped later |
| Textures are PNGs, 1024 px a side at most, 24 at most and 4 million pixels together | PNG is what both builds of the runtime read; memory on integrated graphics |
| At most 8 models and 48 files | |
| Within an avatar's budget, by the dry run (below) | |

- **Warnings, not refusals.** An avatar's effect brings no sounds (they stay out of its bundle) and its distortion parts do not draw; the item's warnings say so.
- **In the core.** The core runs the converter sandboxed, which allows no threads, so an effect's whole conversion has 60 seconds; past that the effect is refused as too slow to play.
- **No fingerprint.** Effects' textures are soft dots and streaks shared by many effects, so a match on them would be no evidence of a copy; takedowns still remove an effect by its manifest.
- **The starters.** [kits/effects/starters.json](../kits/effects/starters.json) lists the starter effects any account takes with no upload, as it takes a starter item: the aura (at the hips) and the shield (at the chest), two of Effekseer's CC0 samples. The core bundles each with its declaration when it starts.
- **In an outfit.** One effect to a point (a prop may share it), and the outfit's effects fit an avatar's budget together, by their dry runs; the core refuses an outfit that does not. An effect takes an adjustment like a prop.

## The dry run

Before anyone sees an effect, it is played in the pinned runtime (`packages/effects`' `measure`; in Node, the converter's `dryRun` and `DryRunner`, `tools/converter/src/effect/dry-run.ts`). It runs the WebGL build in Node over a WebGL context that draws nothing and counts what it would have drawn. It plays the effect from the start with three random seeds, frame by frame at 60 a second, for up to ten seconds each, and keeps:

- **Peaks.** The most particles it had alive at once, the most quads it drew in a frame (sprites, ribbons, rings and tracks, the runtime's "squares") and its models' triangles.
- **Length.** How many frames it lasts, or that it loops.
- **Update time.** The 95th percentile of its updates. The single slowest moved with a busy machine and refused good effects; the slowest is kept for information.

The runtime cannot be interrupted inside one of its own calls, and a broken file can make one update take half a minute (the fuzzing found one), so the dry run has a deadline of 20 seconds. Where it can, it runs in a worker thread (`DryRunner`), ended past the deadline; the core's sandboxed converter allows no threads, so there the dry run checks the deadline between frames and the core ends the whole conversion past a short deadline of its own.

## What an effect may weigh

These are starting values (rr-013 for particles and quads; the triangles are FlatChat's own), to tune on the reference laptop like the avatars' ranks:

| | Particles | Quads | Model triangles |
|---|---|---|---|
| One avatar's worn effects together | 300 | 2,000 | 20,000 |
| One world's effects together | 2,000 | 8,000 | 100,000 |
| Everything one viewer plays | 4,000 | 16,000 | 200,000 |

- **The dry run's update.** Its 95th percentile may take 2 ms on the converter's machine.
- **While playing.** An effect whose drawing takes over 0.5 ms of GPU time for 3 measured frames in a row is stopped, and so is one whose own update takes over 2 ms for 3 frames, or over 16 ms once.

A runtime is made with the global particle and quad caps, so nothing can pass them. Effekseer's sample effects show the range: a laser is 122 particles and 121 quads; the aura is 118 particles, 101 quads and a 16,940-triangle procedural shell; a trail with 406 particles is too busy for an avatar but fits a world.

## The guard

`packages/effects/src/guard.ts` holds the budget for whoever plays effects:

- **Admission.** An effect plays only if its dry run's peaks fit its owner's budget and everyone's together (`EffectBudget`). A file stopped once is not played again during the visit.
- **Trimming.** While effects play, an owner over its particle budget has its effects stop making particles until it is back under nine tenths of it (`InstanceTrim`). This catches a seed the dry run never saw; the particles already alive play out.
- **Time.** The GPU and CPU watches above (`TimeWatch`). On WebGL the runtime times each effect on the GPU itself; `updateTimed` steps each effect alone and times it.
- **A runtime that gives up.** A broken file can make the runtime abort. From then on every call throws `RuntimeSpent`, and its owner makes a new runtime without that file.

## In the client

The world view plays effects through its effects layer (`apps/client/src/renderer/src/world/effects.ts`):

- **Worn effects.** An avatar's effect rides an empty marker at its attachment point, placed as a prop is, and loops while it is worn. The runtime loads with the first effect, for the renderer's backend; its WebAssembly comes inlined in a chunk of its own.
- **Drawn last.** Effekseer's effects are made for a finished image, so they draw after three.js has written the frame to the canvas, over it (`effects-draw.ts`). The scene's own depth hides them behind what stands in front:
  - On WebGPU, one small pass copies three's depth (multisampled when it antialiases) into a single-sampled depth texture, and the runtime records into a pass on the canvas with it.
  - On WebGL2, one quad writes three's resolved depth into the canvas's depth buffer before the runtime draws.
- **Opaque canvas.** The world's canvas is opaque, so an effect's alpha never shows the page through it.
- **Who shows.** The viewer's own effects show, and the world's. So do a friend's, unless the trust shield or hiding that person covers their avatar. A stranger's show only when the viewer allows strangers' effects in the settings, which they are not by default (Q-M10). Effects can be switched off altogether.
- **The guard.** Admission, trimming and the watches above. An effect's first five frames after it starts are left out of the watches: a procedural mesh is made or a pipeline compiled then, once.
- **A runtime that gives up.** It is replaced, the effect that did it is blocked for the visit, and the rest play again.
- **The starters' size.** Effekseer's samples are authored large: the starter aura and shield play at 0.12 of it.
- **Checked end to end.** The end-to-end test takes the starter aura at home, puts it on beside the tee in a world, and checks it plays (118 particles on WebGPU here, 125 on WebGL2 in CI's software renderer; drawn with the scene's depth, nothing stopped), then takes it off. The second world it travels to has a tornado by its arrival point, and it checks that plays too (about a thousand particles once it has built up). The offline check plays the same world as a folder, converted by the client itself, and checks the tornado plays there. The test fails on any error on the page.

## In a world

A world places effects with a marker in its scenes (`FLATCHAT_world`: `{ effect: { uri, scale? } }`, [the world format](world-format.md)): an `.efkefc` beside the scene, with the files it names, played where the node is, looping, for everyone in the world. The tool's `make-travel` script can put Effekseer's tornado in a generated world (`--effect`).

- **The validator** reads each effect without playing it: the version, no material files, every texture and model it names beside it (a missing sound is a warning), and PNG textures.
- **The converter** dry-runs each one for a world (sounds are kept; the world's limits for one effect), packs it with exactly its files into one file of kind `effect`, and lists it by scene with its place, scale and peaks. An effect used by several markers at one scale is measured once. Then the world's effects are added up, each marker once, and a world whose effects together could pass the world's budget is refused (`effects-over-budget`), as one that does not play is (`effect-refused`). The host tool runs the dry runs in a worker thread with the 20-second deadline. So does the client's main process for a world folder played offline: its code is bundled, so the worker thread comes bundled with it and the runtime's WebAssembly sits beside it.
- **The client** does not take the host's numbers: a world comes from its host, and a host is not trusted. When a world loads, each of its effects is read and checked again by the rules an upload meets (`checkEffectBundle` in `packages/content`: the runtime's version, no material files, PNG textures within their size, the files it names), then measured again on the viewer's machine, one at a time in a worker that is ended past the deadline, and only its own numbers decide: one over a world's limits, or with an update of over a tenth of a second (a freeze), is refused. Time otherwise is judged while it plays, by the watches, because the dry run's 2 ms is for the converter's machine and a weak laptop is slower. The world's effects then share the world's budget in the guard, as an avatar's share an avatar's.

## Fuzzing

`tools/converter/test/effect-fuzz.test.ts` breaks Effekseer's samples 300 ways (the corpus is `tools/converter/src/effect/fuzz.ts`, seeded, the same every run) (bytes flipped, the file cut short, chunk sizes and counts that lie, garbage put in) and runs each through the reader and the pinned runtime. Each must be refused by the reader, refused by the dry run (the deadline included) or measured. Nothing else may happen, and a fresh runtime afterwards plays the laser as before. On 2026-10-18 the corpus ended 103 times at the reader, 112 times in the runtime, once at the deadline and 84 times measured.

The same corpus checks the client against a host that does not play fair. `tools/converter/scripts/hostile-effects.ts` puts six broken effects into a built world past the converter, each with made-up numbers: the case whose single update takes about 32 s, a laser that stops the runtime, one the runtime cannot read, one the reader refuses, the laser marked as saved by a newer editor, and an effect that names a material file. The end-to-end test's garden carries them beside its tornado. The client refuses all six (the slow one when its measuring worker is ended at the deadline) and the tornado plays on, with no error on the page.

The corpus also found a fault in the converter's `DryRunner`: a worker ended at a deadline exits after its replacement has started, and its exit failed the new worker's run too. Each run now belongs to its worker (`effect-fuzz.test.ts` keeps the next run after case 270).

## The samples

[kits/effects/samples/](../kits/effects/samples/) holds five of Effekseer's CC0 samples, with the textures they use, copied byte for byte from the 1.80.7 release: Aura01, Barrior03 and ForceFieldTornado, Laser01 and Simple_Track1. The tests use them, and the samples' notice that puts them all under CC0 is saved in `kits/provenance/archive/`.
