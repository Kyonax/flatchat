# SPDX-License-Identifier: GPL-3.0-or-later
"""The FBX sample for the animation converter's golden tests (S5.07).

Reads the GLB clip sample (tools/converter/src/animation/samples.ts, written out by
tools/converter/scripts/animation-samples.ts) and writes it as FBX the way Blender's exporter
writes a character's animation for other tools: our own motion, so the fixture is ours to publish.

    blender -b --factory-startup -noaudio -y --python make-sample-fbx.py -- IN.glb OUT.fbx
"""

import sys

import bpy


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    source, out = argv
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=source)
    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not armatures:
        sys.stderr.write("make-sample-fbx: the GLB made no armature\n")
        sys.exit(1)
    for o in bpy.data.objects:
        o.select_set(o.type == "ARMATURE")
    # Every frame kept (no simplifying): the fixture is the motion itself.
    bpy.ops.export_scene.fbx(filepath=out, use_selection=True, object_types={"ARMATURE"}, bake_anim=True, bake_anim_simplify_factor=0.0, add_leaf_bones=False, path_mode="STRIP")


main()
