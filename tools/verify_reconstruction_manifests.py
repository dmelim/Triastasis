#!/usr/bin/env python3
"""Verifies every reconstruction-run manifest: schema basics + file hashes."""
import hashlib
import json
import sys
from pathlib import Path

RUN = Path(__file__).resolve().parent.parent / "assets" / "reconstruction-test-set" / "runs" / "2026-08-21-api-smoke"


def main() -> int:
    ok = True
    for case_dir in sorted(p for p in RUN.iterdir() if p.is_dir()):
        manifest_path = case_dir / "model.triastasis.json"
        if not manifest_path.is_file():
            manifest_path = case_dir / "model.polyloom.json"
        if not manifest_path.is_file():
            continue
        m = json.loads(manifest_path.read_text(encoding="utf-8"))
        issues = []
        if m["schemaVersion"] != 1:
            issues.append("version")
        if m["status"] not in ("completed", "interrupted", "failed"):
            issues.append("status")
        for entry in m["files"]:
            f = case_dir / entry["path"]
            if not f.is_file():
                issues.append(f"missing:{entry['role']}")
                continue
            digest = hashlib.sha256(f.read_bytes()).hexdigest()
            if digest != entry["sha256"]:
                issues.append(f"hash:{entry['role']}")
        status = "OK" if not issues else "FAIL: " + ",".join(issues)
        if issues:
            ok = False
        print(
            f"{case_dir.name}: {m['status']} seed={m['seed']} res={m['resolution']} "
            f"warning={bool(m['qualityWarning'])} -> {status}"
        )
    print("ALL MANIFESTS VALID" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
