# Kits

The three body kits and the sources of the base library: free to use anywhere, with credit.

- Licence: CC BY 4.0 ([LICENSE](LICENSE)); third-party parts keep theirs, listed in [CREDITS.md](../CREDITS.md)
- Status: the three standard bodies are in [bodies/](bodies/) (Track P's P.03), the test tee, fitted on all three, in [items/test-tee/](items/test-tee/) (S5.01, S5.02; how items are made: [docs/items.md](../docs/items.md)), the starter wardrobe in [items/](items/) (Track P's P.08), and the default clips in [animations/](animations/) (Track P's P.05). The base library's sources come later.

## The three bodies

Three adult bodies, one topology between them, so a garment made on one is refitted to the others at authoring time (dp-001): Body A, feminine; Body B, masculine; Body C, broad and compact. Each folder holds the following files:

- `<name>.vrm`: the body as a VRM 1.0 avatar, which the platform converts like any upload. It is in T-pose, with the game_engine rig (53 bones: the VRM 1.0 humanoid with fingers), 27,488 triangles, MToon materials, an underwear layer in the skin texture (OQ-11), 36 face shapes and the 18 VRM expressions, plus twelve `attach_*` markers on the bones. Its VRM licence fields say: everyone may use it, commercially too, and modify and redistribute it, with credit (CC BY 4.0 in `otherLicenseUrl`).
- `<name>.blend`: the same body for creators, its parts apart and its images packed. It rests in MakeHuman's A-pose; the VRM add-on exports the T-pose. Its `mask_*` vertex groups are the hide-mask regions an item names, and the face shapes sit on every part that follows the face.
- `<name>-thumbnail.png` (the VRM's own picture) and `<name>-emotions.png` (happy, angry, sad, relaxed and surprised on its face).
- `<name>-skin.png` and `<name>-underwear.png`: the skin's layers apart, in the kits' UV space. A tattoo or makeup is another such layer, and the platform composites them whenever an outfit changes (S5.03). Composited, these two give exactly the texture the VRM carries.

[bodies/kits.json](bodies/kits.json) records each body's parts, measurements, regions, markers and expressions, the converter's verdict on it, and the tools that made it, each pinned by its SHA-256. To make them again:

```sh
node tools/blender/bodykit/run.mts --setup   # Blender 5.2.2 LTS, MPFB 2.0.18, the VRM Add-on 4.10.2, MakeHuman's CC0 packs
node tools/blender/bodykit/run.mts           # two runs that must agree, then the checks, then kits/bodies/
```

The presets and the expression recipes are JSON in `tools/blender/bodykit/`. The bodies are made from MakeHuman's CC0 assets ([provenance/body-kits.json](provenance/body-kits.json)), so they can be released as CC BY 4.0.
## The default clips

[animations/](animations/) holds the body's everyday motions as VRMA, which the client plays on every avatar:

- standing: idle;
- moving: walk, jog, sprint;
- in the air: jump-start, jump-air, land, fall;
- sitting: sit-enter, sit-idle, sit-exit;
- gestures: greeting, dance.

They come from two CC0 libraries, Mesh2Motion's human clips (Scott Petrovic and the Mesh2Motion contributors) and Quaternius's Universal Animation Library (its free standard pack), retargeted by the animation converter. [animations/clips.json](animations/clips.json) lists each clip's source and what it measured on the three bodies: its loop's seam, a walking clip's foot sliding and ground speed, and how far idle's hands stay from the torso. Neither library has an in-place turn. To make them again (it downloads the libraries once, each pinned by its SHA-256):

```sh
node tools/converter/scripts/default-animations.ts
```

## The starter wardrobe

[items/](items/) holds eight items fitted on the three bodies: five full outfits (white tee and jeans, striped shirt and jeans, jacket and jeans, dark suit, overalls), brown shoes, black boots and a grey fedora. They are MakeHuman's CC0 garments (the MakeHuman team), fitted by MPFB in Blender, then made into items by the converter: the skin's weights, a small push where skin came through, one texture each, and MakeHuman's logo painted out of the white tee. On each body no skin comes through any of them in the seven reference poses, as made and at both ends of the proportion sliders. [items/wardrobe.json](items/wardrobe.json) lists each one, what it hides and what it measured, and the garments left out and why. [items/fingerprints.json](items/fingerprints.json) holds their fingerprints, so a starter item is never taken for a copy. To make them again:

```sh
node tools/converter/scripts/make-wardrobe.ts
```

- Provenance: [provenance/](provenance/) holds one record for each asset in the whole repository, with saved copies of others' licence pages in `provenance/archive/`. The fields are listed at the top of `tools/harness/src/asset-check.ts`, and `npm run harness` checks every record.
