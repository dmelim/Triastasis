"""Exercise the real CLI's opt-in storage without loading model weights."""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

from material_diagnostics import read_events, summarize


def main():
    if os.name == "nt":
        import ctypes
        # Test children must report loader faults via exit codes, not desktop
        # error dialogs that block unattended validation.
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="native-diagnostics-", dir=args.scratch.resolve()))
    source = root / "source.png"

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    pixels = b"".join(b"\0" + b"".join(
        bytes((40, 80, 160, 255)) if 4 <= x < 12 and 4 <= y < 12 else bytes((255, 255, 255, 0))
        for x in range(16)) for y in range(16))
    source.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
    logs = root / "diagnostics-\u00e7"
    logs.mkdir()

    def run(label, enabled, input_path=source, directory=logs):
        env = os.environ.copy()
        env["TRIASTASIS_DIAGNOSTICS"] = "1" if enabled else "0"
        env["TRIASTASIS_DIAGNOSTICS_DIR"] = str(directory)
        result = subprocess.run([str(args.cli.resolve()), str(input_path), str(root / f"{label}.glb"),
            "--bg-only", "--bg-removal", "threshold", "--gpu", "-1", "--seed", "42"],
            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        (root / f"{label}.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        return result

    disabled = run("disabled", False)
    assert disabled.returncode == 0 and "[triastasis-diag]" not in disabled.stderr
    assert not list(logs.glob("*.jsonl"))
    for label in ("enabled", "repeated"):
        result = run(label, True)
        assert result.returncode == 0, result.stderr
        assert (root / f"{label}_cutout.png").read_bytes() == (root / "disabled_cutout.png").read_bytes()
    failed = run("failed", True, root / "missing.png")
    assert failed.returncode == 1
    missing_log_dir = root / "missing-log-directory"
    no_sink = run("no_sink", True, directory=missing_log_dir)
    assert no_sink.returncode == 0 and "cannot_create_log" in no_sink.stderr
    assert not missing_log_dir.exists(), "logging must not create output parent directories"
    paths = list(logs.glob("*.jsonl"))
    assert len(paths) == 3, "one persisted file per enabled run, including failure"
    events, problems = read_events(paths + [root / "enabled.log", root / "repeated.log", root / "failed.log"])
    assert not problems, problems
    report = summarize(events)
    assert len(report["runs"]) == 3
    assert sorted(run["status"] for run in report["runs"]) == ["background_only", "background_only", "failed"]
    assert all(run["provenance"]["seed"] == 42 and run["provenance"]["stored"] for run in report["runs"])
    (root / "summary.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Native diagnostics storage checks passed; synthetic records: {root}")


if __name__ == "__main__":
    main()
