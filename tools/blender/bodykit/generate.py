# SPDX-License-Identifier: GPL-3.0-or-later
"""The body kit generator (Track P's P.03, rr-014): builds the three standard bodies headless.

Each preset (presets/*.json) becomes one kit: an MPFB 2.0.18 human from MakeHuman's CC0 base mesh
with its macros baked in, the game_engine rig (the VRM 1.0 humanoid with fingers), CC0 eyes,
eyebrows, eyelashes, teeth and tongue, the toon skin, the Meta visemes and ARKit face units as
shape keys (on every part that follows the face), an underwear layer (OQ-11: no nudity), the 18
VRM expressions from expressions.json, attachment markers, hide-mask regions and measurements;
then a VRM 1.0 export (VRM Add-on 4.10.2), a .blend for creators and a summary of what was made.

    blender --background --python generate.py -- --out DIR [--only NAME]

Run it through run.ts, which pins Blender 5.2 LTS and a profile with MPFB and the VRM add-on.
Two runs give the same summary: nothing here is random.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
MPFB = "bl_ext.user_default.mpfb"


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out, only = None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        elif argv[i] == "--only":
            only = argv[i + 1]
            i += 2
        else:
            raise SystemExit(f"unknown argument {argv[i]}")
    if not out:
        raise SystemExit("usage: generate.py -- --out DIR [--only NAME]")
    return out, only


def enable_addons():
    """Both add-ons registered in this session (headless, saved preferences are not relied on):
    the VRM add-on's settings on an armature exist only once it is."""
    import addon_utils
    for module in (MPFB, "bl_ext.user_default.vrm"):
        loaded, enabled = addon_utils.check(module)
        if not enabled:
            addon_utils.enable(module, default_set=True, persistent=True)
        if not addon_utils.check(module)[1]:
            raise SystemExit(f"{module} is not installed: run.ts installs MPFB 2.0.18 and the VRM Add-on 4.10.2")


def services():
    import importlib
    get = lambda name: importlib.import_module(f"{MPFB}.services.{name}")
    return (get("humanservice").HumanService, get("faceservice").FaceService, get("targetservice").TargetService,
            get("exportservice").ExportService, get("locationservice").LocationService)


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images, bpy.data.node_groups):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def asset(location_service, kind, name, ext):
    path = os.path.join(location_service.get_user_data(kind), name, f"{name}.{ext}")
    if not os.path.isfile(path):
        raise SystemExit(f"missing asset {path}: install MakeHuman's CC0 system assets (run.ts says how)")
    return path


