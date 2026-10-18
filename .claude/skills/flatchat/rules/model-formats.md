---
title: Model Formats — FBX, OBJ and .blend through Headless Blender, DAE through assimp, Declarations at Upload
impact: HIGH
impactDescription: A format guessed from a file's name lets a renamed file through the wrong reader; Blender 5 has no Collada importer, so DAE must take assimp; assimp's GLB keeps every corner as its own vertex, so its levels of detail never simplify and the avatar loses its rank; a glTF importer's bone shapes ride into an FBX as an extra mesh; Blender's glTF importer joins sibling skeletons into one armature with renamed bones; an FBX, OBJ or DAE keeps no custom properties, so an item from one has no declaration and no marked fits unless the upload gives them; a Blender that does not start is the server's fault, not the file's.
tags: model formats, S5.08, Q-M2, Q-M11, DR-15, uploadFormat, UploadFormat, MODEL_FROM, ModelFrom, MODEL_EXTENSIONS, BLENDER_FORMATS, MODEL_FORMAT_NAMES, source.from, uploadGlb, UploadSource, UploadError, sourceArgs, daeToGlb, DaeError, assimpjs, assimp, weld, KHR_materials_ior, FB_ngon_encoding, to-glb.py, make-samples.py, make-format-samples.ts, blenderSamples, sampleDae, daeOf, oneFitTee, SAMPLE_PROP_DECLARATION, SAMPLE_TEE_DECLARATION, BLENDER_SAMPLES, formats.json, fixtures/formats, throughBlender, TO_GLB, BLENDER_MODEL_MS, FLATCHAT_CORE_BLENDER, FLATCHAT_BLENDER, declaration column, migration 0017, --declare, --from, --source, fileDeclaration, fitNodes name fallback, declaresItself, PendingItems, needs-declaration, DeclareItemForm, stand-in Blender, FBX, OBJ, DAE, Collada, .blend
---

An avatar or an item may be a VRM, a GLB, an FBX, an OBJ, a DAE or a `.blend` (S5.08, Q-M2, Q-M11). The guides are `docs/avatars.md` (Other formats) and `docs/items.md` (Items from other programs).

## The Roads

| Format | Read by | Where |
|---|---|---|
| VRM, GLB | the converter, as they are | `tools/converter/src/avatar/`, `item/` |
| DAE | assimp in WebAssembly (assimpjs 0.0.10, MIT; assimp 5.2, BSD-3) inside the converter's own process and sandbox | `tools/converter/src/source/dae.ts` |
| FBX, OBJ, `.blend` | headless Blender 5.2.2 LTS on the core, before the converter | `tools/blender/convert/to-glb.py`, run by `apps/core/src/sandbox.ts`'s `throughBlender` |

A file is known by its first bytes, never by its name: `uploadFormat` in `packages/content/src/formats.ts` (shared by the converter, the core and the client):

