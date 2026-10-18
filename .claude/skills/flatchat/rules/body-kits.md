---
title: Body Kits — the Three Standard Bodies from MakeHuman's CC0 Assets in Headless Blender
impact: HIGH
impactDescription: A kit made by hand cannot be made again; one whose MToon flag was never set exports as plain PBR; a white emission at strength 0 lights a body white once its strength is dropped; a nude body ships against OQ-11; an A-pose rest would bury every shared animation's arms; and a kit the converter warns about or refuses is a body no one can wear.
tags: body kits, bodykit, kits/bodies, P.03, S5.01, generate.py, run.mts, presets, expressions.json, MPFB, MakeHuman, hm08, game_engine rig, Faceunits 01, Visemes 02, ARKit, Meta visemes, FaceService, interpolate_targets, bake_targets, add_mhclo_asset, set_character_skin, toon01, VRM Add-on, get_armature_extension, get_material_extension, mtoon1.enabled, convert_material_to_mtoon1, export_scene.vrm, T-pose, AUTO_POSE, BLENDER_USER_RESOURCES, headless Blender, Blender 5.2 LTS, underwear layer, OQ-11, OQ-28, emotions sheet, thumbnail, workbench, sparse, dropForeignExtensions, kits.json, provenance, derivedFrom
---

The three standard bodies (dp-001, rr-014) are made, never hand-edited, by `tools/blender/bodykit/` (GPL-3.0-or-later, as Blender asks of scripts using its API) and kept in `kits/bodies/` (CC BY 4.0). The checks run in CI without Blender (`tools/converter/test/bodykits.test.ts`); making them takes Blender.

## The Files

| File | Job |
|---|---|
| `presets/{feminine,masculine,neutral}.json` | Each body's MPFB macros (gender, age 0.5 = an adult, muscle, weight, proportions, height, cupsize, firmness, race) and its `underwear` parts (`briefs`, `top`). Which three bodies is OQ-28 (default: feminine, masculine, broad and compact) |
| `expressions.json` | The 18 VRM 1.0 expressions as weights of the face shapes (Meta visemes `viseme_*`, ARKit units like `eyeBlinkLeft`); the five emotions are recipes for the owner to judge on `<name>-emotions.png` |
| `generate.py` | Inside Blender: `create_human` with the macros, `bake_targets` (the macros become the body's own shape, so the face shapes start from it), `add_builtin_rig(..., "game_engine")`, low-poly eyes, eyebrow001 and eyelashes01, the toon01 skin (`GAMEENGINE`), `FaceService.load_targets` (Meta visemes and ARKit units) then `interpolate_targets` (onto every part that follows the face), helpers removed (`bake_modifiers_remove_helpers`), the underwear layer, only the expressions' 36 shapes kept, MToon, `attach_*` markers, `mask_*` regions (the 16 of `REGIONS` in packages/content: the torso as chest, belly and hips), measurements, the VRM setup, a thumbnail and an emotions sheet, the `.blend`, then the parts joined and the VRM exported |
| `run.mts` | `--setup` downloads each tool and pack, checks its SHA-256 (`PINS`), extracts Blender into `~/.local/opt/flatchat-blender` and installs the add-ons and packs into its own profile (`BLENDER_USER_RESOURCES`). Without it, two runs must give the same `summary.json`; each VRM is finished (`dropForeignExtensions`, then `sparse`), converted and checked against `LIMITS`; then `kits/bodies/` and `kits.json` are written |

## The Rules

| Rule | Why |
|---|---|
| Enable both add-ons in the script (`addon_utils.enable`), never trust saved preferences, and never call `read_factory_settings` | Headless, an add-on that is only imported registers nothing: `get_armature_extension` then returns `None`; factory settings unregister it |
| MToon is `get_material_extension(m).mtoon1.enabled = True` | The `vrm.convert_material_to_mtoon1` operator only rebuilds the node tree; without the flag the exporter writes plain PBR with Blender's clearcoat and specular |
| Zero each Principled BSDF's `Emission Color` before the conversion | Blender's default is a white emission at strength 0; carried into MToon and stripped of its strength, it lit the bodies white (the converter now folds a strength into the colour, `dropForeignExtensions`) |
| The underwear is painted into the skin texture, never cut into the mesh and never a material per face | Faces of MakeHuman's mesh do not run horizontally (stepped edges); a cut changes the shared topology every garment refits on; texels from each point's height give straight bands and one material slot less (rank Excellent) |
| Teeth and tongue stay out | MakeHuman's teeth alone are 7,120 triangles; with them a body is 35,056 (over P.03's 30,000) |
| The VRM is joined into one skinned mesh; the `.blend` is saved before the join | The rank counts skinned meshes (four held the kits at Medium); creators want the parts apart |
| Keep the `.blend` in A-pose; the VRM add-on exports T-pose (`humanoid.pose` left at its automatic pose) | Every shared animation (S4.06) assumes VRM's T-pose rest; the exported arms are exactly horizontal |
| The exporter's sparse option does not make morph targets sparse; `run.mts` does (`sparse({ ratio: 1/3 })`) | 12.5 of a kit's 14.3 MB were dense face shapes; sparse, a kit is about 4.7 MB |
| A change to a preset or recipe means `run.mts`, then committing `kits/bodies/` with its new `kits.json` | `bodykits.test.ts` checks each VRM's SHA-256 against `kits.json` and converts it within the limits |
| The kits' provenance is `kits/provenance/body-kits.json` with `derivedFrom`, each source's licence page saved in `kits/provenance/archive/` | P.07's gate holds what our own work was made from to CC0 or CC BY (the packs' manifests say CC0 per asset) |

## Measured (2026-10-17)

Each body is 27,488 triangles with 53 bones, 36 face shapes, 18 expressions and 4 material slots, which ranks Excellent; it converts to 27,488, 14,110, about 6,420 and 1,500 triangles. Heights: 1.562 m (feminine), 1.78 m (masculine), 1.637 m (neutral). Generation takes about 30 s for all three, and `run.mts` about 75 s. The owner's: at least 4 of 5 emotions accepted on each body, UniVRM loading them (needs Unity), and the look (P.02's art direction: the skin is MakeHuman's plain toon01 grey).
