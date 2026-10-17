# Converter

Turns content into what FlatChat's programs serve and draw. Stage 2 built the world converter (S2.03): validation, optimized and compressed scenes with levels of detail for dense meshes, KTX2 textures, the solids and the navigation mesh. Stage 4 added the avatar converter (S4.02, S4.03): VRM 1.0, VRM 0.x and plain GLB avatars in, four VRM 1.0 levels (the full avatar, LOD1, LOD2, the impostor), a thumbnail and a ranked manifest out ([docs/avatars.md](../../docs/avatars.md)). FBX and the rest come later through headless Blender.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Status: Stage 4. World folders into built worlds; avatars into the platform's own format.

```sh
npm run convert -w @flatchat/converter -- WORLD_DIR OUT_DIR [--no-ktx2]
node tools/converter/scripts/make-plaza.ts      # rewrites kits/worlds/plaza from packages/sim's plaza
node tools/converter/scripts/make-travel.ts OUT --worlds ID_A,ID_B   # two plazas whose portals lead to each other (the travel checks)
node --permission --allow-fs-read=. --allow-fs-read=IN --allow-fs-write=OUT --import ./tools/converter/src/sandbox.ts \
  tools/converter/src/avatar-cli.ts IN OUT [--no-ktx2]   # one avatar, sandboxed as the core runs it
```

The avatar converter (`src/avatar/`): `convert.ts` runs the pipeline (Khronos's glTF-Validator and vrm-validator, the platform's rules and hard limits, the four repairs, VRM 0.x migration by three-vrm's rules in `vrm0.ts`, a GLB's skeleton by its bone names in `humanoid.ts`, the turn to face +Z, clean-up, ranking from `packages/content`'s table); `vrm.ts` is VRM 1.0 as a glTF-Transform extension, every reference a graph edge kept by slot; `lod.ts` makes LOD1, LOD2 and the impostor; `samples.ts` writes the three reference avatars (VRM 1.0, VRM 0.x, a Mixamo-named GLB) the tests convert against `test/golden/avatars.json`. `src/avatar-cli.ts` is the program the core starts per upload, `src/sandbox.ts` the hook that keeps native addons off under Node.js's permission model.

A world folder ([docs/world-format.md](../../docs/world-format.md)) is validated first and refused on any error. Then each scene's visuals are optimized (glTF-Transform: dedup, prune, weld, meshopt compression), every PNG and JPEG texture is fitted to 2048 px and a 128 MB budget for the whole world and encoded to KTX2 (Basis Universal as WebAssembly: ETC1S for colour, UASTC for normal maps), every solid is collected in world space into `collision.bin` (the OMI physics markers, or every mesh when a world marks none), and a navigation mesh is built for click-to-move (Recast, 20 cm cells). The output: `world.json` and `content/<sha256>` files. The build is deterministic: `test/golden/plaza.world.json` pins the plaza's (`FLATCHAT_GOLDEN_WRITE=1` rewrites it after a deliberate change).
