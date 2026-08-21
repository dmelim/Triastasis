#!/usr/bin/env python3
"""Polyloom reconstruction-test harness.

Runs every case in assets/reconstruction-test-set/manifest.json against the
native TRELLIS pipeline with fixed settings and seeds, preserving everything
needed for later analysis: the original input, the conditioned cutout (CLI
mode), the GLB, exact generation parameters, seed, duration, dimensions,
quality metrics, and native logs.

Reproducible and resumable:
- One output directory per run; a completed case is marked by result.json.
- Re-invoking with the same --run-dir skips completed cases (--force re-runs).
- Failures are recorded as first-class results so a broken case never blocks
  or silently disappears from the matrix.

Usage:
  python tools/reconstruction_run.py --server http://127.0.0.1:8080
  python tools/reconstruction_run.py --server http://127.0.0.1:8080 \
      --run-dir assets/reconstruction-test-set/runs/2026-08-21-baseline
  python tools/reconstruction_run.py --cli ./build/trellis-cli --models ./models \
      [--gpu 0]            # CLI mode also preserves the bg-removal cutout

Only the Python standard library is required.
"""
import argparse
import json
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEST_SET_ROOT = REPO_ROOT / "assets" / "reconstruction-test-set"
DEFAULT_MANIFEST = TEST_SET_ROOT / "manifest.json"
DEFAULT_RUNS_DIR = TEST_SET_ROOT / "runs"


def validate_manifest(manifest: dict) -> None:
    if manifest.get("schemaVersion") != 1:
        raise ValueError("manifest schemaVersion must be 1")
    settings = manifest.get("settings")
    if not isinstance(settings, dict):
        raise ValueError("manifest settings must be an object")
    missing_settings = {
        "resolution", "seed", "bgRemoval", "uv", "texture"
    } - settings.keys()
    if missing_settings:
        raise ValueError(f"manifest settings missing: {', '.join(sorted(missing_settings))}")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("manifest cases must be a non-empty array")
    seen = set()
    root = TEST_SET_ROOT.resolve()
    for index, case in enumerate(cases, start=1):
        if not isinstance(case, dict):
            raise ValueError(f"manifest case {index} must be an object")
        missing = {"id", "input", "factor"} - case.keys()
        if missing:
            raise ValueError(
                f"manifest case {index} missing: {', '.join(sorted(missing))}"
            )
        case_id = case["id"]
        if not isinstance(case_id, str) or not case_id:
            raise ValueError(f"manifest case {index} has an invalid id")
        if case_id in seen:
            raise ValueError(f"manifest contains duplicate case id: {case_id}")
        seen.add(case_id)
        input_path = (TEST_SET_ROOT / case["input"]).resolve()
        if not input_path.is_relative_to(root):
            raise ValueError(f"manifest case {case_id} input escapes the test-set directory")
        if not input_path.is_file():
            raise ValueError(f"manifest case {case_id} input does not exist: {case['input']}")


def atomic_write_json(path: Path, payload) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temp.replace(path)


def glb_dimensions(path: Path):
    """Bounding dimensions + thin ratio from POSITION accessor min/max."""
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    offset, json_chunk = 12, None
    while offset + 8 <= len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        body = data[offset + 8 : offset + 8 + length]
        if chunk_type == 0x4E4F534A:
            json_chunk = json.loads(body.rstrip(b"\0 "))
        offset += 8 + length
    if json_chunk is None:
        raise ValueError("GLB has no JSON chunk")
    lower = [float("inf")] * 3
    upper = [float("-inf")] * 3
    accessors = json_chunk.get("accessors", [])
    for mesh in json_chunk.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index = primitive.get("attributes", {}).get("POSITION")
            if index is None or index >= len(accessors):
                continue
            accessor = accessors[index]
            if "min" in accessor and "max" in accessor:
                for axis in range(3):
                    lower[axis] = min(lower[axis], float(accessor["min"][axis]))
                    upper[axis] = max(upper[axis], float(accessor["max"][axis]))
    if lower[0] == float("inf"):
        raise ValueError("no POSITION bounds in GLB")
    dimensions = [upper[i] - lower[i] for i in range(3)]
    largest = max(dimensions)
    thin_ratio = (min(dimensions) / largest) if largest > 0 else None
    return {
        "dimensions": {"x": round(dimensions[0], 5), "y": round(dimensions[1], 5), "z": round(dimensions[2], 5)},
        "thinRatio": round(thin_ratio, 6) if thin_ratio is not None else None,
        "fileSizeBytes": path.stat().st_size,
    }


