"""Compare native single-primitive GLBs without rerunning inference.

Surface errors are deterministic area-weighted estimates, using bilinear level-0
texture sampling. They are not screen-space errors or a material-quality score.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from glb_metrics import parse_glb, read_accessor, image_bytes


def load(path: Path) -> dict:
    gltf, binary = parse_glb(path)
    if len(gltf["meshes"]) != 1 or len(gltf["meshes"][0]["primitives"]) != 1:
        raise ValueError("comparison requires one native mesh primitive")
    primitive = gltf["meshes"][0]["primitives"][0]
    if primitive.get("mode", 4) != 4:
        raise ValueError("comparison requires triangles")
    arrays = {k: read_accessor(gltf, binary, v) for k, v in primitive["attributes"].items()}
    arrays["indices"] = read_accessor(gltf, binary, primitive["indices"]).reshape(-1, 3)
    material = gltf["materials"][primitive["material"]]["pbrMetallicRoughness"]
    textures = {}
    for name, slot in (("base", "baseColorTexture"), ("mr", "metallicRoughnessTexture")):
        texture = gltf["textures"][material[slot]["index"]]
        source = texture.get("extensions", {}).get("EXT_texture_webp", {}).get("source", texture.get("source"))
        textures[name] = np.asarray(Image.open(io.BytesIO(image_bytes(gltf, binary, gltf["images"][source]))).convert("RGBA"))
    return {"arrays": arrays, "textures": textures}


def surface_hash(model: dict) -> str:
    triangles = np.ascontiguousarray(model["arrays"]["POSITION"][model["arrays"]["indices"]], dtype="<f4")
    # Ignore UV-driven vertex splits and triangle/vertex ordering, retain exact
    # triangle positions and multiplicity. This does not check winding.
    vertices = triangles.view("V12").reshape(-1, 3)
    vertices.sort(axis=1)
    rows = np.ascontiguousarray(vertices).view("V36").reshape(-1)
    rows.sort()
    return hashlib.sha256(rows.tobytes()).hexdigest()


def bilinear(image: np.ndarray, uv: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    xy = uv * [w, h] - 0.5
    ij = np.floor(xy).astype(np.int64)
    f = xy - ij
    x, y = ij[:, 0], ij[:, 1]
    fx, fy = f[:, 0:1], f[:, 1:2]
    # Native GLBs use the glTF default REPEAT sampler. No mipmaps or anisotropy.
    return ((1-fx)*(1-fy)*image[y % h, x % w] + fx*(1-fy)*image[y % h, (x+1) % w]
            + (1-fx)*fy*image[(y+1) % h, x % w] + fx*fy*image[(y+1) % h, (x+1) % w]) / 255.0


def barycentrics(samples: int) -> np.ndarray:
    def radical_inverse(i):
        v, p = 0.0, 0.5
        while i:
            v += (i & 1) * p
            i >>= 1
            p *= 0.5
        return v
    u = np.sqrt((np.arange(samples) + 0.5) / samples)
    v = np.array([radical_inverse(i) for i in range(samples)])
    return np.stack([1-u, u*(1-v), u*v], axis=1)


def compare(a: dict, b: dict, samples: int = 16) -> dict:
    if samples < 1:
        raise ValueError("samples must be positive")
    identity = {k: k in b["arrays"] and np.array_equal(v, b["arrays"][k]) for k, v in a["arrays"].items()}
    result = {"array_identity": identity, "surface_identity": surface_hash(a) == surface_hash(b),
              "faces": [len(m["arrays"]["indices"]) for m in (a, b)], "surface_errors": None}
    if not all(identity.get(k, False) for k in ("POSITION", "TEXCOORD_0", "indices")):
        return result
    arr = a["arrays"]
    tri = arr["POSITION"][arr["indices"]].astype(np.float64)
    area = np.linalg.norm(np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0]), axis=1) * 0.5
    if not np.isfinite(area).all() or area.sum() <= 0:
        raise ValueError("invalid surface area")
    bary = barycentrics(samples)
    totals = {k: {"absolute": np.zeros(4), "squared": np.zeros(4), "signed": np.zeros(4), "max": np.zeros(4)} for k in ("base", "mr")}
    for start in range(0, len(tri), 4096):
        end = min(start+4096, len(tri))
        texcoords = arr["TEXCOORD_0"][arr["indices"][start:end]]
        uv = np.einsum("sk,fkc->fsc", bary, texcoords).reshape(-1, 2)
        weights = np.repeat(area[start:end] / samples, samples)[:, None]
        for name, stats in totals.items():
            diff = bilinear(b["textures"][name], uv) - bilinear(a["textures"][name], uv)
            stats["absolute"] += (np.abs(diff)*weights).sum(axis=0)
            stats["squared"] += (diff*diff*weights).sum(axis=0)
            stats["signed"] += (diff*weights).sum(axis=0)
            if np.any(weights[:, 0] > 0):
                stats["max"] = np.maximum(stats["max"], np.max(np.abs(diff[weights[:, 0] > 0]), axis=0))
    result["surface_errors"] = {name: {"mae": (s["absolute"]/area.sum()).tolist(),
        "rmse": np.sqrt(s["squared"]/area.sum()).tolist(), "mean_signed_change": (s["signed"]/area.sum()).tolist(),
        "sampled_max_error": s["max"].tolist()} for name, s in totals.items()}
    result.update(samples_per_triangle=samples, surface_area=float(area.sum()),
                  method="deterministic equal-area triangle samples; bilinear level-0 REPEAT; RGBA channel order; encoded base RGB")
    return result


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("reference", type=Path)
    p.add_argument("candidate", type=Path)
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    report = compare(load(args.reference), load(args.candidate), args.samples)
    report.update(reference=args.reference.name, candidate=args.candidate.name)
    with args.output.open("x", encoding="utf-8") as f:
        json.dump(report, f, indent=2, allow_nan=False)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
