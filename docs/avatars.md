# Avatars

FlatChat takes avatars as **VRM 1.0**, **VRM 0.x** or a **plain GLB** with a humanoid skeleton, and as **FBX**, **OBJ**, **DAE** or **.blend** (S5.08). Every avatar is converted on FlatChat's side before anyone sees it: the client only ever draws the converter's own output, never the file you uploaded (Stage 4, S4.02).

## What to upload

| Source | Works as |
|---|---|
| VRoid Studio, UniVRM, Blender's VRM add-on (VRM 0.x or 1.0) | Everything the file has: the humanoid, expressions, look-at, first person, spring bones and colliders, MToon materials |
| A GLB from Mixamo, Ready Player Me, Blender or Unity | The skeleton found by its bones' names (Mixamo's `mixamorig:Hips`, `Spine`, `Spine1`…; Unity's and Unreal's usual names; Blender's `thigh.L`), the mouth and blink shapes by their names (`viseme_aa`, `eyeBlinkLeft`, `aa`, `blink`) |
| An FBX (Mixamo, Unity, Maya, 3ds Max), an OBJ or a `.blend` | Read by headless Blender on FlatChat's side into a GLB, then as a GLB: the skeleton and the shape keys by their names. An OBJ has no skeleton, so it is a free shape |
| A DAE (Collada, as Second Life's tools write it) | Read by assimp inside the converter into a GLB, then as a GLB. Its shape keys stay behind, and so do the images it names by path |

**Free shapes** (S4.11): a robot, a creature or a prop works too. A model whose skeleton lacks VRM's required bones, or has no skeleton at all, gets a hips node holding the whole model and the missing bones as empty nodes: it walks, turns and bobs as one, and the bones it has move with everyone's motions. Free shapes wear attachments and effects, not the body kits' clothes (Stage 5).

The file must carry everything inside it (a `.vrm`, a `.glb`, an `.fbx` with its textures embedded, a `.blend` with its images packed; not a `.gltf` with separate files), weigh at most 64 MB, and stay within the hard limits: 1,000,000 triangles, 2,000,000 vertices, 4,096 nodes, 256 meshes, 64 materials, 64 textures of at most 8,192 px, 32 skins of at most 1,024 joints, 512 morph targets on a mesh. The humanoid needs VRM's required bones: hips, spine, head, both upper and lower arms and hands, both upper and lower legs and feet.

Refused, with the reason: a file Khronos's glTF-Validator (and, for a VRM, vrm-validator) finds errors in, a file that requires an extension FlatChat cannot show (Draco, for one), a VRM of another version than 0.x or 1.0, and a GLB whose skeleton has no names a rig would use. Repaired, with a note: normals a little off unit length, a joint named twice for one vertex, weights that do not add up to one, and a skin's `skeleton` hint that is not the joints' common root. These four were the only errors on 68 real avatars from VRoid Studio and Blender's exporter.

## Other formats

FlatChat knows a file by its first bytes, never by its name. VRM and GLB go to the converter as they are. An FBX, an OBJ or a `.blend` is first turned into a GLB by headless Blender 5.2 LTS on FlatChat's side (`tools/blender/convert/to-glb.py`, DR-15). Blender runs as a process of its own, in a sandbox like the converter's: no network, a 6 GB memory cap, five minutes, factory settings, and scripts inside the file never run. It keeps what the scene shows:

- meshes with their skins and shape keys, the armature's bones;
- materials and packed images;
- custom properties.

Every modifier but the armature is applied. Hidden objects and a rig's bone widgets are left out, and so are animations. A DAE is turned into a GLB inside the converter itself, by assimp compiled to WebAssembly (assimpjs): Blender 5 no longer reads Collada. Either way, the manifest names the upload itself (`source.from`, with the upload's SHA-256 and size), and the avatar is converted from there like any GLB. A server without Blender refuses FBX, OBJ and `.blend` with that reason. Run `node apps/core/scripts/tools.ts` to fetch the pinned Blender.

## Copies and takedowns

Every upload is fingerprinted as it arrives (S5.09). The shape is measured by its triangles: each triangle's edges and its distance from the model's centre, against the model's size. A copy written again, in another program, moved, turned, mirrored or scaled, measures the same. Each texture also gets a perceptual hash, which survives a re-encoding or a resize. A copy of an avatar or item taken down from FlatChat is refused, and counts against the account that uploaded it. A copy of someone else's gallery entry is refused unless its licence allows copies. What the standard bodies explain does not count: an avatar made from a kit is no one's copy. A model of a few dozen triangles is too simple to tell from another, so its shape is not compared.

