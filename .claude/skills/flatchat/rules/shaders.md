---
title: Creator Shaders — the Graph Format, Its Safety by Construction, the Converter, the Client's Compile and Policy, and the GPU Reset
impact: HIGH
impactDescription: A shader language with loops or raw time lets a stranger hang or strobe a viewer's GPU; an operation unsafe at one input fills a screen with NaN; a graph inlined without variables explodes in size; a client that trusts the converter's check runs whatever a cache or a host hands it; a reset that does not turn creator shaders off walks a Windows machine towards a bug check.
tags: creator shaders, shader graph, FLATCHAT_shader, node graph, checkShaderGraph, SHADER_OPS, SHADER_LIMITS, SHADER_BOUND, SHADER_EPS, evaluateShaderGraph, oscillate, fresnel, TSL, three/tsl, MeshStandardNodeMaterial, compileCreatorShader, CreatorShaderPlugin, MaterialShader, shaderCost, rank, fallback, shadersStrangers, gpu reset, device.lost, webglcontextlost, watchGpu, loseGpu, flatchatTest, S6.03, Q-M12, T-01, cl-007, rr-008
---

Stage 6's S6.03 (Q-M12, T-01, cl-007, DR-01): creator shaders as data-only node graphs. The picture is `docs/shaders.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/shader-graph.ts` | The format (`SHADER_FORMAT`, `SHADER_EXTENSION` = `FLATCHAT_shader`), `SHADER_OPS` (each operation's inputs, type rule, cost, settings), `SHADER_LIMITS`, `checkShaderGraph` (cycles, size, depth, types, cost, texture reads, oscillators; drops unreachable nodes), `evaluateShaderGraph` (the reference semantics), `oscillation` |
| `packages/content/src/avatar.ts` | `AvatarStats.shaderCost` (optional: earlier converters did not measure it; `rankOf` counts a missing number as none), `RANK_LIMITS[*].shaderCost`, `AvatarManifest.shaders`, `SHADER_EXTENSION` in `LEVEL_EXTENSIONS` |
| `tools/converter/src/avatar/shader.ts` | `ShaderExtension` / `ShaderData`: the extension in glTF-Transform, each texture a real graph edge (`RefMap`), indices written back |
| `tools/converter/src/avatar/convert.ts` | `checkShaders` (each graph, its textures, a fallback: MToon, a base colour or a base colour texture; the avatar's total), `stripShaders` on LOD1, LOD2 and the impostor; converter 1.4.0 |
| `tools/converter/src/avatar/samples.ts` | `sampleShaderAvatar()`: the VRM 1.0 sample with a pulsing rim glow (the e2e's avatar) |
| `apps/client/src/renderer/src/world/avatar-loader.ts` | `CreatorShaderPlugin`: each material's graph checked again, its textures loaded, left on `material.userData.flatchatShader` |
| `apps/client/src/renderer/src/world/creator-shader.ts` | `compileCreatorShader(checked, textures, fallback)`: TSL with the safe semantics, every node bounded and `.toVar()`'d, outputs clamped into a `MeshStandardNodeMaterial` |
| `apps/client/src/renderer/src/world/avatar-layer.ts` | `Entry.shaders` (LOD0's meshes with a shader), `applyShaders` by `AvatarPolicy.shaders`, compiled on first want, fallbacks back before a level is disposed, `shaderCount()` |
| `apps/client/src/renderer/src/world/gpu-reset.ts`, `session.ts`, `ui/WorldView.vue`, `ui/ClientApp.vue` | `watchGpu` (device.lost, webglcontextlost), `gpuResets.count` (module state that outlives a session), the policy, `rejoin(true)` (at once, `travel.status` `gpu`), `loseGpu` behind `window.flatchatTest` when the preload says `e2e` |

## The Rules

| Rule | Why |
|---|---|
| Every operation is safe over its whole domain: divisors kept from zero with their sign, `pow(max(a, eps), b)`, `sqrt(max(a, 0))`, normalising by `max(length, eps)`, smoothstep through the safe division, clamp as `min(max())` | WGSL and GLSL leave these undefined (pow(0, 0), clamp with low above high, smoothstep with equal edges): a NaN would spread over the screen |
| Bound every node's value to ±`SHADER_BOUND` | A chain of products overflows float32 to infinity, and infinity minus infinity is NaN |
| `.toVar()` every node in the compiler | A diamond-shaped graph inlined as expressions doubles at every level: a compile bomb from 48 nodes |
| No raw time: only `oscillate`, 2 Hz at most, two per graph | A graph that can read the clock can strobe at the frame rate; the residual pulse risk is the trust shields' and the safe-mode key's (T-01) |
| The client checks every graph again (`CreatorShaderPlugin`) and the converter keeps only the checked graph | Files come from a cache, a store or a host; nothing is trusted because something else checked it |
| A graph refused by the client leaves the material its own look; a compile that throws marks that material `broken` for good | A shader never makes an avatar vanish |
| Creator shaders on LOD0 only | The lower levels are the crowd's: their budgets assume the fallback |
| Policy: the viewer's own and friends' on; strangers' only with `settings.avatar.shadersStrangers`, never on the low tier, never shielded; none in safe mode or after a GPU reset | T-01's resolution, Q-M10's shields |
| After a GPU reset, rejoin with a fresh renderer and keep `gpuResets.count` above 0 until the client restarts | rr-008: Windows bug-checks after five GPU hangs within a minute; a lost device does not come back |
| The e2e's world-server join counts include the rejoin after its GPU reset | It checks the recovery happened, not just that nothing broke |
| Effekseer `.efkmat` stays refused | The effects runtime compiles them itself, outside these checks |
| Prove a shader draws with the look check (`look-check.ts`, `--crowd-look=1`, `crowd/look.ts`), not the e2e | The e2e wears a standard body (items fit only those), so its uploaded avatar never shows in a world |
