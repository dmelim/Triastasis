"""Run in Blender: fixed-view surface points and UVs for native material probes.

Supports native single-mesh GLBs without object transforms. No rendering or
material changes: ray casts select the existing surface at pixel centres.
"""
import argparse
import json
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--line", type=float, nargs=4, metavar=("X0","Y0","X1","Y1"),
                        help="Subpixel line in the existing image's pixel-index coordinates")
    parser.add_argument("--samples", type=int, default=609)
    parser.add_argument("--view", choices=("front","back","left","right"), default="front")
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    if not 16 <= args.size <= 512:
        raise ValueError("size must be 16..512")
    if args.line and (not 2 <= args.samples <= 100000 or
                     not all(np.isfinite(v) and 0 <= v < args.size for v in args.line)):
        raise ValueError("invalid line or sample count")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if len(objects) != 1:
        raise ValueError("expected one native mesh")
    obj = objects[0]
    mesh = obj.data
    mesh.calc_loop_triangles()
    vertices = [obj.matrix_world @ v.co for v in mesh.vertices]
    triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
    uv_layer = mesh.uv_layers.active.data
    uvs = [[Vector((*uv_layer[l].uv, 0)) for l in t.loops] for t in mesh.loop_triangles]
    bvh = BVHTree.FromPolygons(vertices, triangles, all_triangles=True)
    low = Vector(tuple(min(v[a] for v in vertices) for a in range(3)))
    high = Vector(tuple(max(v[a] for v in vertices) for a in range(3)))
    center, dims = (low+high)*0.5, high-low
    span = max(dims)
    views = [
        ("front", Vector((center.x, low.y-span*2.4, center.z)), Vector((1,0,0)), Vector((0,1,0)), max(dims.x,dims.z)),
        ("back", Vector((center.x, high.y+span*2.4, center.z)), Vector((-1,0,0)), Vector((0,-1,0)), max(dims.x,dims.z)),
        ("left", Vector((low.x-span*2.4, center.y, center.z)), Vector((0,-1,0)), Vector((1,0,0)), max(dims.y,dims.z)),
        ("right", Vector((high.x+span*2.4, center.y, center.z)), Vector((0,1,0)), Vector((-1,0,0)), max(dims.y,dims.z)),
    ]
    records = {k: [] for k in ("view", "pixel", "point", "normal", "face", "uv")}
    for view, (name, camera, right, direction, width) in enumerate(views):
        if args.line and name != args.view:
            continue
        scale = max(width*1.18, 0.1)
        pixels = (zip(np.linspace(args.line[0],args.line[2],args.samples),
                      np.linspace(args.line[1],args.line[3],args.samples)) if args.line else
                  ((x,y) for y in range(args.size) for x in range(args.size)))
        for x,y in pixels:
            origin = camera + right*((x+0.5)/args.size-0.5)*scale + Vector((0,0,(0.5-(y+0.5)/args.size)*scale))
            point, normal, face, _ = bvh.ray_cast(origin, direction)
            if face is None:
                continue
            a,b,c = (vertices[i] for i in triangles[face])
            uv = barycentric_transform(point, a,b,c, *uvs[face])
            # Blender converts glTF Y-up to native TRELLIS Z-up on import.
            # glTF UV v is flipped by Blender; restore it for image lookup.
            for key, value in (("view",view),("pixel",(x,y)),("point",tuple(point)),
                ("normal",tuple(normal)),("face",face),("uv",(uv.x,1-uv.y))):
                records[key].append(value)
        print("Probed view:", name, flush=True)
    if args.line and len(records["point"]) != args.samples:
        raise ValueError("line leaves the surface; select an interior line")
    arrays = {k: np.asarray(v, dtype=np.int32 if k in ("view","face") or (k=="pixel" and not args.line) else np.float32) for k,v in records.items()}
    np.savez_compressed(args.output_dir/"surface.npz", **arrays)
    np.savetxt(args.output_dir/"points.txt", arrays["point"], fmt="%.9g")
    (args.output_dir/"camera.json").write_text(json.dumps({"size":args.size,"views":[v[0] for v in views],
        "blender":bpy.app.version_string,"bounds":[list(low),list(high)],"line":args.line,"line_view":args.view if args.line else None,
        "method":"orthographic rays at pixel-index coordinates plus 0.5; nearest triangle; native Z-up points; glTF UVs"},indent=2))
    print("Saved", len(arrays["point"]), "surface points", flush=True)


if __name__ == "__main__":
    main()
