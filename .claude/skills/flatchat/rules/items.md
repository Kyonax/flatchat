---
title: Items — Clothes for the Three Bodies, Slots, Hide-Mask Regions, the Item Converter and the No-Clipping Check
impact: HIGH
impactDescription: A region cut where no garment ends leaves a hole or skin through cloth; a fit made on another body floats or sinks; a clipping check that reads the wrong bind pose or counts a thigh below a hem refuses good items, and one that skips covered skin passes bad ones; a fit with a foreign bone or extension is refused by the client after the core called it ready.
tags: items, clothes, garments, S5.02, S5.01, dp-001, dp-002, cl-004, item format, flatchat_item, flatchat_fit, BODY_KITS, BodyKit, KIT_BONES, REGIONS, regionOfBone, chest, belly, hips, SLOTS, SLOT_REPLACES, caps, ItemDeclaration, readItemDeclaration, ItemFormatError, ItemManifest, checkItemManifest, checkItemFit, ITEM_EXTENSIONS, convertItem, ItemError, ITEM_CONVERTER_VERSION, clipping, clippingOf, REFERENCE_POSES, poseMatrices, Turn, kitBody, skeletonOffset, bind pose, edge zone, test tee, make-test-item, kits/items, skin layers, S5.03, compositeSkin, LAYER_KINDS, LayerError, SkinLayer, RgbaImage, tattoo, makeup, underwear layer, ORM, multiply, attachment points, S5.04, ATTACH_POINTS, AttachPoint, attachBone, attachMatrix, fitAdjustment, ADJUST_LIMITS, attachment slot, prop, convertProp, checkItemProp, attach_ markers
---

