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
    parser = argparse.ArgumentParser(description="Inspect and render a GLB in Blender")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--size", type=int, default=512)
    return parser.parse_args(args_after_separator())


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        raise RuntimeError("The GLB contains no mesh geometry")
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return low, high


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def configure_render(size: int) -> None:
    scene = bpy.context.scene
    engines = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.055, 0.06, 0.075)
    scene.view_settings.look = "AgX - Medium High Contrast"


def add_lighting(center: Vector, span: float) -> None:
    for name, offset, energy in (
        ("Key", Vector((-span, -span, span * 1.4)), 1000.0),
        ("Fill", Vector((span, -span * 0.4, span * 0.7)), 650.0),
        ("Rim", Vector((0, span, span * 1.2)), 850.0),
    ):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = span
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = center + offset
        look_at(obj, center)


def render_views(output_dir: Path, low: Vector, high: Vector) -> None:
    center = (low + high) * 0.5
    dims = high - low
    span = max(max(dims), 0.1)
    camera_data = bpy.data.cameras.new("InspectionCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("InspectionCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    add_lighting(center, span)

    views = {
        "front": (Vector((center.x, low.y - span * 2.4, center.z)), max(dims.x, dims.z)),
        "back": (Vector((center.x, high.y + span * 2.4, center.z)), max(dims.x, dims.z)),
        "left": (Vector((low.x - span * 2.4, center.y, center.z)), max(dims.y, dims.z)),
        "right": (Vector((high.x + span * 2.4, center.y, center.z)), max(dims.y, dims.z)),
    }
    for name, (position, visible_span) in views.items():
        camera.location = position
        camera_data.ortho_scale = max(visible_span * 1.18, 0.1)
        look_at(camera, center)
        bpy.context.scene.render.filepath = str(output_dir / f"{name}.png")
        bpy.ops.render.render(write_still=True)


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    meshes = mesh_objects()
    for obj in meshes:
        obj.data.calc_loop_triangles()
    low, high = bounds(meshes)
    configure_render(args.size)
    render_views(args.output_dir, low, high)

    images: set[str] = set()
    for material in bpy.data.materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                images.add(node.image.name)
    image_names = sorted(images)
    report = {
        "input": str(args.input.resolve()),
        "blenderVersion": bpy.app.version_string,
        "coordinateSystem": "Blender Z-up; front preview looks from -Y toward +Y",
        "bounds": {"min": list(low), "max": list(high), "center": list((low + high) * 0.5), "dimensions": list(high - low)},
        "totals": {
            "meshObjects": len(meshes),
            "vertices": sum(len(obj.data.vertices) for obj in meshes),
            "triangles": sum(len(obj.data.loop_triangles) for obj in meshes),
            "materials": len(bpy.data.materials),
            "images": len(image_names),
        },
        "meshes": [
            {
                "name": obj.name,
                "vertices": len(obj.data.vertices),
                "polygons": len(obj.data.polygons),
                "materials": [slot.material.name for slot in obj.material_slots if slot.material],
            }
            for obj in meshes
        ],
        "images": image_names,
        "renders": {name: str((args.output_dir / f"{name}.png").resolve()) for name in ("front", "back", "left", "right")},
    }
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
