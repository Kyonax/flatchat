# SPDX-License-Identifier: GPL-3.0-or-later
"""An FBX animation into a GLB for the animation converter (S5.07, DR-15).

The core runs this in headless Blender 5.2 LTS as a separate process (factory settings, no audio,
scripts in files never run, no network, a time limit) on every FBX emote or dance a player
uploads. It imports the FBX, keeps the armature and its animation, drops everything else (an FBX
dance usually carries its character, which the converter does not want) and writes a GLB with
the armature's bones as nodes and the motion sampled on every frame. The TypeScript converter
(tools/converter/src/animation/) then retargets it into VRMA like any GLB clip.

    blender -b --factory-startup -noaudio -y --python fbx2glb.py -- IN.fbx OUT.glb

Exit 0 when OUT.glb was written; 1 with one line on stderr saying why not.
"""

import sys

import bpy


def fail(why):
    sys.stderr.write(f"fbx2glb: {why}\n")
    sys.exit(1)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) != 2:
        fail("usage: fbx2glb.py -- IN.fbx OUT.glb")
    source, out = argv
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    try:
        # Leaf bones stay: a skeleton's head and hands are leaves when its exporter adds no end bones.
        bpy.ops.import_scene.fbx(filepath=source, use_anim=True, ignore_leaf_bones=False, automatic_bone_orientation=False)
    except Exception as err:  # noqa: BLE001 - any importer failure is the file's
        fail(f"Blender could not read the FBX: {str(err).splitlines()[0][:200]}")
    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not armatures:
        fail("the FBX has no skeleton")
    if not any(a.animation_data and a.animation_data.action for a in armatures):
        fail("the FBX has no animation on its skeleton")
    # The longest-animated armature only, and nothing else.
    def length(a):
        act = a.animation_data.action if a.animation_data else None
        return (act.frame_range[1] - act.frame_range[0]) if act else -1
    keep = max(armatures, key=length)
    for o in list(bpy.data.objects):
        if o is not keep:
            bpy.data.objects.remove(o, do_unlink=True)
    action = keep.animation_data.action
    scene = bpy.context.scene
    scene.frame_start = int(action.frame_range[0])
    scene.frame_end = int(action.frame_range[1])
    try:
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format="GLB",
            export_animations=True,
            export_force_sampling=True,
            export_animation_mode="ACTIVE_ACTIONS",
            export_def_bones=False,
            export_skins=True,
            export_morph=False,
            export_apply=False,
        )
    except Exception as err:  # noqa: BLE001
        fail(f"Blender could not write the GLB: {str(err).splitlines()[0][:200]}")


main()
