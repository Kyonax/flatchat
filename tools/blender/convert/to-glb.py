# SPDX-License-Identifier: GPL-3.0-or-later
"""An avatar's or an item's FBX, OBJ or .blend into a GLB for the converters (S5.08, DR-15, Q-M2).

The core runs this in headless Blender 5.2 LTS as a separate process (factory settings, no audio,
scripts in files never run: -Y, never -y; offline; no network; an address-space cap; a time limit)
on every FBX, OBJ or .blend avatar or item a player uploads. A .blend is opened as it is; an FBX or
an OBJ is imported into an empty scene. Then what the scene shows goes out as one GLB: meshes with
their skins and shape keys, the armature's bones as nodes, materials and packed images, custom
properties as extras (a .blend item's flatchat_item and flatchat_fit survive), and every modifier
but the armature applied. Hidden objects and bones' custom shapes (a rig's widgets) stay out; no
animation goes: avatars and items are converted at rest.
The TypeScript converters (tools/converter/src/avatar/, item/) then read it like any GLB.

    blender -b --factory-startup -noaudio -Y --offline-mode --python to-glb.py -- IN OUT.glb fbx|obj|blend

Exit 0 when OUT.glb was written; 1 with one line on stderr saying why not.
"""

import sys

import bpy


def fail(why):
    sys.stderr.write(f"to-glb: {why}\n")
    sys.exit(1)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) != 3 or argv[2] not in ("fbx", "obj", "blend"):
        fail("usage: to-glb.py -- IN OUT.glb fbx|obj|blend")
    source, out, kind = argv
    try:
        if kind == "blend":
            # Its own scene, as its maker left it; scripts inside it stay off (-Y).
            bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            if kind == "fbx":
                bpy.ops.import_scene.fbx(filepath=source, use_anim=False, ignore_leaf_bones=False, automatic_bone_orientation=False)
            else:
                bpy.ops.wm.obj_import(filepath=source)
    except Exception as err:  # noqa: BLE001 - any importer failure is the file's
        fail(f"Blender could not read the {kind.upper() if kind != 'blend' else '.blend'} file: {str(err).splitlines()[0][:200]}")
    # A bone's custom shape (a rig's widgets) is how Blender draws the bone, not part of the model.
    for shape in {b.custom_shape for o in bpy.data.objects if o.type == "ARMATURE" and o.pose for b in o.pose.bones if b.custom_shape}:
        bpy.data.objects.remove(shape, do_unlink=True)
    if not any(o.type == "MESH" and o.visible_get() for o in bpy.context.scene.objects):
        fail("the file has no mesh it shows")
    try:
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            use_visible=True,
            export_apply=True,
            export_skins=True,
            export_morph=True,
            export_animations=False,
            export_extras=True,
            export_yup=True,
        )
    except Exception as err:  # noqa: BLE001
        fail(f"Blender could not write the GLB: {str(err).splitlines()[0][:200]}")


main()
