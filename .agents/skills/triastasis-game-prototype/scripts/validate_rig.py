from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def cli_args() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render deformation poses and validate a rigged GLB")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--poses", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--max-unweighted-ratio", type=float, default=0.001)
    return parser.parse_args(cli_args())


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        raise RuntimeError("The GLB contains no mesh geometry")
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return low, high


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_render(output_dir: Path, size: int, low: Vector, high: Vector) -> None:
    scene = bpy.context.scene
    engines = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world.color = (0.055, 0.06, 0.075)
    center = (low + high) * 0.5
    dimensions = high - low
    span = max(max(dimensions), 0.1)

    camera_data = bpy.data.cameras.new("ValidationCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(max(dimensions.x, dimensions.z) * 1.25, 0.1)
    camera = bpy.data.objects.new("ValidationCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = Vector((center.x, low.y - span * 2.5, center.z))
    look_at(camera, center)
    scene.camera = camera

    for name, offset, energy in (
        ("Key", Vector((-span, -span, span * 1.4)), 1000.0),
        ("Fill", Vector((span, -span * 0.4, span * 0.7)), 650.0),
        ("Rim", Vector((0, span, span * 1.2)), 850.0),
    ):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = span
        light = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(light)
        light.location = center + offset
        look_at(light, center)
    output_dir.mkdir(parents=True, exist_ok=True)


def weight_summary(objects: list[bpy.types.Object], deform_names: set[str]) -> dict:
    weighted = 0
    unweighted = 0
    for obj in objects:
        names = {group.index: group.name for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            total = sum(item.weight for item in vertex.groups if names.get(item.group) in deform_names)
            if total > 1e-6:
                weighted += 1
            else:
                unweighted += 1
    return {"weightedVertices": weighted, "unweightedVertices": unweighted, "totalVertices": weighted + unweighted}


def clear_pose(armature: bpy.types.Object) -> None:
    for bone in armature.pose.bones:
        bone.location = (0.0, 0.0, 0.0)
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = (0.0, 0.0, 0.0)
        bone.scale = (1.0, 1.0, 1.0)


def apply_pose(armature: bpy.types.Object, pose: dict) -> list[str]:
    clear_pose(armature)
    missing: list[str] = []
    for bone_name, values in pose.get("bones", {}).items():
        bone = armature.pose.bones.get(bone_name)
        if bone is None:
            missing.append(bone_name)
            continue
        rotation = values.get("rotationDegrees", [0.0, 0.0, 0.0])
        location = values.get("location", [0.0, 0.0, 0.0])
        if len(rotation) != 3 or len(location) != 3:
            raise ValueError(f"Pose values for {bone_name} must contain three components")
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = tuple(math.radians(float(value)) for value in rotation)
        bone.location = tuple(float(value) for value in location)
    bpy.context.view_layer.update()
    return missing


def main() -> None:
    args = parse_args()
    pose_spec = json.loads(args.poses.read_text(encoding="utf-8"))
    poses = pose_spec.get("poses")
    if not isinstance(poses, list) or len(poses) < 3:
        raise ValueError("Pose specification must contain at least three poses")

    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"Expected exactly one armature, found {len(armatures)}")
    armature = armatures[0]
    objects = mesh_objects()
    low, high = world_bounds(objects)
    setup_render(args.output_dir, args.size, low, high)
    deform_names = {bone.name for bone in armature.data.bones if bone.use_deform}
    weights = weight_summary(objects, deform_names)

    results = []
    for index, pose in enumerate(poses):
        name = str(pose.get("name") or f"pose-{index + 1}")
        safe_name = "".join(char if char.isalnum() or char in "-_" else "-" for char in name)
        missing = apply_pose(armature, pose)
        render_path = args.output_dir / f"{safe_name}.png"
        bpy.context.scene.render.filepath = str(render_path)
        bpy.ops.render.render(write_still=True)
        results.append({"name": name, "missingBones": missing, "render": str(render_path.resolve())})

    report = {
        "input": str(args.input.resolve()),
        "poses": str(args.poses.resolve()),
        "armature": armature.name,
        "bones": len(armature.data.bones),
        "deformingBones": len(deform_names),
        **weights,
        "weightedRatio": weights["weightedVertices"] / max(weights["totalVertices"], 1),
        "maxUnweightedRatio": args.max_unweighted_ratio,
        "results": results,
    }
    report_path = args.output_dir / "validation-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    unweighted_ratio = weights["unweightedVertices"] / max(weights["totalVertices"], 1)
    if unweighted_ratio > args.max_unweighted_ratio:
        raise RuntimeError(f"Unweighted ratio {unweighted_ratio:.6f} exceeds {args.max_unweighted_ratio:.6f}")
    if any(result["missingBones"] for result in results):
        raise RuntimeError("One or more validation poses referenced missing bones")


if __name__ == "__main__":
    main()