- `glTF` → gltf;
- `Kaydara FBX Binary` or `; FBX` → fbx;
- `BLENDER`, zstd (`28 b5 2f fd`) or gzip (`1f 8b`) → blend;
- `<COLLADA` after an optional BOM, XML declaration and comments → dae;
- a first statement of OBJ's own (`v`, `f`, `o`, `g`, `mtllib`…) → obj;
- anything else → unknown (the converter's "not a GLB or VRM" refusal).

DR-15 put every foreign format through Blender. That changed for DAE: Blender 5 removed its Collada importer, so DAE takes assimp instead. This is a recorded deviation.

## The Files

| File | Job |
|---|---|
| `packages/content/src/formats.ts` | `uploadFormat`, `MODEL_EXTENSIONS` (the dialogs' filters), `BLENDER_FORMATS`, `MODEL_FORMAT_NAMES` ("the FBX file") |
| `packages/content/src/avatar.ts`, `item.ts` | `MODEL_FROM`; the manifests' `source.from`; `fileDeclaration(json)` (a file's own `flatchat_item`, on the scene or the file, a JSON string from Blender read) |
| `tools/converter/src/source/upload.ts` | `uploadGlb(bytes, given?)`: a GLB as it is; a DAE through `daeToGlb`; FBX, OBJ, `.blend` refused ("read by headless Blender on the core first"); with `given` (the core's Blender GLB), the bytes must be a GLB and `given` is the source. `sourceArgs` reads `--from fbx\|obj\|blend --source SHA256:BYTES` (false: a usage error, exit 2) |
| `…/source/dae.ts` | assimp's `ConvertFileList(…, 'glb2')`, then glTF-Transform's `weld()` (assimp's GLB is fully unwelded: 7,344 vertices for 7,344 indices) and `KHR_materials_ior`/`KHR_materials_volume` dropped (assimp writes them on every material from Collada's defaults, an IOR of 1). A logger at ERROR hides assimp's `FB_ngon_encoding` |
| `…/source/samples.ts` (`@flatchat/converter/format-samples`) | `daeOf(glb)` (a Collada 1.4.1 writer: one geometry per mesh with a triangle list per material, skins as controllers over JOINT nodes, root joints at their world matrix, row-major matrices, UV V flipped), `sampleDae('avatar'\|'prop')`, `oneFitTee()`, the samples' declarations, `blenderSamples(blender, dir)` (`make-samples.py`, then `to-glb.py` on each) |
| `tools/blender/convert/to-glb.py` | `IN OUT.glb fbx\|obj\|blend`: `.blend` by `open_mainfile(load_ui=False, use_scripts=False)`; FBX/OBJ into `read_factory_settings(use_empty=True)` (FBX with `ignore_leaf_bones=False`, no animation); bone custom shapes removed; refused with no visible mesh; GLB with `use_visible`, `export_apply`, skins, morphs, extras, no animations. One `to-glb:` line on stderr, exit 1, when it cannot |
| `tools/blender/convert/make-samples.py`, `tools/converter/scripts/make-format-samples.ts` | The fixtures: `avatar.fbx`, `tee.fbx` (one body, no custom properties), `prop.obj` (no `.mtl`), `prop.blend` (its scene's `flatchat_item`), read back into `tools/converter/test/fixtures/formats/*.glb` (provenance `format-samples.json` CC0, `format-tee.json` CC-BY-4.0 like the tee) |
| `apps/core/src/sandbox.ts` | `throughBlender(blender, upload, input, {dir, source, isolated})`: undefined for VRM, GLB, DAE; `{refused}` with no Blender, Blender's `to-glb:` reason, or "ran out of time" (`BLENDER_MODEL_MS` five minutes); `{input, args}` for the converter. Exit -1 (Blender did not start) throws, so the row is `failed`, not `refused` |
| `apps/core/src/avatars.ts`, `items.ts`, `migrations/0017-model-formats.sql` | Both route through `throughBlender`; items keep `declaration jsonb`, checked at the slot with `readItemDeclaration` (`bad-request` with every reason) and passed as `--declare FILE` |
| `apps/client/src/main/item-files.ts` | `modelName`, `declaresItself` (a GLB with its own declaration, a `.blend`, or an unknown file go at once), `PendingItems` (a token per waiting file, taken once, 15 minutes) |
| `apps/client/src/renderer/src/ui/DeclareItemForm.vue` | The declaration form (name, slot, regions or point, authors), checked with `readItemDeclaration` before it is sent |

## The Rules

| Rule | Why |
|---|---|
| Detect formats with `uploadFormat`, never by extension | A renamed file would reach the wrong reader; one function keeps the converter, core and client in agreement |
| The converter alone never reads FBX, OBJ or `.blend` | Blender runs only on the core, in its own sandbox (no network, 6 GB, five minutes, `-Y --offline-mode`); the converter keeps its Node.js permission model |
| Weld assimp's output | Unwelded corners leave the simplifier nothing to collapse: LOD1 and LOD2 come out at LOD0's count and the rank drops |
| Write one Collada geometry per glTF mesh, not per primitive | assimp turns each geometry into a mesh: two skinned meshes rank Good, one ranks Excellent |
| Remove bones' custom shapes before an FBX export and before `to-glb.py` writes | Blender's glTF importer draws bones with an `Icosphere`; an FBX carries it as one more mesh, and a rig's widgets would ship as geometry |
| Give Blender one body's skeleton per sample | Blender's glTF importer joins sibling skeletons with the same bone names into one armature (`Root`, `Root.001`…), which the item converter refuses for bones the kits lack |
| An item's declaration: the file's own first, the upload's second | A GLB or `.blend` made with the guide says what it is; an FBX, OBJ or DAE cannot, so the upload gives it. With neither, the converter says so plainly ("the OBJ file keeps no declaration…") |
| Find fits by mesh name when no mesh is marked | An FBX keeps no `flatchat_fit`; a skinned mesh whose name holds `feminine`, `masculine` or `neutral` is that body's fit |
| Compare clipping with nothing hidden when proving a fit sits right | A garment that hides every region it covers checks no body points (`checked: 0`); only the unhidden check shows the FBX tee lands exactly where the GLB tee does |
| Blender start failure → `failed`; Blender's refusal → `refused` | A missing binary is the server's fault; the player should not be told the file is bad |

## Tests

- **`tools/converter/test/formats.test.ts`** with `test/golden/formats.json`. It covers:
  - format detection;
  - the DAE avatar and prop through assimp;
  - the four Blender fixtures;
  - the manifests' `source`;
  - the FBX tee's fits and clipping equal to the GLB tee's;
  - the stripped tee's fits equal to the marked one's, byte for byte;
  - declarations given, missing and outranked;
  - the CLIs under the permission model, assimp's WebAssembly included;
  - usage errors.
  
  Where Blender is (`FLATCHAT_BLENDER`, else `~/.local/opt/flatchat-blender/…`), `blenderSamples` runs again and must give the fixtures' exact bytes: Blender 5.2.2's GLB export is deterministic.
- **`apps/core/test/formats.test.ts`** uses a stand-in Blender: a shell script that copies the fixture for the format it is handed, and fails on `.blend` the way Blender does. It covers:
  - DAE with no Blender;
  - every Blender format refused with no Blender;
  - FBX avatars and OBJ items with the upload's own SHA-256 in the manifest;
  - Blender's reason kept;
  - the slot's declaration check.
  
  Where real Blender is, an FBX avatar and a `.blend` item take the real road.
- **`apps/client/test/item-files.test.ts`** covers `modelName` (native paths: `basename` is the platform's), `declaresItself` and `PendingItems`.
- Rewrite the fixtures with `node tools/converter/scripts/make-format-samples.ts`, and the golden file with `FLATCHAT_GOLDEN_WRITE=1`. Explain both in the commit.
