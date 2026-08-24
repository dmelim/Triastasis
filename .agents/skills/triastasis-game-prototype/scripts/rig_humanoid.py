from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args_after_separator() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply an agent-authored humanoid rig to a GLB")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    return parser.parse_args(args_after_separator())


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def validate_spec(spec: dict) -> list[dict]:
    bones = spec.get("bones")
    if not isinstance(bones, list) or not bones:
        raise ValueError("Rig specification must contain a nonempty bones array")
    names: set[str] = set()
    for bone in bones:
        name = bone.get("name")
        if not isinstance(name, str) or not name or name in names:
            raise ValueError(f"Invalid or duplicate bone name: {name!r}")
        names.add(name)
        for key in ("head", "tail"):
            value = bone.get(key)
            if not isinstance(value, list) or len(value) != 3:
                raise ValueError(f"Bone {name} requires a three-number {key}")
        if (Vector(bone["tail"]) - Vector(bone["head"])).length <= 1e-6:
            raise ValueError(f"Bone {name} has zero length")
    for bone in bones:
        parent = bone.get("parent")
        if parent and parent not in names:
            raise ValueError(f"Bone {bone['name']} references missing parent {parent}")
    return bones


def create_armature(spec: dict, bones: list[dict]) -> bpy.types.Object:
    armature_data = bpy.data.armatures.new(spec.get("name") or "CharacterRig")
    armature = bpy.data.objects.new(armature_data.name, armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    armature.show_in_front = True
    bpy.ops.object.mode_set(mode="EDIT")
    created: dict[str, bpy.types.EditBone] = {}
    for entry in bones:
        bone = armature_data.edit_bones.new(entry["name"])
        bone.head = Vector(entry["head"])
        bone.tail = Vector(entry["tail"])
        bone.use_deform = bool(entry.get("deform", True))
        created[entry["name"]] = bone
    for entry in bones:
        parent = entry.get("parent")
        if parent:
            created[entry["name"]].parent = created[parent]
            created[entry["name"]].use_connect = bool(entry.get("connect", False))
    bpy.ops.object.mode_set(mode="OBJECT")
    return armature


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def weight_summary(meshes: list[bpy.types.Object], deform_names: set[str]) -> dict:
    weighted = 0
    unweighted = 0
    for obj in meshes:
        group_names = {group.index: group.name for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            total = sum(item.weight for item in vertex.groups if group_names.get(item.group) in deform_names)
            if total > 1e-6:
                weighted += 1
            else:
                unweighted += 1
    return {"weightedVertices": weighted, "unweightedVertices": unweighted, "totalVertices": weighted + unweighted}


def automatic_weights(meshes: list[bpy.types.Object], armature: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def point_segment_distance(point: Vector, head: Vector, tail: Vector) -> float:
    segment = tail - head
    length_squared = segment.length_squared
    if length_squared <= 1e-12:
        return (point - head).length
    amount = max(0.0, min(1.0, (point - head).dot(segment) / length_squared))
    return (point - (head + segment * amount)).length


def rigid_weights(meshes: list[bpy.types.Object], armature: bpy.types.Object, bones: list[dict]) -> None:
    deform = [entry for entry in bones if entry.get("deform", True)]
    segments = [(entry["name"], Vector(entry["head"]), Vector(entry["tail"])) for entry in deform]
    if not segments:
        raise ValueError("Rig has no deforming bones")

    for obj in meshes:
        world_matrix = obj.matrix_world.copy()
        for group in list(obj.vertex_groups):
            if group.name in {name for name, _, _ in segments}:
                obj.vertex_groups.remove(group)
        groups = {name: obj.vertex_groups.new(name=name) for name, _, _ in segments}
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            nearest = min(segments, key=lambda item: point_segment_distance(world, item[1], item[2]))
            groups[nearest[0]].add([vertex.index], 1.0, "REPLACE")
        obj.parent = armature
        obj.matrix_world = world_matrix
        for modifier in list(obj.modifiers):
            if modifier.type == "ARMATURE":
                obj.modifiers.remove(modifier)
        modifier = obj.modifiers.new(name="CharacterRig", type="ARMATURE")
        modifier.object = armature


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path.resolve()),
        export_format="GLB",
        export_materials="EXPORT",
        export_skins=True,
        export_animations=True,
    )


def main() -> None:
    args = parse_args()
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    bones = validate_spec(spec)
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError("The GLB contains no mesh objects")
    for existing in [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]:
        bpy.data.objects.remove(existing, do_unlink=True)

    armature = create_armature(spec, bones)
    deform_names = {entry["name"] for entry in bones if entry.get("deform", True)}
    requested = spec.get("skin", "automatic")
    if requested not in {"automatic", "rigid"}:
        raise ValueError("skin must be automatic or rigid")

    applied = requested
    fallback_reason = None
    if requested == "automatic":
        try:
            automatic_weights(meshes, armature)
            summary = weight_summary(meshes, deform_names)
            if summary["unweightedVertices"]:
                raise RuntimeError(f"bone heat left {summary['unweightedVertices']} vertices unweighted")
        except Exception as error:
            fallback_reason = str(error)
            applied = "rigid"
            rigid_weights(meshes, armature, bones)
    else:
        rigid_weights(meshes, armature, bones)

    summary = weight_summary(meshes, deform_names)
    export_glb(args.output)
    report = {
        "input": str(args.input.resolve()),
        "output": str(args.output.resolve()),
        "spec": str(args.spec.resolve()),
        "blenderVersion": bpy.app.version_string,
        "armature": armature.name,
        "bones": len(bones),
        "deformingBones": len(deform_names),
        "meshObjects": len(meshes),
        "requestedSkin": requested,
        "appliedSkin": applied,
        "fallbackReason": fallback_reason,
        **summary,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if summary["unweightedVertices"]:
        raise RuntimeError("Rig export contains unweighted vertices")


if __name__ == "__main__":
    main()
