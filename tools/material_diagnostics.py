"""Summarize persisted JSONL or desktop server logs without model dependencies.

Usage: python tools/material_diagnostics.py <logs...> --output out/summary.json
Metrics describe populations and failure signals, never a visual-quality score.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

PREFIX = "[triastasis-diag] "


def reject_constant(value: str):
    raise ValueError(f"nonfinite JSON constant: {value}")


def read_events(paths: list[Path]) -> tuple[list[dict], list[str]]:
    events: dict[tuple[str, int], dict] = {}
    problems: list[str] = []
    for path in paths:
        with path.open(encoding="utf-8-sig", errors="replace") as stream:
            for line_number, line in enumerate(stream, 1):
                if PREFIX in line:
                    payload = line.split(PREFIX, 1)[1]
                elif line.lstrip().startswith('{'):
                    payload = line
                else:
                    if "[triastasis-diag-storage]" in line:
                        problems.append(f"{path.name}:{line_number}: diagnostic storage failed")
                    continue
                try:
                    event = json.loads(payload, parse_constant=reject_constant)
                    if not isinstance(event, dict):
                        raise ValueError("expected object")
                    if event.get("schema_version") != 1:
                        raise ValueError("unsupported/missing schema_version")
                    if not isinstance(event.get("run_id"), str) or not event["run_id"]:
                        raise ValueError("invalid run_id")
                    if type(event.get("sequence")) is not int or event["sequence"] < 1:
                        raise ValueError("invalid sequence")
                    if not isinstance(event.get("event"), str):
                        raise ValueError("invalid event")
                    for key in ("attempts", "snapped", "shell", "missing", "nonfinite", "nonfinite_velocity", "nonfinite_state"):
                        value = event.get(key, 0)
                        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                            raise ValueError(f"invalid numeric field: {key}")
                except (ValueError, TypeError) as exc:
                    problems.append(f"{path.name}:{line_number}: {exc}")
                    continue
                key = event["run_id"], event["sequence"]
                if key in events and events[key] != event:
                    problems.append(f"{path.name}:{line_number}: conflicting duplicate event {key}")
                else:
                    events[key] = event
    return list(events.values()), problems


def summarize(events: list[dict], problems: list[str] | None = None) -> dict:
    grouped: dict[str, list[dict]] = {}
    for event in events:
        grouped.setdefault(event["run_id"], []).append(event)
    runs = []
    for run_id, rows in sorted(grouped.items()):
        rows.sort(key=lambda row: row["sequence"])
        warnings = []
        stages = []
        stack = []
        distributions = []
        sampling = []
        decisions = []
        steps = []
        encoding_errors = []
        previous = 0
        start = next((row for row in rows if row["event"] == "run_start"), None)
        end = next((row for row in reversed(rows) if row["event"] == "run_end"), None)
        for row in rows:
            if row["sequence"] != previous + 1:
                warnings.append(f"Event sequence gap: expected {previous + 1}, got {row['sequence']}")
            previous = row["sequence"]
            kind = row["event"]
            if kind == "stage_start":
                stack.append(row.get("stage"))
            elif kind == "stage_end":
                stages.append({**row, "parent_stage": stack[-2] if len(stack) > 1 else None})
                if stack and stack[-1] == row.get("stage"):
                    stack.pop()
                else:
                    warnings.append(f"Unmatched stage end: {row.get('stage')}")
            elif kind == "distribution":
                distributions.append(row)
                if row.get("nonfinite", 0):
                    warnings.append(f"Nonfinite values in {row.get('stage')}/{row.get('channel')}")
            elif kind == "voxel_sampling":
                total = row.get("attempts", 0)
                sampling.append({**row, "scope": stack[-1] if stack else None, "fallback_fraction":
                    (row.get("snapped", 0) + row.get("shell", 0)) / total if total else None,
                    "missing_fraction": row.get("missing", 0) / total if total else None})
            elif kind == "sampler_step":
                steps.append({**row, "scope": stack[-1] if stack else None})
                if row.get("nonfinite_velocity", 0) or row.get("nonfinite_state", 0) or row.get("guidance_ratio_corrected"):
                    warnings.append(f"Numerical correction/invalid value in {stack[-1] if stack else 'sampler'} step {row.get('step')}")
            elif kind == "encoding_error":
                encoding_errors.append(row)
            elif kind not in {"run_start", "run_end"}:
                decisions.append({**row, "scope": stack[-1] if stack else None})
                if kind == "diagnostic_error":
                    warnings.append(f"Diagnostic failure: {row.get('stage')}/{row.get('reason', 'unspecified')}")
                if kind == "atlas_population" and row.get("selected_pixels") == 0:
                    warnings.append(f"Empty atlas population: {row.get('stage')}")
        if not start:
            warnings.append("Missing run_start; provenance is incomplete")
        status = end.get("status", "unknown") if end else "truncated_or_running"
        if status != "completed":
            warnings.append(f"Run is not a confirmed completed GLB: {status}")
        if stack:
            warnings.append(f"Unclosed stages: {stack}")
        runs.append({"run_id": run_id, "status": status, "provenance": start,
            "elapsed_ms": end.get("elapsed_ms") if end else None, "stage_timings": stages,
            "decisions": decisions, "distributions": distributions, "voxel_sampling": sampling,
            "sampler_steps": steps, "encoding_errors": encoding_errors, "warnings": warnings})
    return {"schema_version": 1, "parse_problems": problems or [], "runs": runs,
        "interpretation": [
            "Timings are inclusive host wall times with diagnostic overhead; do not sum nested stages.",
            "Voxel statistics, baked-texel statistics, and whole-atlas statistics have different populations.",
            "base_code_luma is an encoded-colour proxy, not physical luminance or a fidelity score.",
            "Sampling rates include overdraw; missing attempts are not unique surface-hole percentages.",
            "Texture codec errors are normalized to [0,1] over the whole atlas, including gutters.",
            "Identical seeds do not establish identical inputs across runtimes; preserve assets and settings separately.",
        ]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        events, problems = read_events(args.logs)
        report = summarize(events, problems)
        content = json.dumps(report, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            # A new report is reviewable; never overwrite a source log or prior report.
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(content)
        else:
            print(content, end="")
    except (OSError, ValueError) as exc:
        parser.exit(2, f"{exc}\n")
    return 0 if events and not problems else 2


if __name__ == "__main__":
    raise SystemExit(main())
