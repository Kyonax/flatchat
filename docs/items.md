# Items: clothes, hair, hats and glasses

Items are made for the three standard bodies in [kits/bodies/](../kits/bodies/): Body A (feminine), Body B (masculine) and Body C (broad and compact). An item carries one fitted mesh per body it fits, made on that body's kit and refitted between the bodies while you make it, never by the platform at runtime (dp-001). It fills one fixed slot and names the regions of the body it hides, so no skin shows through it and no layer is drawn twice. Items made for one body only are fine; that body alone can wear them.

## Making one

1. Open the kits' `.blend` files. Each is a body with its rig, its face shapes and `mask_*` vertex groups, one per region.
2. Model the garment on one body, then fit it to the others. The bodies share one topology, so a garment shaped from the body's own surface carries over exactly. Skin each fit to its body's armature, with weights painted or copied from the body.
3. Mark each fitted mesh with a custom property `flatchat_fit` set to `feminine`, `masculine` or `neutral`.
4. Give the scene a custom property `flatchat_item` holding JSON, for example `{"name": "Linen shirt", "slot": "top", "hides": ["chest", "belly", "upper_arm_l", "upper_arm_r"], "authors": ["You"]}`.
5. Export a .glb with custom properties included and the armatures selected with their meshes, or upload the `.blend` itself: Blender on FlatChat's side keeps its custom properties (S5.08).

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

