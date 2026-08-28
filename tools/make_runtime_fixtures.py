#!/usr/bin/env python3
"""Builds the 18-case runtime validation fixture set for `.triastasis.json`
import/recovery testing. Output goes outside any real gallery (default:
%TEMP%/triastasis-runtime-fixtures) so the packaged app can be pointed at it
without touching production data.

Uses the repository's small sample image and generates minimal valid GLBs, so
the fixture matrix does not depend on a private reconstruction corpus. Every
directory is named for the behavior it exercises; RUNTIME-FIXTURES.md inside
the output documents what each case must show in the app.
"""
import argparse
import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_INPUT = REPO_ROOT / "assets" / "goblin.png"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write(path: Path, text: str) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def base_manifest() -> dict:
    return {
        "schemaVersion": 1,
        "status": "completed",
        "label": "fixture",
        "sourceImage": "source.png",
        "model": "model.glb",
        "cutout": None,
        "thumbnail": None,
        "log": None,
        "resolution": 512,
        "seed": 42,
        "bgRemoval": "auto",
        "uv": "xatlas",
        "texture": True,
        "jobId": "fixture-job",
        "nativeRequestId": "fixture-req",
        "assetId": "fixture-asset",
        "versionId": "fixture-version",
        "parentVersionId": None,
        "submittedAtUtc": "2026-08-22T00:00:00Z",
        "startedAtUtc": "2026-08-22T00:00:01Z",
        "finishedAtUtc": "2026-08-22T00:00:31Z",
        "durationSeconds": 30.0,
        "triastasisVersion": None,
        "serverVersion": None,
        "metrics": {
            "dimensions": {"x": 0.61, "y": 0.92, "z": 1.0},
            "triangles": None,
            "fileSizeBytes": None,
            "thinRatio": 0.61,
        },
        "qualityWarning": None,
        "error": None,
        "files": [
            {"role": "sourceImage", "path": "source.png", "sha256": ""},
            {"role": "glb", "path": "model.glb", "sha256": ""},
        ],
    }


def finalize(case_dir: Path, manifest: dict) -> None:
    """Fills hashes for whatever referenced files actually exist."""
    for entry in manifest["files"]:
        f = case_dir / entry["path"]
        if f.is_file():
            entry["sha256"] = sha256_file(f)
    atomic_write(case_dir / "model.triastasis.json", json.dumps(manifest, indent=2, ensure_ascii=False))


