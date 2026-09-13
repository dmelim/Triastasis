"""Extract a native 4x3 box atlas for post-replay --fixed-box-mesh.

Preserves positions, UVs and triangle order; infers each face's original bucket
from its atlas cell. Rejects faces crossing cells. This is not a generic GLB
importer: use only native box exports with the documented coordinate transform.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
from compare_material_exports import load


def extract(path, output):
    model = load(path)
    a = model["arrays"]
    p, uv, faces = a["POSITION"], a["TEXCOORD_0"], a["indices"]
    t = model["textures"]["base"].shape[0]
    if model["textures"]["base"].shape != (t, t, 4) or t < 12:
        raise ValueError("expected square atlas")
    if not np.all(np.isfinite(p)) or not np.all(np.isfinite(uv)) or np.any(uv < 0) or np.any(uv >= 1):
        raise ValueError("invalid positions/UVs")
    cell = np.floor(uv*t/[t//4, t//3]).astype(np.int32)
    if np.any(cell < 0) or np.any(cell >= [4, 3]):
        raise ValueError("UV outside native box cells")
    buckets = cell[:, 1]*4+cell[:, 0]
    groups = buckets[faces]
    if not np.all(groups == groups[:, :1]):
        raise ValueError("face crosses box atlas cells")
    native = p[:, [0, 2, 1]].copy()
    native[:, 1] *= -1  # Inverse of native (x,y,z) -> glTF (x,z,-y).
    arrays = [native.astype("<f4"), uv.astype("<f4"), faces.astype("<i4"), groups[:, 0].astype("<i4")]
    with output.open("xb") as f:
        f.write(struct.pack("<3i", len(p), len(faces), t))
        for array in arrays:
            f.write(array.tobytes())
    with path.open("rb") as f:
        source_hash = hashlib.file_digest(f, "sha256").hexdigest()
    return {"source_sha256": source_hash, "vertices": len(p), "faces": len(faces), "atlas": t,
            "array_sha256": {k: hashlib.sha256(v.tobytes()).hexdigest() for k, v in a.items()},
            "bucket_face_counts": np.bincount(groups[:, 0], minlength=12).tolist()}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    print(json.dumps(extract(args.input, args.output), indent=2))
