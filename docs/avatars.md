# Avatars

FlatChat takes avatars as **VRM 1.0**, **VRM 0.x** or a **plain GLB** with a humanoid skeleton. Every avatar is converted on FlatChat's side before anyone sees it: the client only ever draws the converter's own output, never the file you uploaded (Stage 4, S4.02).

## What to upload

| Source | Works as |
|---|---|
| VRoid Studio, UniVRM, Blender's VRM add-on (VRM 0.x or 1.0) | Everything the file has: the humanoid, expressions, look-at, first person, spring bones and colliders, MToon materials |
| A GLB from Mixamo, Ready Player Me, Blender or Unity | The skeleton found by its bones' names (Mixamo's `mixamorig:Hips`, `Spine`, `Spine1`…; Unity's and Unreal's usual names; Blender's `thigh.L`), the mouth and blink shapes by their names (`viseme_aa`, `eyeBlinkLeft`, `aa`, `blink`) |

The file must carry everything inside it (a `.vrm` or a `.glb`, not a `.gltf` with separate files), weigh at most 64 MB, and stay within the hard limits: 1,000,000 triangles, 2,000,000 vertices, 4,096 nodes, 256 meshes, 64 materials, 64 textures of at most 8,192 px, 32 skins of at most 1,024 joints, 512 morph targets on a mesh. The humanoid needs VRM's required bones: hips, spine, head, both upper and lower arms and hands, both upper and lower legs and feet.

Refused, with the reason: a file Khronos's glTF-Validator (and, for a VRM, vrm-validator) finds errors in, a file that requires an extension FlatChat cannot show (Draco, for one), a VRM of another version than 0.x or 1.0, and a GLB whose skeleton has no names a rig would use. Repaired, with a note: normals a little off unit length, a joint named twice for one vertex, weights that do not add up to one, and a skin's `skeleton` hint that is not the joints' common root. These four were the only errors on 68 real avatars from VRoid Studio and Blender's exporter.

## What the converter makes

- **The full avatar** (LOD0) in VRM 1.0, facing +Z: a VRM 0.x is migrated by three-vrm's rules and turned round; textures fitted to 2,048 px and 64 MB, encoded to KTX2.
- **LOD1**: half the triangles; every vertex an expression moves is kept, so the face stays whole.
- **LOD2**: a fifth of the triangles, with only the mouth (aa, ih, ou, ee, oh) and blink shapes.
- **The impostor**: one mesh of 1,000 to 2,000 triangles on 20 bones (no fingers, eyes or jaw), one 512 px texture, unlit. Far avatars and big crowds draw this.
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

## Converting on your own PC

```sh
node --permission --allow-fs-read=. --allow-fs-read=MY.vrm --allow-fs-write=OUT \
  --import ./tools/converter/src/sandbox.ts tools/converter/src/avatar-cli.ts MY.vrm OUT
```

`OUT/result.json` says whether it converted and why not; `OUT/manifest.json` holds the rank and the levels. The core runs exactly this on each upload (S4.01).
