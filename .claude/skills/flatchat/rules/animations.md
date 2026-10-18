---
title: Animations — Emotes and Dances into VRMA, the Retargeter, BVH, GLB Clips, FBX through Headless Blender, Golden Files
impact: HIGH
impactDescription: A motion measured from an A-pose rest as if it were a T-pose lifts or buries every arm; a source facing back or Z-up comes out turned; translation copied from any bone but the hips drifts limbs; a VRMA that does not rest in the T-pose with unrotated bones plays wrong in three-vrm-animation; an FBX read with leaf bones ignored loses the head and hands; an arccosine angle check reports quantisation noise as error.
tags: animations, emotes, dances, EmoteMenu, AnimationsPanel, playEmote, emoteTime, readyEmote, parseAnimation, VRMAnimationLoaderPlugin, createVRMAnimationClip, AnimationMixer, S5.07, ad-009, Q-M5, Q-M11, rr-013, VRMA, VRMC_vrm_animation, three-vrm-animation, normalized humanoid, T-pose, A-pose, retarget, straighten, BVH, readBvh, GLB clip, readGltfMotion, FBX, fbx2glb.py, make-sample-fbx.py, headless Blender, ignore_leaf_bones, convertAnimation, AnimationError, animationFormat, mapJoints, writeVrma, loops, ANIMATION_FORMAT, AnimationManifest, checkAnimationFile, checkAnimationManifest, ANIMATION_MAX_SECONDS, ANIMATION_FPS, ANIMATION_USES, animation-cli, golden animations.json, FLATCHAT_GOLDEN_WRITE, FLATCHAT_BLENDER, qangle, quat.ts
---

