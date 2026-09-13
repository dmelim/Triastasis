"""Compare texture-decoder traces with identical inputs and coordinate order.

Reports normalized material differences and reuses a saved corner trace for a
fixed sampling line. These are voxel/sample statistics, not perceptual scores.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

CHANNELS = ("r", "g", "b", "metallic", "roughness", "alpha")
IDENTICAL_FILES = ["input.coords.i32", "input.latent.f32"] + [
    f"{prefix}-{i}.{suffix}" for i in range(4)
    for prefix, suffix in (("guide", "u8"), ("stage", "coords.i32"))]


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def load_trace(path, reference):
    for name in IDENTICAL_FILES:
        if digest(path/name) != digest(reference/name):
            raise ValueError(f"fixed input/order changed: {name}")
    rows = (path/"stage-3.coords.i32").stat().st_size // 12
    raw = np.fromfile(path/"output.raw.f32", dtype="<f4")
    if not rows or raw.size != rows*6 or not np.all(np.isfinite(raw)):
        raise ValueError("invalid decoder output")
    return np.clip(raw.reshape(rows, 6)*np.float32(.5)+np.float32(.5), 0, 1)


def resample(values, trace):
    """Preserve native sequential float32 sums using fixed corner IDs/weights."""
    ids, active = trace["ids"], trace["active"]
    if np.any(ids[active] < 0) or np.any(ids[active] >= len(values)):
        raise ValueError("corner IDs outside decoder output")
    acc = np.zeros((len(ids), 6), dtype=np.float32)
    for corner in range(8):
        weight = np.where(active[:, corner], trace["weights"][:, corner], np.float32(0))
        acc += weight[:, None]*values[np.maximum(ids[:, corner], 0)]
    return np.divide(acc, trace["support"][:, None], out=np.zeros_like(acc),
                     where=trace["valid"][:, None])


def errors(actual, reference):
    delta = np.abs(actual.astype(np.float64)-reference)
    return {channel: {"mae": float(delta[:, i].mean()),
                      "p95_abs": float(np.quantile(delta[:, i], .95)),
                      "max_abs": float(delta[:, i].max())}
            for i, channel in enumerate(CHANNELS)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--reference", type=Path, required=True)
    p.add_argument("--variant", action="append", required=True, help="label=trace-directory")
    p.add_argument("--corners", type=Path, required=True)
    p.add_argument("--points", type=Path, required=True)
    p.add_argument("--bright-index", type=int, required=True)
    p.add_argument("--dark-index", type=int, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    args = p.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    reference = load_trace(args.reference, args.reference)
    trace = np.load(args.corners)
    points = np.load(args.points)
    coords = np.fromfile(args.reference/"stage-3.coords.i32", dtype="<i4").reshape(-1, 3)
    active = trace["active"]
    if not np.array_equal(coords[trace["ids"][active]], trace["locations"][active]):
        raise ValueError("corner coordinate pairing differs")
    baseline = resample(reference, trace)
    if not np.array_equal(baseline, trace["result"]):
        raise ValueError("saved sampling trace differs from reference material")
    if len(points["pixel"]) != len(baseline):
        raise ValueError("point count mismatch")
    luma_weights = np.array([.2126, .7152, .0722])
    line_data = {"x": points["pixel"][:, 0], "reference": baseline}
    report = {"voxel_count": len(reference), "sample_count": len(baseline),
              "bright_index": args.bright_index, "dark_index": args.dark_index,
              "measure": "code-value luma (not linear-light luminance)", "variants": {}}
    for item in args.variant:
        label, path = item.split("=", 1)
        if label in line_data or not label.replace("-", "").isalnum():
            raise ValueError("duplicate or invalid variant label")
        values = load_trace(Path(path), args.reference)
        samples = resample(values, trace)
        line_data[label] = samples
        luma = samples[:, :3] @ luma_weights
        baseline_luma = baseline[:, :3] @ luma_weights
        report["variants"][label] = {
            "inputs_and_coordinate_order_bit_identical": True,
            "raw_output_sha256": digest(Path(path)/"output.raw.f32"),
            "raw_output_bit_identical_to_reference": digest(Path(path)/"output.raw.f32") == digest(args.reference/"output.raw.f32"),
            "material_bit_identical_to_reference": np.array_equal(values, reference),
            "volume_channel_error_vs_reference": errors(values, reference),
            "selected_band_contrast": float(luma[args.bright_index]-luma[args.dark_index]),
            "selected_bright_luma": float(luma[args.bright_index]),
            "selected_dark_luma": float(luma[args.dark_index]),
            "line_luma_mae_vs_reference": float(np.abs(luma-baseline_luma).mean()),
            "line_luma_max_abs_vs_reference": float(np.abs(luma-baseline_luma).max())}
    np.savez_compressed(args.output_dir/"line.npz", **line_data)
    (args.output_dir/"comparison.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
