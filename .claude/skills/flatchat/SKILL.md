---
name: flatchat
description: "The engine skill for FlatChat (a social world platform, VRChat on a flat screen): TypeScript end to end on Node.js 24 with npm workspaces; the Electron 44 client (main, preload, renderer, Vue 3.5, three.js r186 WebGPU or WebGL2, smoke and bench modes); the core (accounts, the age rule, browser sign-in, sessions, worlds, connect tokens, trust levels, PostgreSQL); the world server, its plugins, entry rules and roles, its transports (WebRTC via node-datachannel, raw UDP with our own encryption), joins, interest management, snapshots, voice forwarding; the wire protocol (codecs, messages, connect tokens, the handshake, golden packets); headless bots and load tests; VRM avatar crowds; licences by folder and SPDX headers; untrusted-input security; offline tests; the harness (npm run harness) and its trap linter (T01-T21); GitHub Actions CI on GPU-less runners; Linux and Windows packaging; the weak-laptop stand-in. Use for any change, test, CI failure, build or measurement here, and before calling work done."
user-invocable: true
metadata:
  version: "1.54.0"
  verified: "2026-10-18"
---

# FlatChat

How to build, test and verify FlatChat in this repository: where each kind of code lives and under which licence, the client's security model, how it draws and how frames are measured, the world server, the wire protocol every program shares, how to test without a GPU, the harness that every change must pass, CI, packaging, and the stand-in that turns a desktop into a weak laptop. Every fact here was checked on the code and on real runs (Linux desktop with an NVIDIA card, a Windows VM without a GPU, GitHub's runners) on 2026-10-16.

## Core Principle: Prove It Headless, Keep Strangers' Input Inert

Everything that can be decided without a GPU is decided in pure modules and proven by `npm run harness`; the hardware is exercised only by short smoke and bench runs. And because every world, avatar, name and message comes from other people, nothing they made is ever run, rendered as HTML or loaded raw: the trap linter enforces the patterns, the rules explain them.

## Fast Path

| Step | Command |
|---|---|
| Install (Node.js 24 from `.tool-versions`) | `mise install && npm install` |
| Verify any change (required before "done") | `npm run harness` |
| Only the trap linter | `npm run lint:traps` |
| The client, live | `npm run client` |
| The client draws (needs a display) | `npm run client:smoke` |
| A world server | `npm run server -- --port 0 --ticks 100` |
| The core on this machine (read `core-service` first) | `npm run core:db -- start`, then `npm run core` with its environment |
| Bots on both transports, 4 s (part of the harness) | `npm run bots -- smoke` |
| A measured load test (read `bots-and-load-tests` first) | `npm run bots -- run --transport rtc --bots 200 --minutes 30 --server-cpus 0-1 --bot-cpus 2-7` |
| The protocol's golden files up to date | `npm run golden -w @flatchat/protocol` |
| Measure on the weak-laptop stand-in (read first) | `npm run standin -- plan --target iris-xe` |
| The avatar crowd bench (read `avatars-and-crowds` first) | `apps/client/release/linux-unpacked/flatchat --crowd=300 --avatars=DIR --crowd-out=FILE` |

## When to Apply

Reference these guidelines when:

*   Adding or changing any code, folder, package or workspace in this repository.
*   Touching the client's main process, preload, IPC, window settings, content security policy or menu.
*   Drawing anything, choosing a three.js entry point, or quoting a frame rate.
*   Changing the world server, its tick loop, flags or log lines.
*   Touching the core: accounts, sign-up, sign-in, sessions, worlds, connect tokens, its database or pages.
*   Changing how programs connect: the transports, joins, interest management, snapshots, voice forwarding or chat.
*   Running bots, load-testing a world server, or quoting a bandwidth, tick or capacity number.
*   Touching voice: capture, the codec, the playout buffer, spatial sound or mouth shapes.
*   Adding or changing a network message, a codec, the connect token or the version handshake; reading packets from other players.
*   Handling chat, names, world or avatar files, uploads, plugins or network messages.
*   Writing or loading a world plugin, an entry rule, or anything that reads trust levels or the tester flag.
*   Writing tests, or making code testable without a GPU, Electron or sudo.
*   A harness check, a trap-linter finding or a CI job fails.
*   Upgrading Node, npm, TypeScript, ESLint, Electron, Vite, Vue or three.
*   Packaging the client, or checking it on Windows.
*   Measuring performance against the integrated-graphics laptop floor.

