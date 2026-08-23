#!/usr/bin/env python3
"""Extended plane-attachment metrics over reconstruction outputs.

Goes beyond bounding-box thin ratio toward a `background-sheet` detector:
per-axis depth ratios plus vertex concentration in narrow slabs along the
thinnest axis. Reads every run directory under
assets/reconstruction-test-set/runs that contains model.glb files and prints
a combined table for threshold selection.
"""
import json
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "assets" / "reconstruction-test-set" / "runs"

COMP_F32 = 5126
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def component_count(ctype: str) -> int:
    return NCOMP[ctype]


def load_positions(data: bytes, gltf: dict):
    """Returns list of (x,y,z) floats from the first POSITION accessor."""
    bin_chunk = b""
    offset = 12
    while offset + 8 <= len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        body = data[offset + 8 : offset + 8 + length]
        if chunk_type == 0x004E4942:
            bin_chunk = body
        offset += 8 + length
    accessors = gltf.get("accessors", [])
    buffer_views = gltf.get("bufferViews", [])

    positions = []
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index = primitive.get("attributes", {}).get("POSITION")
            if index is None or index >= len(accessors):
                continue
            accessor = accessors[index]
            view = buffer_views[accessor["bufferView"]]
            stride = view.get("byteStride", 12)
            count = accessor["count"]
            base = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            ncomp = component_count(accessor["type"])
            assert accessor["componentType"] == COMP_F32, "only f32 positions supported"
            for i in range(count):
                start = base + i * stride
                xyz = struct.unpack_from("<fff", bin_chunk, start)
                positions.append(xyz[:ncomp])
    return positions


def analyze(glb_path: Path) -> dict | None:
    data = glb_path.read_bytes()
    if data[:4] != b"glTF":
        return None
    offset, gltf = 12, None
    while offset + 8 <= len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(data[offset + 8 : offset + 8 + length].rstrip(b"\0 "))
        offset += 8 + length
    try:
        positions = load_positions(data, gltf)
    except Exception as error:
        return {"error": str(error)}
    if not positions:
        return None

    xs = [p[0] for p in positions]
    ys = [p[1] for p in positions]
    zs = [p[2] for p in positions]
    mins = [min(xs), min(ys), min(zs)]
    maxs = [max(xs), max(ys), max(zs)]
    dims = [maxs[i] - mins[i] for i in range(3)]
    largest = max(dims)
    if largest <= 0:
        return None

    axes = ["x", "y", "z"]
    depth_ratios = {axes[i]: round(dims[i] / largest, 4) for i in range(3)}
    thin_axis = dims.index(min(dims))
    coords = sorted((xs, ys, zs)[thin_axis])
    thickness = dims[thin_axis]

    # Fraction of vertices inside narrow slabs along the thinnest axis.
    def slab_share(fraction: float) -> float:
        band = thickness * fraction
        best = current = 0
        left = 0
        for right in range(len(coords)):
            if coords[right] - coords[left] > band:
                while coords[right] - coords[left] > band:
                    left += 1
            current = right - left + 1
            best = max(best, current)
        return round(best / len(coords), 4)

    return {
        "file": str(glb_path),
        "vertices": len(positions),
        "dimensions": {axes[i]: round(dims[i], 4) for i in range(3)},
        "depthRatios": depth_ratios,
        "thinAxis": axes[thin_axis],
        "thinRatio": round(thickness / largest, 5),
        "slabShare5pct": slab_share(0.05),
        "slabShare10pct": slab_share(0.10),
        "fileSizeMB": round(glb_path.stat().st_size / 1e6, 2),
    }


def main() -> int:
    rows = []
    for run_dir in sorted(RUNS.iterdir()):
        if not run_dir.is_dir():
            continue
        for glb in sorted(run_dir.glob("*/model.glb")):
            result = analyze(glb)
            if result:
                result["run"] = run_dir.name
                result["case"] = glb.parent.name
                rows.append(result)

    header = (
        f"{'run':24} {'case':22} {'verts':>8} {'thin':>7} "
        f"{'slab5%':>7} {'slab10%':>7} {'sizeMB':>7}"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            f"{row['run']:24} {row['case']:22} {row['vertices']:>8} "
            f"{row['thinRatio']:>7} {row['slabShare5pct']:>7} "
            f"{row['slabShare10pct']:>7} {row['fileSizeMB']:>7}"
        )
    out = RUNS / "plane-metrics.json"
    out.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print(f"\n{len(rows)} models analyzed -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
