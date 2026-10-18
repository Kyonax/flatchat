# Kits

The three body kits and the sources of the base library: free to use anywhere, with credit.

- Licence: CC BY 4.0 ([LICENSE](LICENSE)); third-party parts keep theirs, listed in [CREDITS.md](../CREDITS.md)
- Status: the three standard bodies are in [bodies/](bodies/) (Track P's P.03), and the test tee, fitted on all three, in [items/test-tee/](items/test-tee/) (S5.01, S5.02; how items are made: [docs/items.md](../docs/items.md)). The base library's sources come later.

## The three bodies

Three adult bodies, one topology between them, so a garment made on one is refitted to the others at authoring time (dp-001): Body A, feminine; Body B, masculine; Body C, broad and compact. Each folder holds the following files:

- `<name>.vrm`: the body as a VRM 1.0 avatar, which the platform converts like any upload. It is in T-pose, with the game_engine rig (53 bones: the VRM 1.0 humanoid with fingers), 27,488 triangles, MToon materials, an underwear layer in the skin texture (OQ-11), 36 face shapes and the 18 VRM expressions, plus twelve `attach_*` markers on the bones. Its VRM licence fields say: everyone may use it, commercially too, and modify and redistribute it, with credit (CC BY 4.0 in `otherLicenseUrl`).
- `<name>.blend`: the same body for creators, its parts apart and its images packed. It rests in MakeHuman's A-pose; the VRM add-on exports the T-pose. Its `mask_*` vertex groups are the hide-mask regions an item names, and the face shapes sit on every part that follows the face.
- `<name>-thumbnail.png` (the VRM's own picture) and `<name>-emotions.png` (happy, angry, sad, relaxed and surprised on its face).

[bodies/kits.json](bodies/kits.json) records each body's parts, measurements, regions, markers and expressions, the converter's verdict on it, and the tools that made it, each pinned by its SHA-256. To make them again:

```sh
node tools/blender/bodykit/run.mts --setup   # Blender 5.2.2 LTS, MPFB 2.0.18, the VRM Add-on 4.10.2, MakeHuman's CC0 packs
node tools/blender/bodykit/run.mts           # two runs that must agree, then the checks, then kits/bodies/
```

The presets and the expression recipes are JSON in `tools/blender/bodykit/`. The bodies are made from MakeHuman's CC0 assets ([provenance/body-kits.json](provenance/body-kits.json)), so they can be released as CC BY 4.0.
- Provenance: [provenance/](provenance/) holds one record for each asset in the whole repository, with saved copies of others' licence pages in `provenance/archive/`. The fields are listed at the top of `tools/harness/src/asset-check.ts`, and `npm run harness` checks every record.