If an avatar or item here copies your work, ask for a takedown at the core's `/takedown` page. You get a reference, and read the decision with it at `/takedown/status`. A takedown removes it everywhere: from the gallery, from every account that took a copy, from outfits, and from whoever wears it, in the worlds they are in right now too.

## What the converter makes

- **The full avatar** (LOD0) in VRM 1.0, facing +Z: a VRM 0.x is migrated by three-vrm's rules and turned round; textures fitted to 2,048 px and 64 MB, encoded to KTX2.
- **LOD1**: half the triangles; every vertex an expression moves is kept, so the face stays whole.
- **LOD2**: a fifth of the triangles, with only the mouth (aa, ih, ou, ee, oh) and blink shapes.
- **The impostor**: one mesh of about 1,500 triangles on 20 bones (no fingers, eyes or jaw), one 512 px texture and a plain material (no MToon). Far avatars and big crowds draw this. Its simplification never joins what a walk pulls apart, such as the two legs, or a skirt and the thighs under it; `node tools/converter/scripts/impostor-audit.ts CONVERTED` checks a folder of converted avatars for triangles a stride stretches.
- A thumbnail from the VRM's own, and a **manifest**: the numbers, the rank, the levels, the bones and expressions, the height and the licence terms exactly as the file stated them.

Animations, cameras and lights in the file are dropped.

## Ranks

An avatar takes the worst rank of any of its numbers (the manifest names which). The table starts from VRChat's PC limits and is to be tuned on the reference laptop:

| | Excellent | Good | Medium | Poor | Very Poor |
|---|---|---|---|---|---|
| Triangles | 32,000 | 70,000 | 70,000 | 70,000 | more |
| Texture memory | 40 MB | 75 MB | 110 MB | 150 MB | more |
| Skinned meshes | 1 | 2 | 8 | 16 | more |
| Other meshes | 4 | 8 | 16 | 24 | more |
| Material slots | 4 | 8 | 16 | 32 | more |
| Bones | 75 | 150 | 256 | 400 | more |
| Spring chains | 4 | 8 | 16 | 32 | more |
| Spring joints | 16 | 64 | 128 | 256 | more |
| Colliders | 4 | 8 | 16 | 32 | more |
| Collision checks | 32 | 128 | 256 | 512 | more |

Every viewer chooses the lowest rank they draw in full; the rest show at a lighter level (S4.09).

## In the world

Everyone sees the avatar you wear: the world learns it from your connect token (the core vouches you own it), and each client fetches it from FlatChat by its hash and keeps it in its cache. The nearest few are drawn in full, the next ones lighter (LOD1, LOD2), everyone else as their impostor; an avatar below your minimum rank is never drawn in full. Everyone moves with the platform's default clips (Track P's P.05; [docs/animations.md](animations.md#the-default-clips)), retargeted onto each body: idle, walk, jog and sprint at a pace that keeps the feet planted for that avatar's legs, a jump and a fall, sitting down and getting up, each change blended. A body turns on the spot without stepping. Your voice moves your mouth; keys 1 to 5 make your face happy, angry, sad, relaxed or surprised (press again for neutral) and R changes your hands' pose. Spring bones (hair, clothes) move on the nearest six. Your height (0.3 to 5 m, fitted into each world's range) scales your avatar; four sliders change its proportions, 80 to 125 % each: shoulders and hips, arms, legs (longer legs stand taller), head. They move the avatar's joints and stretch its arms and legs along their bones, so everyone sees the same shape and a sleeve keeps to the arm under it. On the home screen you can also wear one of the three standard bodies with no upload, the ones clothes are made for (`docs/items.md`); press O in a world for your outfits. You can share an avatar in the free gallery under its licence, never looser than the terms its file states (`docs/items.md`, The free gallery).

## Your screen, your choice

What renders on your screen is yours to decide (Settings, "Other people's avatars"; the People panel). On your first visit to a world FlatChat measures this computer for a few seconds and sets how many avatars it draws in full and the worst rank it draws in full (light: 4 and Good; medium: 8 and Medium; strong: 12 and Poor); you can change both, and measure again. Hide any person's avatar from the People panel: they show as their impostor. Shield yourself from strangers: below the trust level you choose, a person who is not your friend shows as their impostor. While the frame rate drops under 30, fewer avatars are drawn in full until it recovers (turn it off if you prefer).

## Converting on your own PC

```sh
node --permission --allow-fs-read=. --allow-fs-read=MY.vrm --allow-fs-write=OUT \
  --import ./tools/converter/src/sandbox.ts tools/converter/src/avatar-cli.ts MY.vrm OUT
```

`OUT/result.json` says whether it converted and why not; `OUT/manifest.json` holds the rank and the levels. The core runs exactly this on each upload (S4.01).

## Measuring a crowd of avatars

The avatar bench converts a folder of real avatars once. The packaged client then draws them with the world's own avatar layer at 1280×720 with no frame-rate cap: 200 present, 55 of them in view and the rest around the camera but out of its view. It is the worst case the viewer's policy allows. Within the 8 m drawn in full stand the policy's full quota, the heaviest avatars it draws in full. Within 9 to 13 m stand its lower quota, the heaviest of all, since LOD1 has no rank gate. The rest of those in view stand farther off as impostors.

```sh
npm run dist:linux -w @flatchat/client
node tools/bots/src/avatar-bench.ts --from MY_AVATARS --out CONVERTED \
  --client apps/client/release/linux-unpacked/flatchat --seconds 60 --present 200 --in-view 55 [--tier low|medium|high]
```

`--tier` uses that tier's policy as it ships (low: 4 in full, 12 lower, springs on 2, nothing below Good in full; medium: 8, 20, 6, Medium; high: 12, 28, 8, Poor). Without it, the policy is 12 in full, 20 lower and springs on 6, with every rank allowed in full, which is harsher than any tier. The pass lines: frame time p95 at most 33.3 ms (30 fps), the worst frame after the warm-up at most 100 ms, the policy's full quota drawn in full, and every FlatChat process together within 2 GB.

On the reference laptop's stand-in (its sudo steps are the owner's, OQ-23), the same run is:

