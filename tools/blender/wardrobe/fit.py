# SPDX-License-Identifier: GPL-3.0-or-later
"""The starter wardrobe's fitting (Track P's P.08): MakeHuman's CC0 garments on the three bodies.

Each body is built as the body kit generator builds it (tools/blender/bodykit/generate.py, its
presets: the macros, the targets baked, the game_engine rig), and every garment named is added to it
by MPFB before the helpers go, since its fitting follows them: a garment's vertices sit on the body's
own surface, so the same garment fits each body at authoring time (dp-001), never at runtime. The
body is then exported with every garment through the VRM add-on, which writes the T-pose skeleton
the kit's VRM has; each garment is a skinned mesh of its own, with MPFB's weights from the body.

Beside each body's VRM, <body>-garments.json says, for each garment, what share of each hide-mask
region's vertices lies under it: the vertices of its delete group, MakeHuman's own record of what a
garment covers. The body's helper geometry is left out of the count.

    blender --background --python fit.py -- --out DIR --garments a,b,c [--only NAME]
"""
import json
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bodykit"))
sys.dont_write_bytecode = True  # no __pycache__ left in the repository
import generate  # noqa: E402 - the kit generator's steps, so the bodies are built the same way


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out, garments, only = None, [], None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out = argv[i + 1]
        elif argv[i] == "--garments":
            garments = [g for g in argv[i + 1].split(",") if g]
        elif argv[i] == "--only":
            only = argv[i + 1]
        else:
            raise SystemExit(f"unknown argument {argv[i]}")
        i += 2
    if not out or not garments:
        raise SystemExit("usage: fit.py -- --out DIR --garments a,b,c [--only NAME]")
    return out, garments, only


def members(body, group_name):
    g = body.vertex_groups.get(group_name)
    if g is None:
        return set()
    return {v.index for v in body.data.vertices if any(x.group == g.index and x.weight > 0 for x in v.groups)}


def coverage(body, garments):
    """Each garment's share of each region, over the body's own vertices (the helpers left out)."""
    hide = next((m for m in body.modifiers if m.type == "MASK" and m.name == "Hide helpers"), None)
    every = {v.index for v in body.data.vertices}
    own = every
    if hide is not None and hide.vertex_group:
        inside = members(body, hide.vertex_group)
        own = every - inside if hide.invert_vertex_group else inside
    groups = {g.index: g.name for g in body.vertex_groups}
    owner = {bone: region for region, bones in generate.REGIONS.items() for bone in bones}
    regions = {region: set() for region in generate.REGIONS}
    for v in body.data.vertices:
        if v.index not in own:
            continue
        best, weight = None, 0.0
        for g in v.groups:
            name = groups.get(g.group)
            if name in owner and g.weight > weight:
                best, weight = name, g.weight
        if best:
            regions[owner[best]].add(v.index)
    out = {}
    for garment in garments:
        mask = body.modifiers.get(f"Delete.{garment}")
        # MPFB's delete mask hides its group's vertices (the mask is inverted): the group is what goes.
        deleted = members(body, mask.vertex_group) if mask is not None and mask.vertex_group else set()
        out[garment] = {region: round(len(verts & deleted) / len(verts), 4) for region, verts in regions.items() if verts}
    return out


def main():
    out, garments, only = args()
    os.makedirs(out, exist_ok=True)
    generate.enable_addons()
    HumanService, FaceService, TargetService, ExportService, LocationService = generate.services()
    for file in sorted(os.listdir(os.path.join(HERE, "..", "bodykit", "presets"))):
        preset = json.load(open(os.path.join(HERE, "..", "bodykit", "presets", file)))
        if only and preset["name"] != only:
            continue
        generate.clear_scene()
        body = HumanService.create_human(macro_detail_dict=dict(preset["macros"]))
        body.name = f"{preset['name']}_body"
        TargetService.bake_targets(body)
        rig = HumanService.add_builtin_rig(body, "game_engine")
        rig.name = f"{preset['name']}_rig"
        for name in garments:
            before = set(bpy.data.objects)
            HumanService.add_mhclo_asset(generate.asset(LocationService, "clothes", name, "mhclo"), body, asset_type="Clothes", subdiv_levels=0, material_type="GAMEENGINE")
            made = [o for o in set(bpy.data.objects) - before if o.type == "MESH"]
            if len(made) != 1:
                raise SystemExit(f"{preset['name']}: {name} added {len(made)} meshes")
            made[0].name = name
            made[0].data.name = name
        covered = coverage(body, garments)
        # The body's helpers go; its delete masks stay unapplied (the body is not what is kept).
        ExportService.bake_modifiers_remove_helpers(body, bake_masks=False, bake_subdiv=False, remove_helpers=True, also_proxy=True)
        generate.vrm(preset, body, rig, {})
        path = os.path.join(out, f"{preset['name']}.vrm")
        result = bpy.ops.export_scene.vrm(filepath=path, armature_object_name=rig.name, ignore_warning=True)
        if "FINISHED" not in result:
            raise SystemExit(f"{preset['name']}: the VRM export answered {result}")
        with open(os.path.join(out, f"{preset['name']}-garments.json"), "w") as f:
            json.dump(covered, f, indent=1, sort_keys=True)
            f.write("\n")
        print(f"wardrobe: {preset['name']}: {len(garments)} garments")
    print("wardrobe: done")


if __name__ == "__main__":
    main()