def synthetic_large_glb(target: Path, mb: int) -> None:
    """A genuinely valid GLB whose BIN chunk pads it to ~`mb` MB."""
    json_body = b'{"asset":{"version":"2.0"},"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],"meshes":[{"primitives":[]}]}'
    json_body += b" " * ((4 - len(json_body) % 4) % 4)
    bin_padding = b"\x00" * (mb * 1024 * 1024)
    total = 12 + 8 + len(json_body) + 8 + len(bin_padding)
    with target.open("wb") as handle:
        handle.write(b"glTF")
        handle.write(struct.pack("<II", 2, total))
        handle.write(struct.pack("<II", len(json_body), 0x4E4F534A))
        handle.write(json_body)
        handle.write(struct.pack("<II", len(bin_padding), 0x004E4942))
        handle.write(bin_padding)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path.home() / "AppData" / "Local" / "Temp" / "triastasis-runtime-fixtures"
        if sys.platform == "win32"
        else Path("/tmp/triastasis-runtime-fixtures"),
    )
    args = parser.parse_args()
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    input_source = SAMPLE_INPUT
    assert input_source.is_file(), f"sample input not found: {input_source}"

    def case(name: str) -> Path:
        d = out / name
        d.mkdir()
        return d

    def with_artifacts(d: Path, image_name="source.png", model_name="model.glb") -> None:
        shutil.copyfile(input_source, d / image_name)
        synthetic_large_glb(d / model_name, 0)

    # 1. Valid completed manifest.
    d = case("01-valid-completed")
    with_artifacts(d)
    finalize(d, base_manifest())

    # 2. Valid interrupted manifest (no model yet — matches crash semantics).
    d = case("02-valid-interrupted")
    shutil.copyfile(input_source, d / "source.png")
    m = base_manifest()
    m.update(status="interrupted", finishedAtUtc=None, durationSeconds=None)
    m["files"] = [e for e in m["files"] if e["role"] != "glb"]
    finalize(d, m)

    # 3. Valid failed manifest.
    d = case("03-valid-failed")
    shutil.copyfile(input_source, d / "source.png")
    m = base_manifest()
    m.update(status="failed", error="Trellis server returned 500: reconstruction failed")
    m["files"] = [e for e in m["files"] if e["role"] != "glb"]
    finalize(d, m)

    # 4. Completed manifest missing its source image.
    d = case("04-missing-source")
    with_artifacts(d)
    finalize(d, base_manifest())
    (d / "source.png").unlink()

    # 5. Completed manifest missing its GLB.
    d = case("05-missing-glb")
    with_artifacts(d)
    finalize(d, base_manifest())
    (d / "model.glb").unlink()

    # 6. Modified source image (hash mismatch).
    d = case("06-modified-source")
    with_artifacts(d)
    finalize(d, base_manifest())
    (d / "source.png").write_bytes(b"\x89PNG\r\n\x1a\ntampered-content")

    # 7. Modified GLB (hash mismatch).
    d = case("07-modified-glb")
    with_artifacts(d)
    finalize(d, base_manifest())
    raw = bytearray((d / "model.glb").read_bytes())
    raw[-1] ^= 0xFF  # flip one bit deep in the payload
    (d / "model.glb").write_bytes(bytes(raw))

    # 8. Unsupported schema version.
    d = case("08-unsupported-version")
    with_artifacts(d)
    m = base_manifest()
    m["schemaVersion"] = 99
    atomic_write(d / "model.triastasis.json", json.dumps(m, indent=2))

    # 9. Invalid JSON.
    d = case("09-invalid-json")
    with_artifacts(d)
    atomic_write(d / "model.triastasis.json", "{ this is not json at all ")

    # 10. Absolute artifact path.
    d = case("10-absolute-path")
    with_artifacts(d)
    m = base_manifest()
    absolute = (d / "source.png").resolve()
    m["sourceImage"] = str(absolute)
    m["files"][0]["path"] = str(absolute)
    finalize(d, m)

    # 11. ../ traversal path.
    d = case("11-traversal-path")
    with_artifacts(d)
    m = base_manifest()
    m["sourceImage"] = "../11-traversal-path/source.png"
    m["files"][0]["path"] = "../11-traversal-path/source.png"
    finalize(d, m)

    # 12. Windows drive-relative path ("C:name" style).
    d = case("12-drive-relative-path")
    with_artifacts(d)
    m = base_manifest()
    m["model"] = "C:model.glb"
    m["files"][1]["path"] = "C:model.glb"
    finalize(d, m)

    # 13. Valid standalone GLB (no manifest).
    d = case("13-standalone-glb")
    synthetic_large_glb(d / "orphan-model.glb", 2)

    # 14. Standalone GLB with a matching sibling manifest.
    d = case("14-glb-with-sibling-manifest")
    with_artifacts(d)
    (d / "model.glb").rename(d / "sibling-model.glb")
    m = base_manifest()
    m["model"] = "sibling-model.glb"
    m["files"][1]["path"] = "sibling-model.glb"
    finalize(d, m)
    (d / "model.triastasis.json").rename(d / "sibling-model.triastasis.json")

    # 15. Standalone GLB with an INVALID sibling manifest.
    d = case("15-glb-with-invalid-sibling")
    synthetic_large_glb(d / "broken-sibling.glb", 0)
    atomic_write(d / "broken-sibling.triastasis.json", "{{{ not json")

    # 16. Duplicate lineage IDs: same asset/version IDs in two cases; importing
    # both must remap internal IDs without overwriting the first import.
    for suffix in ("a", "b"):
        d = case(f"16-duplicate-ids-{suffix}")
        with_artifacts(d)
        m = base_manifest()
        m.update(assetId="colliding-asset-id", versionId="colliding-version-id", label=f"duplicate-{suffix}")
        finalize(d, m)

    # 17. Unicode filenames.
    d = case("17-unicode-filenames")
    shutil.copyfile(input_source, d / "référence-日本語.png")
    synthetic_large_glb(d / "модель-★.glb", 0)
    m = base_manifest()
    m.update(sourceImage="référence-日本語.png", model="модель-★.glb", label="unicode-fixture")
    m["files"] = [
        {"role": "sourceImage", "path": "référence-日本語.png", "sha256": ""},
        {"role": "glb", "path": "модель-★.glb", "sha256": ""},
    ]
    finalize(d, m)

    # 18. Large but valid GLB (~64 MB synthetic, spec-compliant chunks).
    d = case("18-large-valid-glb")
    synthetic_large_glb(d / "model.glb", 64)
    shutil.copyfile(input_source, d / "source.png")
    m = base_manifest()
    m["metrics"]["fileSizeBytes"] = (d / "model.glb").stat().st_size
    finalize(d, m)

    index = ["# Runtime validation fixtures", "", "Point Import/Open GLB at these directories.", ""]
    descriptions = {
        "01": "Preview renders image+settings; import creates 1 asset + 1 version.",
        "02": "Recovery preview offers 'Requeue generation'.",
        "03": "Failed state shown with preserved error; requeue uses new request id.",
        "04": "Preview reports Missing file: source.png; Import disabled until relinked.",
        "05": "Preview reports Missing file: model.glb; Import disabled until relinked.",
        "06": "Preview reports Modified since generation for source.png.",
        "07": "Preview reports Modified since generation for model.glb.",
        "08": "Clear unsupported-schema-version error; no partial import.",
        "09": "Clear invalid-manifest error; no partial import.",
        "10": "Unsafe path rejected; import blocked.",
        "11": "Traversal attempt reported as unsafe; import blocked.",
        "12": "Drive-relative path rejected; import blocked.",
        "13": "Open GLB views instantly; caption 'Unimported model'; gallery unchanged.",
        "14": "'Import linked generation' appears; normal preview flow works.",
        "15": "GLB still views; invalid sibling does not block viewing.",
        "16": "Both import successfully with DIFFERENT internal ids; neither overwrites the other.",
        "17": "Unicode names survive preview, import, and viewer.",
        "18": "Large GLB opens with reasonable latency; no unbounded memory growth.",
    }
    for key, text in descriptions.items():
        index.append(f"- `{key}-*`: {text}")
    atomic_write(out / "RUNTIME-FIXTURES.md", "\n".join(index) + "\n")

    print(f"fixtures written to {out}")
    for child in sorted(out.iterdir()):
        print(f"  {child.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
