# Converter

Turns content into what FlatChat's programs serve and draw. Stage 2 built the world converter (S2.03): validation, optimized and compressed scenes with levels of detail for dense meshes, KTX2 textures, the solids and the navigation mesh. Avatar uploads (VRM, GLB, then FBX and the rest), their levels of detail, impostors and ranks come in Stage 4.

- Licence: MPL-2.0 ([LICENSE](LICENSE))
- Status: Stage 2. World folders into built worlds.

```sh
npm run convert -w @flatchat/converter -- WORLD_DIR OUT_DIR [--no-ktx2]
node tools/converter/scripts/make-plaza.ts      # rewrites kits/worlds/plaza from packages/sim's plaza
node tools/converter/scripts/make-travel.ts OUT --worlds ID_A,ID_B   # two plazas whose portals lead to each other (the travel checks)
```

A world folder ([docs/world-format.md](../../docs/world-format.md)) is validated first and refused on any error. Then each scene's visuals are optimized (glTF-Transform: dedup, prune, weld, meshopt compression), every PNG and JPEG texture is fitted to 2048 px and a 128 MB budget for the whole world and encoded to KTX2 (Basis Universal as WebAssembly: ETC1S for colour, UASTC for normal maps), every solid is collected in world space into `collision.bin` (the OMI physics markers, or every mesh when a world marks none), and a navigation mesh is built for click-to-move (Recast, 20 cm cells). The output: `world.json` and `content/<sha256>` files. The build is deterministic: `test/golden/plaza.world.json` pins the plaza's (`FLATCHAT_GOLDEN_WRITE=1` rewrites it after a deliberate change).
