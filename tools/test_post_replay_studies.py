"""Native replay regression: ordered binary header, same-bake codec pairs and UV studies."""
import argparse
import csv
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
from compare_material_exports import load, compare


def main():
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="replay-study-", dir=args.scratch.resolve()))
    coords = np.array([[x,y,4] for x in range(8) for y in range(8)], dtype="<i4")
    vertices = np.array([[-.25,-.25,.0625],[.25,-.25,.0625],[0,.25,.0625]], dtype="<f4")
    # Distinct header values catch the unspecified fread evaluation-order bug.
    dump = root / "input.bin"
    dump.write_bytes(struct.pack("<4i",3,1,64,8) + vertices.tobytes() + struct.pack("<3i",0,1,2)
        + coords.tobytes() + np.tile(np.array([.2,.4,.6,.8,.3,1], dtype="<f4"), (64,1)).tobytes())
    env = os.environ.copy()
    env["TRIASTASIS_DIAGNOSTICS"] = "1"
    env["TRIASTASIS_DIAGNOSTICS_DIR"] = str(root)
    command = [str(args.replay.resolve()), str(dump), str(root / "output.glb"),
        "--box-uv", "--no-remesh", "--no-weld", "--no-fill", "--decim", "0", "--atlas", "32"]
    for mode in ("--codec-study", "--sampling-study"):
        result = subprocess.run(command+[mode], env=env, capture_output=True, timeout=60,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        (root / (mode[2:]+".log")).write_bytes(result.stdout+result.stderr)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
    png, webp = load(root / "output.glb.png.glb"), load(root / "output.glb")
    assert all(compare(png, webp)["array_identity"].values())
    for name in ("base", "mr"):
        raw = (root / f"output.glb.{name}.rgba").read_bytes()
        assert png["textures"][name].tobytes() == raw, "PNG changed baked bytes"
    box = load(root / "output.glb.box-default.glb")
    projected = load(root / "output.glb.box-project-first.glb")
    assert all(compare(box, projected)["array_identity"].values())
    # There is no change when the final and original surfaces coincide and the
    # sparse field is constant; the opt-in sampler must preserve this case.
    assert all(np.array_equal(box["textures"][k], projected["textures"][k]) for k in ("base", "mr"))
    invalid = subprocess.run(command+["--sampling-study", "--no-snap"], env=env, capture_output=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert invalid.returncode == 2
    probe_points = root / "points.txt"
    probe_points.write_text("0 0 0.125\n0 0 0.3125\n", encoding="utf-8")
    probe_output = root / "probes.csv"
    probe_command = [str(args.replay.resolve()), str(dump), str(probe_output),
                     "--no-weld", "--no-fill", "--probe-points", str(probe_points)]
    def run_probe():
        return subprocess.run(probe_command, env=env, capture_output=True, timeout=30,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    probe = run_probe()
    (root / "probe.log").write_bytes(probe.stdout+probe.stderr)
    assert probe.returncode == 0, probe.stderr.decode(errors="replace")
    with probe_output.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 2
    assert float(rows[0]["direct_support"]) == .5
    assert float(rows[0]["projected_support"]) == 1
    assert float(rows[0]["distance_voxels"]) == .5
    assert rows[1]["direct_valid"] == "0" and rows[1]["projected_valid"] == "1"
    saved = probe_output.read_bytes()
    assert run_probe().returncode == 2 and probe_output.read_bytes() == saved
    probe_command[2] = str(root / "invalid-probe.csv")
    probe_points.write_text("0 0", encoding="utf-8")
    assert run_probe().returncode == 2 and not Path(probe_command[2]).exists()
    print(f"Replay studies passed; synthetic outputs: {root}")


if __name__ == "__main__":
    main()
