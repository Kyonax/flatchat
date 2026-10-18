# Items: clothes, hair, hats and glasses

Items are made for the three standard bodies in [kits/bodies/](../kits/bodies/): Body A (feminine), Body B (masculine) and Body C (broad and compact). An item carries one fitted mesh per body it fits, made on that body's kit and refitted between the bodies while you make it, never by the platform at runtime (dp-001). It fills one fixed slot and names the regions of the body it hides, so no skin shows through it and no layer is drawn twice. Items made for one body only are fine; that body alone can wear them.

## Making one

1. Open the kits' `.blend` files. Each is a body with its rig, its face shapes and `mask_*` vertex groups, one per region.
2. Model the garment on one body, then fit it to the others. The bodies share one topology, so a garment shaped from the body's own surface carries over exactly. Skin each fit to its body's armature, with weights painted or copied from the body.
3. Mark each fitted mesh with a custom property `flatchat_fit` set to `feminine`, `masculine` or `neutral`.
4. Give the scene a custom property `flatchat_item` holding JSON, for example `{"name": "Linen shirt", "slot": "top", "hides": ["chest", "belly", "upper_arm_l", "upper_arm_r"], "authors": ["You"]}`.
5. Export a .glb with custom properties included and the armatures selected with their meshes.

`node tools/converter/scripts/make-test-item.ts` writes the test tee ([kits/items/test-tee/](../kits/items/test-tee/)) exactly so. It is a tee cut from each kit's own chest, belly and upper arms, 8 mm out from the skin, and it is the garment the converter's tests check.

## Slots and what each may weigh

Each fit counts on its own.

| Slot | Triangles | Materials | Texture side |
|---|---|---|---|
| hair | 12,000 | 2 | 1,024 px |
| hat | 3,000 | 1 | 1,024 px |
| glasses | 1,500 | 1 | 512 px |
| top | 8,000 | 2 | 1,024 px |
| outer | 10,000 | 2 | 1,024 px |
| bottom | 6,000 | 2 | 1,024 px |
| full | 14,000 | 2 | 1,024 px |
| gloves | 3,000 | 1 | 512 px |
| legwear | 3,000 | 1 | 1,024 px |
| shoes | 4,000 | 1 | 1,024 px |

A `full` item (a dress, a jumpsuit) takes the top and the bottom slots.

## Regions

The regions are `head`, `chest`, `belly`, `hips`, `upper_arm_l`, `upper_arm_r`, `lower_arm_l`, `lower_arm_r`, `hand_l`, `hand_r`, `upper_leg_l`, `upper_leg_r`, `lower_leg_l`, `lower_leg_r`, `foot_l` and `foot_r`.

Each region is the part of the body its bones move most. A region is hidden whole, so hide only what the item covers completely, or a hole shows. The regions are cut where garments end: a tee ends at the waist (chest and belly), and trousers start at the hips.

## Attachments

An attachment is a prop worn at a point: a hat on the head's top, glasses on the face, a sword at a hip, a backpack on the back. It is one rigid mesh with no skin. Model it with its origin where it meets the body, facing +Z with +Y up. Unlike clothes, it is worn on any avatar, free shapes included. Declare it with `"slot": "attachment"` and `"attach"` set to one of these points:

| Point | Follows |
|---|---|
| `head_top`, `face` | the head |
| `neck` | the neck (or the head) |
| `chest`, `back` | the upper chest (or the chest, or the spine) |
| `hips`, `hip_l`, `hip_r` | the hips and the thighs |
| `hand_l`, `hand_r` | the hands |
| `foot_l`, `foot_r` | the feet |

A standard body carries each point as a marker (its `attach_*` nodes). On any other avatar a point is its bone's place plus an offset scaled by the avatar's height, and it moves with the bone. A player may move a prop up to 10 cm from its point, turn it up to 45° on each axis and size it from 0.8 to 1.25 (`packages/content/src/attach.ts`). An attachment may have up to 3,000 triangles, one material and a 512 px texture.

## Skin layers

Tattoos and makeup are not meshes. They are layers: RGBA images in the kits' UV space, 1,024 px like `kits/bodies/<name>/<name>-skin.png`, transparent where they leave the skin alone. Whenever an outfit changes, the platform composites a body's layers into one texture, the same bytes on every machine (`compositeSkin` in `packages/content/src/layers.ts`). They stack as skin, then tattoos, then makeup, then underwear on top, which covers what lies under it. Each layer can blend normally or multiply (ink), at an opacity. It can also bring a roughness and metalness image (glTF's ORM), composited beside the colour, so a shiny or metallic layer stays so. A standard body is never shown without its underwear layer.

## What the converter checks

- **The file:** a .glb that passes the Khronos glTF-Validator, with everything inside it.
- **The declaration:** a name, a slot and real regions.
- **The fits:** each a skinned mesh on the kits' 53 bones, and within its slot's caps.
- **The body:** each fit made on its kit. Its skeleton must sit within 1 cm of the body's at the trunk and legs, so a fit made on another body is refused.
- **Each fit alone:** cleaned of everything but itself, with its textures fitted to the slot and encoded to KTX2, then checked with the client's own check.
- **No clipping in seven reference poses** (T-pose, arms down, both strides, sitting, arms up, reaching forward):
  - At rest, any skin the item leaves visible within 2.5 cm of the garment must lie under it, away from its openings.
  - In each pose, that skin must stay under it, within 3 mm.
  - An item with more than 10 such points out and over 5% of those near it, or any point out by 25 mm, is refused; fewer is a warning in its manifest.

The result is one file per fit and a manifest (`ItemManifest` in `packages/content/src/item.ts`), each named by its SHA-256.

## Uploading and wearing

Upload an item the way you upload an avatar (trust level 1, a few days after signing up with a verified email): the core runs the converter on it with the three standard bodies at hand, and the item is ready, or refused with every reason the converter gave. The core lists your items with the bodies each one fits.

To wear clothes, wear a standard body: any account can take one of the three, with no upload. An avatar uploaded from a kit's own `.vrm` file, unchanged, counts as that body too. An edited copy is a new avatar, and the kit's items don't fit it. Attachments go on any avatar.

An outfit is a set of your items saved under a name, 16 at most: one item to a slot, one prop to an attachment point, and a `full` item with no top or bottom beside it. When you put an outfit on, everyone in the world sees the change. You can wear an outfit on any avatar: its props show on all of them, and its clothes only on the bodies they fit.
