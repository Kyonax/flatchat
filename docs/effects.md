# Effects

Particles, auras, trails and bursts made in [Effekseer](https://effekseer.github.io), the free effect editor, are FlatChat's effects (Stage 6's S6.01, Q-M8, Q-M9), for avatars' attachment points and for worlds' scenes. One runtime plays them, pinned to one version, and a guard layer holds strangers' effects to a budget, so an effect can neither stall a weak laptop nor crash the client.

## The runtime

Effects play in **Effekseer 1.80.7**, in EffekseerForWeb's runtime ([packages/effects/third_party/effekseer/](../packages/effects/third_party/effekseer/README.md)).

- **Two builds.** The client draws with three.js's WebGPU renderer, so the runtime records into the client's own WebGPU render pass; where the renderer falls back to WebGL2, the WebGL build draws into the same context. Both builds come from one commit.
- **Built from source.** EffekseerForWeb has no release yet, so it is built here with Emscripten 6.0.7. Without FlatChat's patch the build equals upstream's own CI build, byte for byte; with it, the files in the repository. `build.sh` does both.
- **The patch.** Each playing effect's particle count, spawning off for one effect, and the GPU timer; ES module output; a 1 GB memory ceiling.
- **Never on.** GPU particles (the runtime never makes their system), distortion (it draws over a copy of the frame, which the client never hands over) and an avatar's effect sounds (Q-H1). A world's effect sounds play at the "high" tier.

## Effect files

The editor saves an effect as an `.efkefc` (Effekseer 1.5 and later; the older `.efk` is its runtime body alone). `packages/content/src/effect.ts` reads one without running it:

- **The version.** The body's version against the runtime's: at most 1810, Effekseer 1.8's. The runtime refuses a newer editor's files.
- **The resources.** The files it names, by kind and in the order the runtime reads them: textures (colour, normal, distortion), sounds, models, material files and curves. A material file (`.efkmat`) is a node-graph shader, so a creator shader (S6.03).

The platform keeps an effect as one bundle (FCFX: the effect and the files it uses, by path), named by its SHA-256 like every converted file, so a client fetches one file per effect.

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

## Fuzzing

`tools/converter/test/effect-fuzz.test.ts` breaks Effekseer's samples 300 ways (bytes flipped, the file cut short, chunk sizes and counts that lie, garbage put in) and runs each through the reader and the pinned runtime. Each must be refused by the reader, refused by the dry run (the deadline included) or measured. Nothing else may happen, and a fresh runtime afterwards plays the laser as before. On 2026-10-18 the corpus ended 103 times at the reader, 112 times in the runtime, once at the deadline and 84 times measured.

## The samples

[kits/effects/samples/](../kits/effects/samples/) holds five of Effekseer's CC0 samples, with the textures they use, copied byte for byte from the 1.80.7 release: Aura01, Barrior03 and ForceFieldTornado, Laser01 and Simple_Track1. The tests use them, and the samples' notice that puts them all under CC0 is saved in `kits/provenance/archive/`.