- **The file:** a .glb (or the GLB Blender or assimp made of the upload) that passes the Khronos glTF-Validator, with everything inside it.
- **The declaration:** a name, a slot and real regions, the file's own or else the one given at upload.
- **The fits:** each a skinned mesh on the kits' 53 bones, and within its slot's caps.
- **The body:** each fit made on its kit. Its skeleton must sit within 1 cm of the body's at the trunk and legs, so a fit made on another body is refused.
- **Each fit alone:** cleaned of everything but itself, with its textures fitted to the slot and encoded to KTX2, then checked with the client's own check.
- **No clipping in seven reference poses** (T-pose, arms down, both strides, sitting, arms up, reaching forward):
  - Each point of the skin the item leaves visible looks along its normal. Cloth within 10 cm outside it covers it (a loose sleeve, a skirt, a boxy jacket's side); cloth within 3 cm under it is skin out through the garment, by that depth. Only cloth facing the way the skin does counts, so a fold's inner layer, a collar's band or a lining, which face the body, never do.
  - At rest, the skin the item covers, or that already comes out through it, is the garment's, away from its openings. In each pose that skin must stay under it, within 3 mm.
  - Skin the body hides itself is not counted: inside a fold (the crotch in a deep seat, the chest's side under an arm held down), or where the body crosses itself.
  - An item with more than 10 such points out and over 5% of those near it, or any point out by 25 mm, is refused; fewer is a warning in its manifest.

The result is one file per fit and a manifest (`ItemManifest` in `packages/content/src/item.ts`), each named by its SHA-256.

## Items from other programs

An item may also be an FBX, an OBJ or a DAE (S5.08). These go into a GLB the way an avatar's do ([docs/avatars.md](avatars.md#other-formats)). None of them keeps custom properties, so:

- **The declaration is given at upload.** The client asks for the item's name, its slot and the regions it hides (or the point it is worn at) and who made it, before it sends the file. The core checks the declaration then and keeps it with the upload, and the converter uses it when the file declares nothing. A declaration inside the file always comes first.
- **Each fit is found by its mesh's name.** Name the skinned mesh after its body: `feminine`, `masculine` or `neutral` anywhere in the name, as in `shirt_feminine`.

The converter's own tests make the test tee's feminine fit into an FBX the way another program writes a garment. That is one body's skeleton, the mesh named for its body and no custom properties. It sits on the body exactly as the GLB tee does. For several bodies in one file, a GLB or a `.blend` is the sure way.

## Uploading and wearing

Upload an item from the client's home screen (Upload an item: a `.glb`, a `.blend`, an `.fbx`, an `.obj` or a `.dae`), the way you upload an avatar (trust level 1, a few days after signing up with a verified email): the core runs the converter on it with the three standard bodies at hand, and the item is ready, or refused with every reason the converter gave. The home screen lists your items with the bodies each one fits.

To wear clothes, wear a standard body: any account can take one of the three on the home screen (Wear the feminine, masculine or neutral body), with no upload. An avatar uploaded from a kit's own `.vrm` file, unchanged, counts as that body too. An edited copy is a new avatar, and the kit's items don't fit it. Attachments go on any avatar.

An outfit is a set of your items saved under a name, 16 at most: one item to a slot, one prop to an attachment point, and a `full` item with no top or bottom beside it. In a world, press O for the outfits menu: your saved outfits, your items to put on and take off (an item you put on takes the place of one it conflicts with), and Save what you wear. When you put an outfit on, everyone in the world sees the change, and the next world you join gets it too. Clothes show on the nearest players, as far as their avatars are drawn in full or lighter (LOD1, LOD2); farther away, as impostors, players show without them. You can wear an outfit on any avatar: its props show on all of them, and its clothes only on the bodies they fit.

## The starter wardrobe

Eight items made for the three standard bodies (Track P's P.08), in [kits/items/](../kits/items/): five full outfits (white tee and jeans, striped shirt and jeans, jacket and jeans, dark suit, overalls), brown shoes, black boots and a grey fedora. They are MakeHuman's own CC0 garments. MPFB fits each one on each body in headless Blender, the way MakeHuman fits clothes, from the same pinned tools as the body kits (`tools/blender/wardrobe/fit.py`). `tools/converter/src/item/wardrobe.ts` then makes each one an item:

- **Weights.** Each vertex takes the weights of the skin straight under it, so the cloth bends with the body at the knees, shoulders and hips.
- **Push.** Where skin still comes through in a test pose, the cloth is pushed out a little past it, 12 mm at most anywhere.
- **Simplified.** The denser ones are simplified under their slot's caps.
- **One texture.** Each keeps one base colour texture, 1024 pixels a side.
- **Hides.** Each hides the regions it covers on every body, wholly, or in MakeHuman's own record of what a garment covers.

The plan's "clipping fixed by hand" is done this way for every garment, so no minutes went into it by hand.

Any account takes them on the home screen, under Starter wardrobe (Take), with no upload and no trust level, as it takes a standard body. Each becomes one of the account's items, worn and put in outfits like any other. The core converts each once per start and reuses it for everyone (`POST /api/v1/items/starter`). A starter item is never taken for a copy, and it can't be published to the gallery: it's everyone's already.

Each item is checked on each body in the seven reference poses as made and at both ends of the proportion sliders, 21 poses in all; no skin comes through any of them (P.08's Verify). [kits/items/wardrobe.json](../kits/items/wardrobe.json) records what each one measured, and which of MakeHuman's garments were left out and why:

- **Logos:** MakeHuman's logo is on its tees, and CC0 does not waive trademark. It was painted out of the white one.
- **Brands:** two sneakers were photographed from branded shoes.
- **Clipping:** the skirt, the low-waisted leggings and one dense outfit still clipped when seated.

To make them again (the body kits' Blender, `node tools/blender/bodykit/run.mts --setup`, once):

```sh
node tools/converter/scripts/make-wardrobe.ts
```

## Copies and takedowns

Items are fingerprinted like avatars, one shape for each fit, so a copy of a single fit is caught too ([docs/avatars.md](avatars.md#copies-and-takedowns)). A takedown removes an item everywhere, from every outfit that held it included.

## The free gallery

Anyone can share an avatar or an item in FlatChat's free gallery, and anyone can take what is there: taking one adds your own copy to your avatars or items, worn and saved in outfits like your own. New players start from the standard bodies and the gallery, so nobody arrives with nothing to wear.

Publishing (Publish, beside one of your ready avatars or items) needs trust level 2 and your word that you made it or may share it, and that it keeps to the content rules (no sexual content or nudity). You state its licence, VRM 1.0's terms, every one of them:

| Field | What it says |
|---|---|
| Who may wear it | Everyone: the gallery holds only what everyone may wear |
| Credit | Whether the makers must be named where it shows |
| Copies by others | Whether others may upload a copy of it as theirs |
| Changes | Not allowed; allowed but not to share; allowed and to share |
| Commercial use | Personal and non-profit; personal with profit; anyone, companies too |
| Also allowed | Very violent scenes, sexual scenes, political or religious use, antisocial or hateful use (each no unless you allow it) |
| Licence | A link to the licence's text (VRM's by default), and another if you like |

An avatar's file states its own terms (VRoid Studio and the VRM add-ons write them): you can make them stricter, never looser. The gallery shows each entry with its makers and its licence. Take an entry out of the gallery whenever you like (deleting it does too): copies already taken stay with whoever took them. An exact copy of someone else's entry cannot be uploaded unless its licence allows copies; changed copies are caught later (fingerprints).

## Stage 5's acceptance

`node tools/bots/src/accept-stage5.ts` runs on every push (CI's Harness job). It uses the real core with PostgreSQL and the sandboxed converters with KTX2 on, a world server connected to the core, and bots holding the tokens the core issued. It checks four things:

1. **A jacket made with the kit.** A creator makes one the way the test tee is made (`makeGarment(TEST_JACKET)` in `tools/converter/src/item/samples.ts`): each body's own surface over the chest, belly and both arms, 14 mm out. The upload converts with a fit for each body and nothing out through it in the seven reference poses. It is published to the gallery, and three players on the three standard bodies take it and wear it. Everyone sees each of them in it.
2. **An outfit toggled.** One player takes the jacket off and puts it back on, and everyone sees each change. The quick menu sends this same message; its own buttons are the end-to-end test in CI's Linux client job.
3. **A takedown.** A rights holder asks on the takedown form and the admin removes the jacket. It leaves the gallery, the three copies, the outfits everyone in the world sees and the delivery, and the claimant reads the decision by their reference.
4. **A copy caught.** One fit, ripped and written as a DAE, is uploaded with its declaration. It is refused as a copy of an item taken down, and its uploader gets a strike on the admin page.