## When to Read Which Rules

| If working on... | Read these rules |
|---|---|
| Finishing any change: what "verified" means, the harness, a trap finding | `rules/harness-and-trap-linter.md` |
| A new file, folder, package or workspace; a licence or SPDX header; any asset, ours or third-party, and its provenance record | `rules/repository-and-licences.md` |
| The client's main process, preload, IPC, window settings, CSP, menu, smoke or bench flags | `rules/client-electron.md` + `rules/security-untrusted-input.md` |
| Chat, display names, world or avatar files, uploads, plugins, network messages | `rules/security-untrusted-input.md` |
| Rendering, three.js, WebGPU or WebGL2, adapters, frame rates and frame times | `rules/rendering-three-webgpu.md` |
| The world server: ticks, flags, JSON log lines, shutdown, Node-run TypeScript | `rules/world-server-node.md` |
| The transports (raw UDP, WebRTC), joins, interest management, snapshots, voice forwarding, chat | `rules/world-networking.md` + `rules/protocol-and-codecs.md` + `rules/security-untrusted-input.md` |
| Bots, load tests, measured runs, the S0.07 pass lines, the devlog view | `rules/bots-and-load-tests.md` + `rules/world-networking.md` |
| Voice: capture, Opus, the playout buffer, distance, HRTF, mouth shapes, the S0.08 tests | `rules/voice-chain.md` + `rules/client-electron.md` |
| Avatars: VRM loading, merged materials, texture budgets, levels of detail, proxies, crowds, the S0.09 bench | `rules/avatars-and-crowds.md` + `rules/rendering-three-webgpu.md` + `rules/security-untrusted-input.md` |
| The protocol: messages, codecs, connect tokens, the version handshake, golden packets | `rules/protocol-and-codecs.md` + `rules/security-untrusted-input.md` |
| The core: accounts, invitations, the age rule, sign-in, sessions, worlds and their keys, connect tokens, SQL, its pages, the admin command line | `rules/core-service.md` + `rules/security-untrusted-input.md` |
| The client app: signing in through the browser, settings and key bindings, the two languages, the world view, chat, voice in the world, the end-to-end test | `rules/client-app.md` + `rules/client-electron.md` |
| Movement: the character controller, the server's move checks, the plaza and maps | `rules/movement-sim.md` + `rules/world-networking.md` |
| Worlds as files: world.toml, glTF scenes and their markers, limits, the validator | `rules/world-format.md` + `rules/security-untrusted-input.md` |
| Buildings from SVG plans: the plan format, the builder (walls, openings, slabs, stairs, the trim sheet, baked light), the docking bay, the isometric previews (anatomy, iso-figures) | `rules/building-plans.md` + `rules/world-format.md` |
| Effects: the pinned Effekseer runtime (EffekseerForWeb, its build and patch), effect files and bundles, the dry run and its deadline, the limits, the guard (budgets, trimming, GPU and CPU watches), fuzzing, the CC0 samples; a world's effect markers and the client measuring them again | `rules/effects.md` + `rules/security-untrusted-input.md` (+ `rules/world-format.md` for worlds) |
| Screen overlays: the format, the consent rule (`overlayVisible`), the viewer's caps, overlay items (slot `overlay`, PNG), world `[[overlays]]`, the safe-mode key (Shift+Esc), the starter badges | `rules/overlays.md` + `rules/security-untrusted-input.md` |
| Creator shaders: the graph format and its safety by construction, the converter's `FLATCHAT_shader`, the rank's shader cost, the client's TSL compile and policy, the GPU-reset fallback | `rules/shaders.md` + `rules/security-untrusted-input.md` (+ `rules/avatar-converter.md`) |
| Avatar uploads: the converter (VRM 0.x/1.0, GLB), VRM inside glTF-Transform, levels, impostors, ranks, the manifest, the sandboxed CLI | `rules/avatar-converter.md` + `rules/security-untrusted-input.md` |
| The three standard bodies: making or changing the body kits, headless Blender with MPFB and the VRM add-on, `kits/bodies/` | `rules/body-kits.md` + `rules/avatar-converter.md` |
| Items (clothes, hair, hats, glasses): the item format, slots and caps, hide-mask regions, the item converter, the no-clipping check, outfits and what can be worn together; the starter wardrobe and making garments from MakeHuman's | `rules/items.md` + `rules/body-kits.md` |
| Item uploads, saved outfits, the standard bodies as avatars (`POST /api/v1/avatars/kit`), the converters' sandbox | `rules/core-service.md` + `rules/items.md` + `rules/security-untrusted-input.md` |
| Wearing outfits in the client: the standard-body buttons, the items panel, the quick menu (O), fits on a body's bones, hidden regions, props at points | `rules/client-app.md` + `rules/items.md` + `rules/avatars-and-crowds.md` |
| The free gallery: licence fields (VRM 1.0's terms), publishing, browsing, taking, withdrawing, copies refused at upload, the gallery and publish panels | `rules/gallery.md` + `rules/core-service.md` + `rules/client-app.md` |
| Emotes and dances: VRMA, the retargeter (T-pose, A-pose straightening, facing, units), BVH, GLB clips, FBX through headless Blender, the animation golden files; the default clips (Track P's P.05) and their checks | `rules/animations.md` + `rules/avatar-converter.md` |
| Avatars and items as FBX, OBJ, DAE or .blend: format detection, headless Blender on the core (to-glb.py), DAE through assimp, the format fixtures, declarations given at upload, the client's declaration form | `rules/model-formats.md` + `rules/avatar-converter.md` + `rules/items.md` |
| Fingerprints (shapes, texture hashes), copies caught at upload, the takedown form and its status page, the admin page's takedown queue, removal everywhere, strikes and bans | `rules/fingerprints-and-takedowns.md` + `rules/core-service.md` + `rules/gallery.md` |
| Hosting by others: the host tool, approvals and the admin page, world keys, packaging, the container, capacity advice, the world's database | `rules/host-tool.md` + `rules/core-service.md` |
| World plugins: plugin.toml, the loader, hooks, the host interface and permissions, failures and async code, the entry rules, `host plugins` | `rules/plugins.md` + `rules/security-untrusted-input.md` |
| Trust levels, active days, the tester flag, `FLATCHAT_CORE_TRUST` | `rules/core-service.md` + `rules/plugins.md` |
| Roles in a world, giving them, the People panel, builds sent by others (`host push`), moderation | `rules/roles-and-moderation.md` + `rules/world-networking.md` |
| Reports, the voice clip, the public form, the triage queue, under-age reports, keeping and purging evidence | `rules/reports-and-safety.md` + `rules/core-service.md` |
| Writing or fixing tests; testing without a GPU, Electron, sudo or the network | `rules/offline-testing.md` |
| Adding a trap to the linter or a check to the harness | `rules/harness-and-trap-linter.md` + `rules/offline-testing.md` |
| A failing or changed CI workflow; reading a red run | `rules/ci-github-actions.md` |
| Installing, upgrading or pinning tools; install-time warnings | `rules/toolchain-versions.md` |
| Packaging for Linux or Windows; checking a Windows build | `rules/packaging-windows-linux.md` |
| Measuring against the laptop floor; nvidia-smi clock locks; stand-in profiles | `rules/weak-laptop-stand-in.md` + `rules/rendering-three-webgpu.md` |

A trap-linter finding names its rule; read that rule.

## Quick Reference

| Rule | Description |
|---|---|
| `repository-and-licences` | Folder map with licences and workspaces, what the layout check enforces, SPDX header per file type, adding folders, third-party assets, every asset's provenance record (the `assets` check, P.07). |
| `toolchain-versions` | Node 24 via `.tool-versions`, npm workspaces commands, every pinned version and why (TypeScript ~6.0), install quirks, upgrades. |
| `client-electron` | Main/preload/renderer split, locked window settings, the bridge and IPC, CSP, menu, smoke and bench flags and exit codes (T01–T04, T07–T10, T16). |
| `rendering-three-webgpu` | WebGPURenderer start-up, backend and adapter, software renderers per machine, fixed-size bench, frame-time statistics. |
| `world-server-node` | TypeScript Node can strip, the server's files and exports, the drift-free ticker, flags, JSON log lines (ready, metrics, stopped), clean shutdown, process tests. |
| `world-networking` | The Link seam; raw UDP's handshake, encryption and reliable stream; WebRTC through node-datachannel (one ICE port, negotiated channels, its traps); the join flow; interest tiers, encoding once per cell, snapshot packing; voice bundles; chat. |
| `voice-chain` | The client's voice: Opus as WebAssembly (why not WebCodecs), the capture and playout worklets, the playout buffer's rules, distance and HRTF, mouth shapes, the voice and load tests. |
| `avatars-and-crowds` | VRM on the WebGPU renderer (MToon node materials, shared textures, VRM 0.x poses), what the converter must do (merge materials, texture budgets), paced swaps, the crowd bench and S0.09's pass lines, the test-avatar sets. |
| `bots-and-load-tests` | `tools/bots`: movement, talking, the bot, swarms; `npm run bots -- smoke|run|report|render`; an isolated network with wire counters, core pinning, netem; the report and S0.07's pass lines. |
| `client-app` | The app mode: sign-in in the main process (core-api, loopback, auth, safeStorage), settings and bindings, vue-i18n with the bare-strings rule, the world view (session, controls, remotes, camera, instanced avatars), standard bodies, items and the outfits menu (fits on bodies, hidden regions, props), chat and voice limits, the end-to-end test with Playwright. |
| `host-tool` | `tools/host-tool`: sign-in from a terminal, request, approve on `/admin` (CSRF, session cookie), key, run; the capacity advisor; the package and container image; the world's SQLite database. |
| `plugins` | World plugins (S3.01, S3.05): plugin.toml checks, the in-process model and the narrow `HostApi` (T-04), permissions and `HOOK_NEEDS`, refusals, `guard` with promise handling, fail-closed entry rules, the three entry rules, `host plugins`. |
| `roles-and-moderation` | Roles per world (S3.06): `RIGHTS` and `can`, the owner from the token, roles in the world's database, `giveRole`'s rules, the People panel, builds by others (`put`/`got`/`publish`, staging, `loadBuiltWorld`, the swap, exit 75, the client's rejoin). |
| `reports-and-safety` | Reports (S3.02): the clip recorder and the one place that takes it (T20), evidence, the report form, the core's reports, the public form, the triage queue's order, under-age reports, keeping and purging evidence; friends, blocks, minors and the guardian link; the abuse path (S3.12): takedown, sealed preservation (T21), the authorities' drafts, the 48-hour clock, the drill. |
| `world-format` | `packages/content`: world.toml's fields, the OMI and FLATCHAT_world markers at world transforms, safe paths, limits, `validateWorld`. |
| `building-plans` | Semantic SVG plans built into worlds (P.01): the SVG reader, `readPlan`, `buildPlan` (mitered walls, openings, slabs, stairs, strips, the trim sheet, light baked with shadows, one mesh a material), faces wound to their normals, the docking bay, previews by anatomy and iso-figures. |
| `effects` | Effekseer 1.80.7 in EffekseerForWeb (WebGPU and WebGL builds, from source, byte-checked), `readEffectFile` and the FCFX bundle, the dry run over a stand-in context (quads and model triangles, the 95th-percentile update) in a worker with a deadline, the limits, `EffectBudget`, `InstanceTrim`, `TimeWatch`, the fuzzed corpus, effect files as assets, world effects (the converter's world budget, the client's own check and measuring worker), the hostile host check. |
| `overlays` | Screen overlays (S6.02): nine screen points, still PNGs with slow motions, the consent rule and the viewer's caps, overlay items and starters, world overlays checked by the client too, safe mode on Shift+Esc (impostors, no overlays, no one else's effects). |
| `shaders` | Creator shaders (S6.03): data-only node graphs (no loops, bounded size, safe operations, slow oscillators), the converter keeping them on LOD0 with a required fallback and a cost in the rank, the client checking and compiling them to TSL, who sees them, a GPU reset turning them off for the session. |
| `avatar-converter` | Avatar uploads into four VRM 1.0 levels, a thumbnail and a ranked manifest: validators and the four repairs, VRM 0.x migration by three-vrm's rules, plain rigs by bone names, the turn to +Z, LOD1/LOD2 with merged materials, the impostor, the rank table, the reference avatars and golden file, the sandboxed CLI. |
| `body-kits` | The three standard bodies made headless from MakeHuman's CC0 assets (MPFB 2.0.18, the VRM Add-on 4.10.2, Blender 5.2 LTS): presets, expression recipes, the underwear layer, MToon, the pinned setup, two agreeing runs, the checks in CI. |
| `animations` | Emotes and dances into VRMA on the normalized humanoid: measured from the source's T-pose (A-pose rests straightened), stood up and turned to face +Z, hips baked and kept near, hand-written VRMA, BVH and GLB readers, FBX through headless Blender, golden files per format. |
| `model-formats` | FBX, OBJ and .blend through headless Blender on the core, DAE through assimp in the converter (welded, defaults dropped), formats by first bytes, the manifests' `source.from`, declarations at upload and fits by mesh name, the Blender fixtures (deterministic bytes) and the stand-in Blender in the core's tests. |
| `fingerprints-and-takedowns` | Every upload's fingerprint (a MinHash of triangle tokens per part, perceptual texture hashes) in result.json; copies of what was taken down (a strike) or of closed gallery entries caught after conversion, with what the kits explain set aside; the takedown form, the admin review, removal everywhere by manifest. |
| `gallery` | The free gallery: licence fields required and never looser than an avatar's file, publishing at trust level 2, taken copies as ordinary rows, withdrawing, exact copies refused unless the licence allows them, fixed SQL with nullable filters. |
| `items` | Items for the three bodies: one fit per body by bone names, fixed slots with caps, 16 hide-mask regions cut where garments end, `convertItem`, the bind-pose skeleton check and the ray-based no-clipping check in seven reference poses (and at the sliders' ends), the test tee, the starter wardrobe (P.08: MakeHuman's garments fitted, weighted from the skin, pushed, checked in 21 poses). |
| `movement-sim` | `packages/sim`: the controller's constants and steps, `SNAP` for rounded heights, `checkMove` on the server, the plaza and `--map`. |
| `core-service` | The core (Fastify, PostgreSQL): files, running it, invitations and the age rule, browser sign-in with PKCE and a loopback redirect, sessions, worlds and keys, connect tokens, security rules (T18, T19), tests on a throwaway cluster. |
| `protocol-and-codecs` | The shared protocol package in Node and the renderer, the codecs' exact encoding, version 0's messages, changing the protocol (version, golden files, docs), tokens and the handshake (T17). |
| `security-untrusted-input` | Never run, render as HTML or load raw what strangers made: eval, innerHTML/v-html, raw loaders, node:vm, exec (T05, T06, T11–T13). |
| `offline-testing` | Pure modules, scene-graph and recorder tests, inline sources, process tests, test conventions. |
| `harness-and-trap-linter` | The harness's checks and options, the skill check, the linter's inputs and its traps, allow comments, adding traps and checks. |
| `ci-github-actions` | The three jobs, AppArmor and SwiftShader steps, time limits, runner renderers, reading red runs, green/red proof (T14, T15). |
| `packaging-windows-linux` | electron-builder settings, Linux folder and Windows zip from Linux, checking a Windows build without a GPU or desktop. |
| `weak-laptop-stand-in` | Imitating Iris Xe or 680M: clock locks, CPU and memory caps, profile derivation and format, commands, verdicts, tuning. |
