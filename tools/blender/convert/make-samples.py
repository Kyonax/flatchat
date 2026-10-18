# SPDX-License-Identifier: GPL-3.0-or-later
"""The upload-format samples for S5.08's tests: the converter's own sample models turned by Blender
into the files a creator would upload from another program.

    blender -b --factory-startup -noaudio -Y --offline-mode --python make-samples.py -- AVATAR.glb TEE.glb PROP.glb OUTDIR DECLARATION

AVATAR.glb is the converter's sample humanoid (tools/converter/src/avatar/samples.ts, the GLB
kind), TEE.glb the test tee's feminine fit (kits/items/test-tee/, cut to one body), PROP.glb the
sample cube (tools/converter/src/item/samples.ts), DECLARATION the cube's declaration as JSON.
tools/converter/src/source/samples.ts writes the three and runs this. Writes into OUTDIR:

  avatar.fbx  the humanoid as FBX: armature, skinned mesh, shape keys, its texture embedded
  tee.fbx     the tee's feminine fit as FBX, the way another program writes a garment: one body's
              skeleton, the mesh named by its body, no custom properties (its declaration is given
              at upload)
  prop.obj    the cube as OBJ (no .mtl: one file is uploaded)
  prop.blend  the cube as a .blend whose scene carries its declaration (flatchat_item, JSON)

No animation goes in any of them. to-glb.py then reads each back as the core would.
"""

import json
import os
import sys

import bpy


def load(glb):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    # The importer draws bones with a shape object, which an FBX would carry as one more mesh.
    for shape in {b.custom_shape for o in bpy.data.objects if o.type == "ARMATURE" for b in o.pose.bones if b.custom_shape}:
        bpy.data.objects.remove(shape, do_unlink=True)


def fbx(path):
    # No custom properties, as another program writes one: the converter finds a fit by its name.
    bpy.ops.export_scene.fbx(
        filepath=path,
        add_leaf_bones=False,
        bake_anim=False,
        use_custom_props=False,
        path_mode="COPY",
        embed_textures=True,
    )


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) != 5:
        sys.stderr.write("usage: make-samples.py -- AVATAR.glb TEE.glb PROP.glb OUTDIR DECLARATION\n")
        sys.exit(2)
    avatar, tee, prop, out, declaration = argv
    os.makedirs(out, exist_ok=True)

    load(avatar)
    fbx(os.path.join(out, "avatar.fbx"))

    load(tee)
    fbx(os.path.join(out, "tee.fbx"))

    load(prop)
    bpy.ops.wm.obj_export(filepath=os.path.join(out, "prop.obj"), export_materials=False, export_uv=False)

    load(prop)
    bpy.context.scene["flatchat_item"] = json.dumps(json.loads(declaration))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "prop.blend"), compress=True)


main()