def evaluated_triangles(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = obj.evaluated_get(dg).to_mesh()
    n = sum(len(p.vertices) - 2 for p in mesh.polygons)
    obj.evaluated_get(dg).to_mesh_clear()
    return n


# ----------------------------------------------------------------------------- the body


def build(preset, HumanService, FaceService, TargetService, ExportService, LocationService):
    clear_scene()
    macros = dict(preset["macros"])
    body = HumanService.create_human(macro_detail_dict=macros)
    body.name = f"{preset['name']}_body"
    # The macros become the body's own shape: the face shapes below start from it.
    TargetService.bake_targets(body)
    rig = HumanService.add_builtin_rig(body, "game_engine")
    rig.name = f"{preset['name']}_rig"
    # Eyes, brows and lashes. MakeHuman's teeth alone are 7,120 triangles, which would take the body
    # past the 30,000 of LOD0, so the kits leave teeth and tongue out (a light mouth is a follow-up).
    for kind, name in (("eyes", "low-poly"), ("eyebrows", "eyebrow001"), ("eyelashes", "eyelashes01")):
        before = set(bpy.data.objects)
        HumanService.add_mhclo_asset(asset(LocationService, kind, name, "mhclo"), body, asset_type=kind.capitalize(), subdiv_levels=0, material_type="GAMEENGINE")
        for added in set(bpy.data.objects) - before:
            if added.type == "MESH":
                added.name = f"{preset['name']}_{kind}"
    HumanService.set_character_skin(asset(LocationService, "skins", "toon01", "mhmat"), body, skin_type="GAMEENGINE")
    FaceService.load_targets(body, load_microsoft_visemes=False, load_meta_visemes=True, load_arkit_faceunits=True)
    FaceService.interpolate_targets(body)
    ExportService.bake_modifiers_remove_helpers(body, bake_masks=True, bake_subdiv=False, remove_helpers=True, also_proxy=True)
    return body, rig


def keep_shapes(recipes):
    """Only the face shapes the expressions use stay (rr-014: 67 shapes on a 26,000-triangle body
    cost every viewer memory; the 18 presets need about half)."""
    used = {shape for name, weights in recipes.items() if not name.startswith("_") for shape in weights}
    removed = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not obj.data.shape_keys:
            continue
        for key in list(obj.data.shape_keys.key_blocks)[1:]:
            if key.name not in used:
                obj.shape_key_remove(key)
                removed += 1
        if len(obj.data.shape_keys.key_blocks) == 1:
            obj.shape_key_remove(obj.data.shape_keys.key_blocks[0])
    return removed


def toon(rig):
    """Every material as MToon, the VRM norm the art direction names (toon-shaded)."""
    from bl_ext.user_default.vrm.editor.extension_accessor import get_material_extension
    names = sorted({slot.material.name for o in bpy.data.objects if o.type == "MESH" for slot in o.material_slots if slot.material})
    for name in names:
        material = bpy.data.materials[name]
        # Nothing on a body glows: Blender's Principled BSDF defaults to a white emission at strength
        # 0, which the conversion would carry over as a white emissive colour.
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                node.inputs["Emission Color"].default_value = (0.0, 0.0, 0.0, 1.0)
                node.inputs["Emission Strength"].default_value = 0.0
        # Enabling MToon converts the material and marks it, so the exporter writes VRMC_materials_mtoon
        # (the vrm.convert_material_to_mtoon1 operator alone only rebuilds the node tree).
        mtoon = get_material_extension(material).mtoon1
        mtoon.enabled = True
        if not mtoon.enabled:
            raise SystemExit(f"MToon could not be enabled on {name}")
        # The shaded side: a darker shade of the lit side's own colours (the underwear stays dark).
        toon = mtoon.extensions.vrmc_materials_mtoon
        toon.shade_color_factor = SHADE
        lit = mtoon.pbr_metallic_roughness.base_color_texture.index.source
        if lit:
            toon.shade_multiply_texture.index.source = lit
    return names


# ----------------------------------------------------------------------- the underwear layer


UNDERWEAR_COLOUR = (0.08, 0.08, 0.09)
# Where underwear() writes the skin layers (main sets it to the output folder).
LAYERS_OUT = "."
# MToon's shaded side, multiplied with the lit side's texture.
SHADE = (0.72, 0.68, 0.74)
SKIN_TEXTURE = 1024


def underwear(body, rig, parts):
    """OQ-11: the kits are never nude. The underwear is a layer of the skin's texture (dp-002's merged
    skin layers): bands at fixed heights scaled to the body, shorts from below the crotch to above the
    hip joints, and for a top a band around the chest centred on the nipples (MakeHuman's own vertex
    group). Painted in the texture, pixel by pixel from each point's height, its edges run straight
    around the body, and the mesh stays the shared topology every item fits. Arms and hands, which
    hang beside both bands in the rest pose, are never painted."""
    import numpy as np
    mesh = body.data
    groups = {g.index: g.name for g in body.vertex_groups}
    pose = {b.name: rig.matrix_world @ b.head_local for b in rig.data.bones}
    zs = np.array([(body.matrix_world @ v.co).z for v in mesh.vertices])
    scale = (zs.max() - zs.min()) / 1.7
    thigh_z = (pose["thigh_l"].z + pose["thigh_r"].z) / 2
    nipple = body.vertex_groups.get("nipple")
    tips = [zs[v.index] for v in mesh.vertices if nipple and any(g.group == nipple.index and g.weight > 0.5 for g in v.groups)]
    nipple_z = float(np.mean(tips)) if tips else pose["spine_03"].z - 0.05 * scale
    bands = []
    if "briefs" in parts:
        bands.append((thigh_z - 0.13 * scale, thigh_z + 0.11 * scale))
    if "top" in parts:
        bands.append((nipple_z - 0.075 * scale, nipple_z + 0.065 * scale))
    arms = {f"{b}_{s}" for b in ("upperarm", "lowerarm", "hand", "thumb_01", "thumb_02", "thumb_03", "index_01", "index_02", "index_03", "middle_01", "middle_02", "middle_03", "ring_01", "ring_02", "ring_03", "pinky_01", "pinky_02", "pinky_03") for s in ("l", "r")}
    on_arm = np.zeros(len(mesh.vertices), dtype=bool)
    for v in mesh.vertices:
        best, weight = None, 0.0
        for g in v.groups:
            name = groups.get(g.group)
            if name in pose and g.weight > weight:
                best, weight = name, g.weight
        on_arm[v.index] = best in arms

    # The body's own material gets a texture: the skin's colour, and the underwear in its bands.
    skin = next(slot.material for slot in body.material_slots if slot.material and slot.material.name.endswith(".body"))
    bsdf = next(n for n in skin.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    colour = tuple(bsdf.inputs["Base Color"].default_value)[:3]
    size = SKIN_TEXTURE
    rgba = np.empty((size, size, 4), dtype=np.float32)
    rgba[:, :, :3] = colour
    rgba[:, :, 3] = 1.0
    uv = mesh.uv_layers.active.data
    mesh.calc_loop_triangles()
    painted = 0
    ys, xs = np.mgrid[0:size, 0:size]
    for tri in mesh.loop_triangles:
        if body.data.polygons[tri.polygon_index].material_index != 0 or on_arm[list(tri.vertices)].any():
            continue
        tz = zs[list(tri.vertices)]
        if not any(tz.max() > lo and tz.min() < hi for lo, hi in bands):
            continue
        p = np.array([uv[l].uv[:] for l in tri.loops]) * size - 0.5
        x0, y0 = np.floor(p.min(axis=0)).astype(int) - 1
        x1, y1 = np.ceil(p.max(axis=0)).astype(int) + 2
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, size), min(y1, size)
        if x0 >= x1 or y0 >= y1:
            continue
        px, py = xs[y0:y1, x0:x1], ys[y0:y1, x0:x1]
        (ax, ay), (bx, by), (cx, cy) = p
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-12:
            continue
        w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
        w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
        w2 = 1.0 - w0 - w1
        # A little past the edges (about a texel): no skin-coloured line along the UV seams.
        slack = 1.5 / max(abs(det) ** 0.5, 1.0)
        inside = (w0 >= -slack) & (w1 >= -slack) & (w2 >= -slack)
        z = w0 * tz[0] + w1 * tz[1] + w2 * tz[2]
        hit = inside & np.any([(z > lo) & (z < hi) for lo, hi in bands], axis=0)
        if hit.any():
            rgba[y0:y1, x0:x1, :3][hit] = UNDERWEAR_COLOUR
            painted += int(hit.sum())
    image = bpy.data.images.new(f"{body.name}_skin", size, size, alpha=False)
    image.pixels.foreach_set(rgba.ravel())
    image.pack()
    # The layers apart (S5.03's merged skin layers): the bare skin, and the underwear as a layer of
    # its own (its colour where painted, clear elsewhere). The VRM keeps their composite, so a kit
    # is never shown without its underwear.
    layer = np.zeros((size, size, 4), dtype=np.float32)
    layer[:, :, :3] = UNDERWEAR_COLOUR
    layer[:, :, 3] = np.all(np.isclose(rgba[:, :, :3], UNDERWEAR_COLOUR, atol=1e-6), axis=2).astype(np.float32)
    bare = np.empty((size, size, 4), dtype=np.float32)
    bare[:, :, :3] = colour
    bare[:, :, 3] = 1.0
    for name, pixels in (("skin", bare), ("underwear", layer)):
        out_image = bpy.data.images.new(f"{body.name}_{name}_layer", size, size, alpha=True)
        out_image.pixels.foreach_set(pixels.ravel())
        out_image.filepath_raw = os.path.join(LAYERS_OUT, f"{body.name.rsplit('_', 1)[0]}-{name}.png")
        out_image.file_format = "PNG"
        out_image.save()
        bpy.data.images.remove(out_image)
    texture = skin.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    skin.node_tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    return painted


# ------------------------------------------------------------------ markers, masks, measures

MARKERS = [
    # name, bone, offset in metres (x right, y forward, z up, in the rig's rest frame)
    ("attach_head_top", "head", (0.0, 0.0, 0.17)),
    ("attach_face", "head", (0.0, -0.11, 0.06)),
    ("attach_neck", "neck_01", (0.0, -0.05, 0.02)),
    ("attach_chest", "spine_03", (0.0, -0.12, 0.05)),
    ("attach_back", "spine_03", (0.0, 0.14, 0.0)),
    ("attach_hips", "pelvis", (0.0, 0.0, 0.0)),
    ("attach_hip_l", "thigh_l", (0.08, 0.0, 0.0)),
    ("attach_hip_r", "thigh_r", (-0.08, 0.0, 0.0)),
    ("attach_hand_l", "hand_l", (0.0, 0.0, 0.0)),
    ("attach_hand_r", "hand_r", (0.0, 0.0, 0.0)),
    ("attach_foot_l", "foot_l", (0.0, 0.0, 0.0)),
    ("attach_foot_r", "foot_r", (0.0, 0.0, 0.0)),
]

# Hide-mask regions: the body's faces an item may hide, named by the bones that move them.
REGIONS = {
    "head": ["head", "neck_01"],
    "chest": ["spine_02", "spine_03", "clavicle_l", "clavicle_r"],
    "belly": ["spine_01"],
    "hips": ["pelvis"],
    "upper_arm_l": ["upperarm_l"], "upper_arm_r": ["upperarm_r"],
    "lower_arm_l": ["lowerarm_l"], "lower_arm_r": ["lowerarm_r"],
    "hand_l": ["hand_l"], "hand_r": ["hand_r"],
    "upper_leg_l": ["thigh_l"], "upper_leg_r": ["thigh_r"],
    "lower_leg_l": ["calf_l"], "lower_leg_r": ["calf_r"],
    "foot_l": ["foot_l", "ball_l"], "foot_r": ["foot_r", "ball_r"],
}


def markers(rig):
    made = []
    for name, bone, (x, y, z) in MARKERS:
        b = rig.data.bones[bone]
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "ARROWS"
        empty.empty_display_size = 0.05
        bpy.context.scene.collection.objects.link(empty)
        empty.parent = rig
        empty.parent_type = "BONE"
        empty.parent_bone = bone
        # A bone-parented object sits at the bone's tail; place it in world space from the head.
        world = rig.matrix_world @ (b.head_local + Vector((x, y, z)))
        empty.matrix_world.translation = world
        made.append(name)
    return made


def regions(body):
    """Each region's vertex group (mask_<region>): the vertices whose strongest weight is one of
    its bones. Items name the regions they cover; the runtime hides those faces (S5.02)."""
    groups = {g.index: g.name for g in body.vertex_groups}
    owner = {}
    for region, bones in REGIONS.items():
        for bone in bones:
            owner[bone] = region
    members = {region: [] for region in REGIONS}
    for v in body.data.vertices:
        best, weight = None, 0.0
        for g in v.groups:
            name = groups.get(g.group)
            if name in owner and g.weight > weight:
                best, weight = name, g.weight
        if best:
            members[owner[best]].append(v.index)
    counts = {}
    for region, verts in members.items():
        group = body.vertex_groups.new(name=f"mask_{region}")
        group.add(verts, 1.0, "REPLACE")
        counts[region] = len(verts)
    return counts


def measurements(body, rig):
    """Measured on the body in its rest pose, in metres: height, and the circumferences of the
    chest, waist and hips at their joints' heights, from slicing the mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = body.evaluated_get(dg).to_mesh()
    points = [body.matrix_world @ v.co for v in mesh.vertices]
    body.evaluated_get(dg).to_mesh_clear()
    lo = min(p.z for p in points)
    hi = max(p.z for p in points)
    pose = {b.name: rig.matrix_world @ b.head_local for b in rig.data.bones}

    def girth(z, band=0.012, half_width=None):
        ring = [p for p in points if abs(p.z - z) < band and (half_width is None or abs(p.x) < half_width)]
        if len(ring) < 8:
            return None
        cx = sum(p.x for p in ring) / len(ring)
        cy = sum(p.y for p in ring) / len(ring)
        ring.sort(key=lambda p: math.atan2(p.y - cy, p.x - cx))
        # The convex outline's length: what a tape measure reads.
        hull = []
        for p in sorted(ring, key=lambda p: (p.x, p.y)):
            while len(hull) >= 2 and (hull[-1].x - hull[-2].x) * (p.y - hull[-2].y) - (hull[-1].y - hull[-2].y) * (p.x - hull[-2].x) <= 0:
                hull.pop()
            hull.append(p)
        upper = []
        for p in reversed(sorted(ring, key=lambda p: (p.x, p.y))):
            while len(upper) >= 2 and (upper[-1].x - upper[-2].x) * (p.y - upper[-2].y) - (upper[-1].y - upper[-2].y) * (p.x - upper[-2].x) <= 0:
                upper.pop()
            upper.append(p)
        outline = hull[:-1] + upper[:-1]
        return round(sum((outline[i] - outline[i - 1]).length for i in range(len(outline))), 3)

    shoulder = pose["upperarm_l"].x - pose["upperarm_r"].x
    torso = abs(shoulder) * 0.9
    return {
        "height": round(hi - lo, 3),
        "chest": girth(pose["spine_03"].z, half_width=torso),
        "waist": girth(pose["spine_01"].z, half_width=torso),
        "hips": girth(pose["thigh_l"].z, half_width=torso),
        "shoulderWidth": round(abs(shoulder), 3),
        "inseam": round(pose["thigh_l"].z - lo, 3),
        "armLength": round((pose["hand_l"] - pose["upperarm_l"]).length, 3),
    }


# ------------------------------------------------------------------------------ VRM setup


def vrm(preset, body, rig, recipes):
    from bl_ext.user_default.vrm.editor.extension_accessor import get_armature_extension
    ext = get_armature_extension(rig.data)
    ext.spec_version = ext.SPEC_VERSION_VRM1
    bpy.context.view_layer.objects.active = rig
    bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=rig.name)
    humanoid = ext.vrm1.humanoid.human_bones
    mapped = {name: getattr(humanoid, name).node.bone_name for name in ("hips", "spine", "chest", "upper_chest", "neck", "head",
              "left_upper_leg", "left_lower_leg", "left_foot", "left_toes", "left_shoulder", "left_upper_arm", "left_lower_arm",
              "left_hand", "left_thumb_metacarpal", "left_index_proximal", "left_little_distal")}
    missing = [k for k, v in mapped.items() if not v]
    if missing:
        raise SystemExit(f"{preset['name']}: humanoid bones not mapped: {missing}")

    meta = ext.vrm1.meta
    meta.vrm_name = f"FlatChat {preset['title']}"
    meta.version = "1.0"
    while len(meta.authors):
        meta.authors.remove(0)
    meta.authors.add().value = "the FlatChat contributors"
    meta.copyright_information = "Made from MakeHuman's CC0 assets with MPFB; released under CC BY 4.0"
    meta.avatar_permission = "everyone"
    meta.commercial_usage = "corporation"
    meta.credit_notation = "required"
    meta.allow_redistribution = True
    meta.modification = "allowModificationRedistribution"
    meta.allow_excessively_violent_usage = False
    meta.allow_excessively_sexual_usage = False
    meta.allow_political_or_religious_usage = False
    meta.allow_antisocial_or_hate_usage = False
    meta.other_license_url = "https://creativecommons.org/licenses/by/4.0/"

    faces = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]
    keys = {o.name: {k.name for k in o.data.shape_keys.key_blocks} for o in faces}
    presets = ext.vrm1.expressions.preset
    made = []
    for name, weights in recipes.items():
        if name.startswith("_"):
            continue
        expression = getattr(presets, name)
        while len(expression.morph_target_binds):
            expression.morph_target_binds.remove(0)
        for shape, weight in sorted(weights.items()):
            for obj in faces:
                if shape in keys[obj.name]:
                    bind = expression.morph_target_binds.add()
                    bind.node.mesh_object_name = obj.name
                    bind.index = shape
                    bind.weight = float(weight)
        if name.startswith("blink"):
            expression.is_binary = False
        made.append(name)
    look = ext.vrm1.look_at
    look.type = look.TYPE_EXPRESSION.identifier
    return mapped, made


def thumbnail(preset, body, out):
    """The kit's picture, from the front (VRM's thumbnail, and what a person sees in a gallery):
    an orthographic Workbench render, 512 px square."""
    scene = bpy.context.scene
    points = [body.matrix_world @ v.co for v in body.data.vertices]
    lo, hi = min(p.z for p in points), max(p.z for p in points)
    cam_data = bpy.data.cameras.new(f"{preset['name']}_thumbnail")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = (hi - lo) * 1.12
    cam = bpy.data.objects.new(f"{preset['name']}_thumbnail", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0.0, -4.0, (lo + hi) / 2)
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = False
    scene.world = scene.world or bpy.data.worlds.new("World")
    scene.world.color = (0.66, 0.73, 0.80)
    path = os.path.join(out, f"{preset['name']}-thumbnail.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    image = bpy.data.images.load(path)
    image.pack()
    return image


EMOTIONS = ["happy", "angry", "sad", "relaxed", "surprised"]


def emotions(preset, body, rig, recipes, out):
    """The five emotions on this body's face, side by side (P.03: the owner accepts at least four
    of five on each body): each recipe's shape weights set on every part that has them, rendered
    from the front, then cleared."""
    import numpy as np
    scene = bpy.context.scene
    head = rig.matrix_world @ rig.data.bones["head"].head_local
    cam_data = bpy.data.cameras.new(f"{preset['name']}_face")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 0.36
    cam = bpy.data.objects.new(f"{preset['name']}_face", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (head.x, head.y - 2.0, head.z + 0.06)
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = scene.render.resolution_y = 256
    faces = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]
    panels = []
    for name in EMOTIONS:
        for obj in faces:
            for key in obj.data.shape_keys.key_blocks[1:]:
                key.value = recipes[name].get(key.name, 0.0)
        path = os.path.join(out, f".{preset['name']}-{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(path)
        panels.append(np.array(image.pixels[:], dtype=np.float32).reshape(256, 256, 4))
        bpy.data.images.remove(image)
        os.remove(path)
    for obj in faces:
        for key in obj.data.shape_keys.key_blocks[1:]:
            key.value = 0.0
    bpy.data.objects.remove(cam, do_unlink=True)
    sheet = bpy.data.images.new(f"{preset['name']}_emotions", 256 * len(panels), 256, alpha=False)
    sheet.pixels.foreach_set(np.concatenate(panels, axis=1).ravel())
    path = os.path.join(out, f"{preset['name']}-emotions.png")
    sheet.filepath_raw = path
    sheet.file_format = "PNG"
    sheet.save()
    bpy.data.images.remove(sheet)
    return path


def join_meshes(body):
    """One skinned mesh in the VRM (the rank counts skinned meshes: four would hold a kit at
    Medium); the .blend, saved before, keeps the parts apart for creators."""
    parts = [o for o in bpy.data.objects if o.type == "MESH" and o is not body]
    if not parts:
        return body
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts + [body]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    return body


def export(preset, rig, body, recipes, out):
    os.makedirs(out, exist_ok=True)
    # The .blend carries its images: a creator opens it anywhere.
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, f"{preset['name']}.blend"), compress=True, relative_remap=False)
    join_meshes(body)
    vrm(preset, body, rig, recipes)
    path = os.path.join(out, f"{preset['name']}.vrm")
    result = bpy.ops.export_scene.vrm(filepath=path, armature_object_name=rig.name, ignore_warning=True, export_try_sparse_sk=True)
    if "FINISHED" not in result:
        raise SystemExit(f"{preset['name']}: the VRM export answered {result}")
    return path


def main():
    out, only = args()
    os.makedirs(out, exist_ok=True)
    global LAYERS_OUT
    LAYERS_OUT = out
    enable_addons()
    HumanService, FaceService, TargetService, ExportService, LocationService = services()
    recipes = json.load(open(os.path.join(HERE, "expressions.json")))
    summary = {}
    for file in sorted(os.listdir(os.path.join(HERE, "presets"))):
        preset = json.load(open(os.path.join(HERE, "presets", file)))
        if only and preset["name"] != only:
            continue
        body, rig = build(preset, HumanService, FaceService, TargetService, ExportService, LocationService)
        dressed = underwear(body, rig, preset.get("underwear", []))
        dropped = keep_shapes(recipes)
        materials = toon(rig)
        marks = markers(rig)
        masks = regions(body)
        measured = measurements(body, rig)
        mapped, expressions = vrm(preset, body, rig, recipes)
        os.makedirs(out, exist_ok=True)
        from bl_ext.user_default.vrm.editor.extension_accessor import get_armature_extension
        get_armature_extension(rig.data).vrm1.meta.thumbnail_image = thumbnail(preset, body, out)
        emotions(preset, body, rig, recipes, out)
        meshes = sorted((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: o.name)
        parts = {o.name: {"vertices": len(o.data.vertices), "triangles": evaluated_triangles(o), "shapes": len(o.data.shape_keys.key_blocks) - 1 if o.data.shape_keys else 0} for o in meshes}
        path = export(preset, rig, body, recipes, out)
        summary[preset["name"]] = {
            "meshes": parts,
            "triangles": sum(p["triangles"] for p in parts.values()),
            "bones": len(rig.data.bones),
            "expressions": sorted(expressions),
            "humanoid": mapped,
            "underwearTexels": dressed,
            "shapesDropped": dropped,
            "materials": materials,
            "markers": marks,
            "regions": masks,
            "measurements": measured,
            "vrm": os.path.basename(path),
        }
        print(f"bodykit: {preset['name']}: {summary[preset['name']]['triangles']} triangles, {len(rig.data.bones)} bones, {len(expressions)} expressions")
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
        f.write("\n")
    print("bodykit: done")


# Run by Blender (--python), not when the wardrobe's fitting imports these steps (tools/blender/wardrobe/).
if __name__ == "__main__":
    main()