Items are made for the three standard bodies (rule `body-kits`). Each carries one fitted mesh per body it fits, refitted between the bodies while it is made (shared topology), never at runtime (dp-001; Roblox's cage-fitting patents, cl-004). It fills one fixed slot and hides whole regions of the body (dp-002). Creators' guide: `docs/items.md`.

## The Files

| File | Job |
|---|---|
| `packages/content/src/item.ts` | `BODY_KITS`, `KIT_BONES` (the 53 game_engine bones), `REGIONS` (16, by the bones that move them most: `head`, `chest`, `belly`, `hips`, the arms, hands, legs and feet by side), `regionOfBone`, `SLOTS` with per-fit caps (triangles, materials, texture side), `SLOT_REPLACES` (`full` takes `top` and `bottom`), `readItemDeclaration` (every reason at once, `ItemFormatError`), `ItemManifest`, `checkItemManifest`, `ITEM_EXTENSIONS`, `checkItemFit` (the client's check of a fit's JSON) |
| `tools/converter/src/item/convert.ts` | `convertItem(bytes, {ktx2, kits})`: size, `readGltf`, Khronos glTF-Validator, data inside, the declaration (`extras.flatchat_item` on the scene or the file; a Blender custom property arrives as a JSON string), the fits (`extras.flatchat_fit` on a skinned mesh node, joints in `KIT_BONES`), the slot's caps; then each fit alone (other meshes, animations and cameras dropped, extensions outside `ITEM_EXTENSIONS` left out with a warning, pruned), textures fitted to the slot (and KTX2), `checkItemFit` on the file made, then the skeleton and clipping checks; one file per fit and a manifest, each by SHA-256 |
| `tools/converter/src/item/clipping.ts` | `kitBody` (a kit VRM's body primitive, joints, inverse binds, humanoid, each vertex's region), `fitOnKit` (a fit's joints mapped onto the kit's by name), `REFERENCE_POSES` (7: T-pose, arms down, two strides, sitting, arms up, reaching forward, as `Turn`s about world axes), `clippingOf`, `skeletonOffset` |
| `tools/converter/scripts/make-test-item.ts` | The test tee in `kits/items/test-tee/`: each kit's own chest, belly and upper arms, 8 mm out along its normals, its weights, its skeleton; the three merged (`mergeDocuments`, scenes folded into one, `prune`, `unpartition`) and declared as a creator would |
| `tools/converter/test/item.test.ts`, `packages/content/test/item.test.ts` | The tee converts with nothing out through it; a garment made inside the body, swapped fits, a broken cap, a foreign bone and a bad declaration are each refused |

## The Rules

| Rule | Why |
|---|---|
| Regions are cut where garments end: the torso is `chest`, `belly` and `hips`, never one region | Hiding is by whole region: a tee hiding a torso that included the pelvis left a hole at the hips, and one not hiding it let a seated thigh come through its front |
| A fit's skeleton is compared with the kit's in the bind pose (`invert(inverseBind)` on both), at the trunk and legs only (`SHAPE_JOINTS`) | The kits' VRMs rest in a T-pose with legs straightened by the VRM add-on, but are bound as the `.blend` stands, as a creator's fit is; arms differ between A-pose and T-pose. A fit made on another body is off by 5 to 10 cm, the tee by 0 |
| The clipping check follows only skin that was under the garment at rest: at rest, visible skin within reach of the garment (away from its openings, `EDGE_ZONE` 3 cm) must be under it; in each pose, that skin must stay within `CLIP_TOLERANCE` (3 mm) | Comparing every nearby visible point flagged a thigh in front of a tee's hem when seated (another part of the body, not clipping); skipping rest let a garment made inside the body pass |
| Refuse at more than 10 points out and over 5% of those near, or any point 25 mm out; fewer is a warning | A share alone refused the good tee on 2 of 2 points; a garment that hides everything it covers honestly checks 0 points |
| Pose with `poseMatrices` (stride.ts) and put the rest world back for skinning: world = (posed × rest⁻¹) × rest, then × inverse bind | The impostor's stride code gives skinning matrices for world-space rest positions; a fit's vertices are in its bind space |
| Change the item format or the checks: bump `ITEM_CONVERTER_VERSION`; regions or bones: `packages/content` first, then `generate.py`'s `REGIONS` and `run.mts`, then `make-test-item.ts` | Every program reads the same rules; the kits' `mask_*` groups and the tee must match them |

## Skin Layers (S5.03)

`packages/content/src/layers.ts`: `compositeSkin(layers, {requireUnderwear})` composites RGBA images in the kits' UV space, the order fixed by `LAYER_KINDS` (skin, tattoo, makeup, underwear on top). Blending is `normal` or `multiply` at an opacity, in integer arithmetic, so the bytes are the same on every machine; an optional ORM image per layer is composited beside the colour (the PBR awareness dp-002 asks for; normal maps are not merged yet). It throws `LayerError` for a stack with no skin, with no underwear (OQ-11, unless `requireUnderwear: false`), or with a size that differs from the skin's. The kits write their layers apart (`generate.py` `underwear()`: `<name>-skin.png`, `<name>-underwear.png`). `tools/converter/test/layers.test.ts` composites them and compares the result with each kit VRM's own texture: zero pixels differ.

## Attachment Points (S5.04)

`packages/content/src/attach.ts`:

- **`ATTACH_POINTS`** has twelve points, each a VRM humanoid bone plus an offset given as a share of the height, in the rest frame (+Z forward). The kits' `attach_*` markers are these points for a 1.7 m body.
- **`attachBone`** falls back up the chain for VRM's optional bones (upperChest to chest to spine, neck to head).
- **`attachMatrix(point, boneRest, boneNow, height, adjust)`** = boneNow × boneRest⁻¹ × (the place at rest, plus the adjustment), so a prop follows its bone.
- **`fitAdjustment`** clamps a player's offset (10 cm), turn (45° per axis) and size (0.8 to 1.25); whatever comes from the network is clamped.

An attachment item is `slot: attachment` with `attach`: one rigid mesh, no skin, worn on any avatar (`convertProp` in item/convert.ts, `checkItemProp`, `manifest.prop`). `tools/converter/test/attach.test.ts` checks that the computed points land within 5 cm of every kit marker, that every point finds a bone and lands on the free-shape robot and the VRM reference avatar, and that a prop converts while a skinned one or one with no point is refused.

## Not Yet

Wearing items and layers in the world (the client attaching a fit to a kit body by bone names, hiding regions, compositing the skin at outfit change, outfits) is S5.05; uploads, the gallery and licence fields are S5.06.