class ServerBackend:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _request(self, method: str, url: str, body=None, headers=None, timeout=3700):
        request = urllib.request.Request(url, data=body, method=method)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        return urllib.request.urlopen(request, timeout=timeout)

    def generate(
        self,
        image_path: Path,
        params: dict,
        request_id: str,
        work_dir: Path | None = None,
    ):
        del work_dir  # Kept for a uniform backend interface.
        boundary = f"polyloom-{request_id}"
        parts = []

        def field(name, value):
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            )

        image_bytes = image_path.read_bytes()
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        parts.append(image_bytes)
        parts.append(b"\r\n")
        for name in ("resolution", "seed", "bg_removal", "uv", "texture", "request_id"):
            if name in params:
                field(name, str(params[name]).lower() if isinstance(params[name], bool) else str(params[name]))
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        started = time.monotonic()
        response = self._request(
            "POST",
            f"{self.base_url}/generate",
            body,
            {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        payload = response.read()
        if response.status != 200:
            raise RuntimeError(f"/generate returned HTTP {response.status}: {payload[:400]!r}")
        duration = time.monotonic() - started
        progress = self.progress_snapshot(request_id)
        return payload, duration, progress

    def progress_snapshot(self, request_id: str):
        try:
            encoded_id = urllib.parse.quote(request_id, safe="")
            with self._request("GET", f"{self.base_url}/progress/{encoded_id}", timeout=10) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, OSError, ValueError):
            return None


class CliBackend:
    """Runs trellis-cli directly; preserves the conditioned cutout and raw logs."""

    def __init__(self, cli_path: str, models_dir: str, gpu: int, dump_bg: bool):
        self.cli_path = cli_path
        self.models_dir = models_dir
        self.gpu = gpu
        self.dump_bg = dump_bg

    def generate(self, image_path: Path, params: dict, request_id: str, work_dir: Path | None = None):
        assert work_dir is not None, "CLI mode requires a case directory"
        output = work_dir / "model.glb"
        command = [
            self.cli_path,
            str(image_path),
            str(output),
            str(self.gpu),
            self.models_dir,
            str(params["seed"]),
            "--res",
            str(params.get("resolution", 512)),
        ]
        if params.get("bg_removal", "auto") != "auto":
            command += ["--bg", params["bg_removal"]]
        if params.get("uv", "xatlas") == "box":
            command.append("--box-uv")
        if not params.get("texture", True):
            command.append("--no-texture")
        if self.dump_bg:
            command.append("--dump-bg")
        log_path = work_dir / "native-log.txt"
        started = time.monotonic()
        import subprocess

        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
        duration = time.monotonic() - started
        if process.returncode != 0 or not output.exists():
            raise RuntimeError(
                f"trellis-cli exited with code {process.returncode}; see native-log.txt"
            )
        cutout = work_dir / "cutout.png"
        return (
            output.read_bytes(),
            duration,
            {"nativeLog": str(log_path), "cutout": str(cutout) if cutout.exists() else None},
        )


def run_case(case: dict, settings: dict, backend, run_dir: Path, force: bool) -> dict:
    case_dir = run_dir / case["id"]
    case_dir.mkdir(parents=True, exist_ok=True)
    result_path = case_dir / "result.json"
    if result_path.exists() and not force:
        print(f"  = {case['id']}: already complete, skipping")
        return json.loads(result_path.read_text(encoding="utf-8"))

    input_path = TEST_SET_ROOT / case["input"]
    preserved_input = case_dir / "input.png"
    if not preserved_input.exists():
        preserved_input.write_bytes(input_path.read_bytes())

    effective_seed = case.get("seed", settings["seed"])
    request_id = f"recon-{case['id']}-{effective_seed}"
    params = {
        "resolution": settings["resolution"],
        "seed": effective_seed,
        "bg_removal": settings["bgRemoval"],
        "uv": settings["uv"],
        "texture": settings["texture"],
        "request_id": request_id,
    }
    record = {
        "schemaVersion": 1,
        "caseId": case["id"],
        "factor": case["factor"],
        "description": case.get("description"),
        "input": case["input"],
        "params": {k: v for k, v in params.items()},
        "startedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
        "error": None,
    }
    print(f"  -> {case['id']} (seed {params['seed']})")
    try:
        payload, duration, extra = backend.generate(
            input_path, params, request_id, work_dir=case_dir
        )
        model_path = case_dir / "model.glb"
        model_path.write_bytes(payload)
        record.update(
            status="succeeded",
            finishedAtUtc=datetime.now(timezone.utc).isoformat(),
            durationSeconds=round(duration, 2),
            requestId=request_id,
            metrics=glb_dimensions(model_path),
            artifacts=extra,
        )
        print(f"     ok in {record['durationSeconds']}s, thinRatio={record['metrics']['thinRatio']}")
    except Exception as error:  # failures are preserved results, never silent
        record.update(
            finishedAtUtc=datetime.now(timezone.utc).isoformat(),
            error=f"{type(error).__name__}: {error}",
        )
        print(f"     FAILED: {record['error']}")
    atomic_write_json(result_path, record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--run-dir", type=Path, default=None)
    parser.add_argument("--only", default="", help="comma-separated case ids subset")
    parser.add_argument("--force", action="store_true", help="re-run completed cases")
    parser.add_argument("--seed", type=int, help="override the manifest seed for every case")
    backend_group = parser.add_mutually_exclusive_group(required=True)
    backend_group.add_argument("--server", help="trellis-server base URL")
    backend_group.add_argument("--cli", help="path to trellis-cli binary")
    parser.add_argument("--models", default="models", help="models dir (CLI mode)")
    parser.add_argument("--gpu", type=int, default=0, help="GPU index (CLI mode)")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    try:
        validate_manifest(manifest)
    except ValueError as error:
        parser.error(str(error))
    settings = dict(manifest["settings"])
    if args.seed is not None:
        settings["seed"] = args.seed
    cases = manifest["cases"]
    if args.only:
        wanted = {part.strip() for part in args.only.split(",")}
        available = {case["id"] for case in cases}
        unknown = wanted - available
        if unknown:
            parser.error(f"unknown case id(s): {', '.join(sorted(unknown))}")
        cases = [case for case in cases if case["id"] in wanted]

    if args.run_dir is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        run_dir = DEFAULT_RUNS_DIR / f"{stamp}-seed{settings['seed']}"
    else:
        run_dir = args.run_dir
    run_dir.mkdir(parents=True, exist_ok=True)

    if args.server:
        backend = ServerBackend(args.server)
    else:
        backend = CliBackend(args.cli, args.models, args.gpu, dump_bg=True)

    print(f"Run directory: {run_dir}")
    print(f"Settings: {json.dumps(settings)}")
    results = [run_case(case, settings, backend, run_dir, args.force) for case in cases]

    summary = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "settings": settings,
        "backend": "server" if args.server else "cli",
        "total": len(results),
        "succeeded": sum(1 for r in results if r["status"] == "succeeded"),
        "failed": sum(1 for r in results if r["status"] != "succeeded"),
        "cases": [
            {
                "caseId": r["caseId"],
                "status": r["status"],
                "durationSeconds": r.get("durationSeconds"),
                "thinRatio": (r.get("metrics") or {}).get("thinRatio"),
                "error": r.get("error"),
            }
            for r in results
        ],
    }
    atomic_write_json(run_dir / "summary.json", summary)
    print(f"\n{summary['succeeded']}/{summary['total']} succeeded; summary at {run_dir / 'summary.json'}")
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