```sh
npm run standin -- run --target iris-xe --seconds 60 --crowd CONVERTED --converted --present 200 --in-view 55 --tier medium
```

The stand-in's headroom (1.5, OQ-24) tightens the frame lines to 22.2 ms and 66.7 ms.

To look at proportions, run the client with `--crowd-proportions=1`. Everyone then stands at the ends of the sliders (80 and 125 % width, arms, legs and head, in every combination). Take a picture with `--crowd-shot=FILE.png`.

Measured on the development desktop on 2026-10-17 (WebGPU, NVIDIA). The set was 68 real avatars from VRoid Studio and Blender exports, converted with KTX2 by converter 1.2.0: 60 ranked Excellent, 2 Poor and 6 Very Poor; 5.5 s each at the median, 118 s the slowest. Each run measured 60 s:

| Policy | In full / LOD1 / impostors | p95 | Worst frame | Draw calls | Triangles | Memory |
|---|---|---|---|---|---|---|
| Low tier | 4 / 12 / 184 | 13.4 ms | 55.4 ms | 111 | 201,338 | 1,161 MB |
| Medium tier | 8 / 20 / 172 | 15.8 ms | 52.0 ms | 119 | 245,672 | 1,225 MB |
| High tier | 12 / 27 / 161 | 17.7 ms | 26.0 ms | 163 | 288,124 | 1,350 MB |
| Every rank in full | 12 / 20 / 168 | 25.5 ms | 33.6 ms | 669 | 444,166 | 1,589 MB |

The main thread's render call takes most of each frame: about 30 to 70 µs per skinned avatar drawn (three.js's WebGPU renderer, whatever the material). Spring bones are cheaper: in the every-rank run (whose six VRoid avatars have 51 to 111 spring joints each), springs on 0, 6 and 12 of the nearest took the layer's update from 2.8 to 3.6 and 5.0 ms, and p95 from 24.3 to 24.6 and 26.5 ms. The reference laptop's numbers are still to come.

## Stage 4's acceptance

`node tools/bots/src/accept-stage4.ts` runs on every push (CI's Harness job). It uses the real core with PostgreSQL, the sandboxed converter with KTX2 on, a world server and bots holding the tokens the core issued. Avatars are written as VRoid Studio 1.x (VRM 1.0), UniVRM and Blender (VRM 0.x) and a Mixamo-named GLB would write them, plus a free shape. Each is uploaded by its own account, converted, ranked and worn. Every player's roster names every worn avatar, and every level reaches another player intact through signed links. The client drawing a worn avatar, its KTX2 textures included, is the end-to-end test in CI's Linux client job.