Every emote and dance becomes VRMA on VRM 1.0's normalized humanoid (S5.07, ad-009, rr-013). three-vrm-animation then plays it on any VRM avatar. Creators' guide: `docs/animations.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/animation.ts` | `AnimationManifest` (source format, use `emote` or `dance`, `loop`, duration, bones, the VRMA's hash), `checkAnimationManifest`, `checkAnimationFile` (the client's check: glTF 2.0, everything inside, only `VRMC_vrm_animation`, no meshes, skins, materials or images, one animation, a humanoid whose bones are nodes, the hips there), limits (`ANIMATION_SOURCE_LIMIT` 64 MB, `ANIMATION_MAX_SECONDS` 120, `ANIMATION_FPS` 30) |
| `tools/converter/src/animation/quat.ts` | Quaternions `[x, y, z, w]` and vectors; `qangle` is `2·atan2(|v|, |w|)` of the relative turn, normalized |
| `…/motion.ts` | `Motion` (joints parent-first with rest offset and rotation; per-joint local rotations and the root's translation per frame), `worldPose`, `restPose`, `framePose` |
| `…/bvh.ts` | `readBvh`: HIERARCHY (OFFSET, CHANNELS in their listed order, End Sites dropped), MOTION, resampled at 30 fps; BVH rests unrotated |
| `…/gltf-motion.ts` | `readGltfMotion(doc, hips)`: the longest animation, STEP, LINEAR (slerp) and CUBICSPLINE (Hermite) sampled at 30 fps. Normalized integer outputs are read back to floats. The hips become the root, with everything above them baked in (an armature's Z-up turn, a centimetre scale); offsets below are in world units |
| `…/retarget.ts` | `retarget(motion, map)` → `Humanoid`: stand up (the head-from-hips axis to +Y), face +Z (the left side at +X, else a half turn), straighten limbs that rest more than 4° off the T-pose (upper and lower arms, upper and lower legs; their subtrees turn with them), the floor at 0. Metres: kept when the hips stand 0.3 to 3 units high, else hips at 0.95 m. Each bone's normalized local rotation is `D_parent⁻¹ · D`, where `D = world(t) · T-pose⁻¹`; the hips stay within 0.5 m sideways. `loops` (2°, 3 cm) |
| `…/vrma-write.ts` | `writeVrma`: one unrotated node per bone at its T-pose offset, `VRMC_vrm_animation` humanoid, rotations as normalized SHORT (8 bytes a key), the hips' translation as FLOAT, a still bone (≤ 0.05°) as one key. Hand-written GLB (glTF-Transform would drop the extension); deterministic |
| `…/convert.ts` | `animationFormat` (FBX, BVH, VRMA or GLB by the first bytes), `mapJoints` (`humanBoneOf` on joint names, the spine's links by depth), `convertAnimation(bytes, {name, use, from, source})`: the glTF-Validator on GLB input, the required bones, retarget, write, `checkAnimationFile`, the validator on the output, the manifest |
| `…/samples.ts`, `scripts/animation-samples.ts` | The same motion as BVH (centimetres, facing +Z, T-pose) and as a GLB clip (Mixamo names, facing -Z, A-pose, under an armature scaled 0.01, with a skin so tools read a skeleton) |
| `src/animation-cli.ts` | The core's per-upload program, as avatar-cli: `UPLOAD OUTDIR [--use emote\|dance] [--from fbx --source SHA256:BYTES]` |
| `tools/blender/animation/fbx2glb.py`, `make-sample-fbx.py` | Headless Blender (GPL): an FBX into a GLB clip (`ignore_leaf_bones=False`: a skeleton's head and hands are often leaves; meshes dropped, the longest-animated armature kept, every frame sampled); the FBX fixture from the GLB sample (`bake_anim_simplify_factor=0`) |
| `test/animation.test.ts`, `test/golden/animations.json`, `test/fixtures/animation/` | Golden files per format (BVH, GLB clip, FBX via the committed `wave-fbx.glb`, VRMA byte for byte); the poses checked (the right arm `rotZ(-80°)` at 1 s, the nod `rotX(15°)` at 0.5 s, an A-pose rest shown as `rotZ(-45°)`, the hips at 0.95 m bobbing 2 cm); refusals; a Blender-gated run of `fbx2glb.py` (`FLATCHAT_BLENDER`, else this desktop's install) |

## The Rules

| Rule | Why |
|---|---|
| Measure each bone from the source's T-pose, not its rest | VRMA's rest is VRM's T-pose. A motion measured from an A-pose rest would play every arm about 45° too high |
| Straighten only the limbs (arms, legs), and only past 4° | Spines lean and feet point down by design; straightening them would bend every pose |
| Bake everything above the hips into the hips | Blender's FBX imports put an armature at 0.01 scale or Z-up above the skeleton; three-vrm-animation knows nothing above the hips |
| Translation from the hips only, kept within 0.5 m sideways | A creator's root motion would carry the avatar away from where the world places it |
| Write VRMA by hand; read it with `readGltf(bytes, 'animation.glb')` | glTF-Transform drops unknown extensions; `readGltf` reads binary only for a `.glb` name |
| Compare rotations with `qangle` (atan2), never `acos` of a dot | Normalized SHORT keys are off by about 1e-6 in length, which `acos` near 1 turns into 0.3° of apparent error |
| Golden files: `FLATCHAT_GOLDEN_WRITE=1 npx vitest run test/animation.test.ts` after a deliberate change | The converter is deterministic; any byte change is a change to explain |
| The FBX fixture's head is about 2° off (`tolerance` 2.5) | Blender's GLB→FBX→GLB round trip re-orients the leaf head bone's rest against its first frame. The converter is faithful to what it reads |

## Not Yet

The core takes uploads since part b (rule `core-service`: `src/animations.ts`, `runBlender`; `-Y` disables auto-run, `-y` would enable it). Protocol version 10 carries emotes since part c (rule `protocol-and-codecs`).

## In the Client (Part d)

| Part | Where |
|---|---|
| Playing | `AvatarLayer.play(entity, anim)` from each roster entry; `readyEmote` loads the VRMA once per hash (`parseAnimation` in avatar-loader.ts: `checkAnimationFile`, then `VRMAnimationLoaderPlugin`), makes `createVRMAnimationClip(animation, vrm)` on the current level and an `AnimationMixer` on `vrm.scene`; `place` sets `action.time` to the seconds since the start tick (`AvatarState.emoteTime`, a dance modulo its length, an emote once) and `mixer.update(0)` instead of the shared walk; a finished emote hands back to it. `clear` stops it before a level goes. Impostors keep walking |
| The world's clock | The session keeps the newest snapshot's tick and when it came; `emoteTimeOf` turns a roster emote's start tick into seconds at the welcome's `tickHz` |
| Your own | `playEmote(anim)` sends `emote` (two changes a second, the latest waits); any move, jump or walk to a spot sends a stop. `state.emote` (the manifest, '' for none) and `state.emoting` (`AvatarLayer.emoting`: the action runs this frame); `data-test=emote` carries `data-anim` and `data-playing` |
| The menus | `ui/EmoteMenu.vue` on B (`emotes` in `ACTIONS`): the account's ready animations, one click each, and Stop; `ui/AnimationsPanel.vue` on the home screen: Upload an emote / a dance (`flatchat:animations:upload` with the use; `FLATCHAT_E2E_ANIMATION` for the end-to-end test), the list, delete |
| The main process | `flatchat:animations`, `:animations:delete`, `flatchat:animation-file` (manifest checked with `checkAnimationManifest`, the VRMA from the content cache through the `vrma` link); `core-api.ts` `cleanAnimations`, `animations`, `animationSlot`, `deleteAnimation`, `animationFiles` |
| Tested | `apps/client/test/emote.test.ts` in Node: the converter's dance on the converted feminine body raises the arm to 77–83° at one second and lifts the hips 1 to 3 cm at half a second; the end-to-end test uploads the BVH sample as a dance, plays it from B (`emoted`) and walks it off (`emoteStopped`, shot `1c-dancing`) |

## Not Yet

Audio and Rhubarb mouth tracks (part e); emotes on impostors.
