# Blender bridge

The script that runs Blender headless, as a separate process, to import FBX, OBJ, DAE, .blend and BVH files for the converter, and to build the body kits.

- Licence: GPL-3.0-or-later ([LICENSE](LICENSE)), as Blender asks of scripts that use its API
- Status: the body kit generator (Track P's P.03) is in [bodykit/](bodykit/). The importers for FBX, OBJ, DAE, .blend and BVH come with S5.07 and S5.08.

## The body kits

`bodykit/generate.py` runs inside Blender 5.2.2 LTS with MPFB 2.0.18 and the VRM Add-on 4.10.2. For each preset in `bodykit/presets/` it builds one adult body:

- MakeHuman's base mesh with the preset's macros baked in, and the game_engine rig;
- low-poly eyes, eyebrows and eyelashes;
- the toon skin, with an underwear layer painted into its texture;
- Faceunits 01 and Visemes 02 as shape keys, of which only the 36 the expressions use are kept;
- the 18 VRM expressions from `bodykit/expressions.json`, attachment markers, hide-mask regions and measurements;
- a thumbnail and an emotions sheet;
- the `.blend`, and a VRM 1.0 export with the parts joined into one mesh.

`bodykit/run.mts` drives it:

- `--setup` downloads each tool and asset pack, checks its SHA-256, and installs them into a Blender profile of FlatChat's own (`~/.local/opt/flatchat-blender`; `BLENDER_USER_RESOURCES` there), so a Blender of yours is untouched.
- Without it, it runs the generator twice and stops unless both runs agree. It then makes each VRM's face shapes sparse, keeps only the extensions the platform's avatars carry, passes each kit through the avatar converter (Khronos glTF-Validator, vrm-validator and the platform's rules), checks P.03's limits (a humanoid, LOD0 within 30,000 triangles and 70 bones, 18 expressions), and writes `kits/bodies/`.

Teeth and tongue are left out: MakeHuman's teeth alone are 7,120 triangles.
