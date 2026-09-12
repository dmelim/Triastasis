import json
from pathlib import Path
import tempfile
import unittest

from material_diagnostics import read_events, summarize


def event(sequence, kind, **fields):
    return {"schema_version": 1, "run_id": "synthetic", "sequence": sequence, "event": kind, **fields}


class DiagnosticsTests(unittest.TestCase):
    def test_persisted_and_desktop_events_deduplicate(self):
        row = event(1, "run_start")
        with tempfile.TemporaryDirectory() as folder:
            raw, desktop = Path(folder) / "raw.jsonl", Path(folder) / "server.log"
            raw.write_text(json.dumps(row) + "\n", encoding="utf-8")
            desktop.write_text("[12:00:00] [triastasis-diag] " + json.dumps(row) + "\n", encoding="utf-8")
            rows, problems = read_events([raw, desktop])
        self.assertEqual(rows, [row])
        self.assertEqual(problems, [])

    def test_truncated_unknown_schema_and_conflicting_events(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "raw.jsonl"
            path.write_text("\n".join([json.dumps(event(1, "run_start")),
                json.dumps(event(1, "run_end")), '{"schema_version":2}', '{"run_id":']), encoding="utf-8")
            rows, problems = read_events([path])
        self.assertEqual(len(problems), 3)
        self.assertEqual(summarize(rows)["runs"][0]["status"], "truncated_or_running")

    def test_no_invalid_rates_for_empty_populations(self):
        report = summarize([event(1, "run_start"), event(2, "voxel_sampling", attempts=0),
            event(3, "atlas_population", selected_pixels=0, stage="bake"),
            event(4, "run_end", status="completed")])
        run = report["runs"][0]
        self.assertIsNone(run["voxel_sampling"][0]["missing_fraction"])
        self.assertTrue(any("Empty atlas" in warning for warning in run["warnings"]))
        json.dumps(report, allow_nan=False)

    def test_scope_corrections_and_missing_events(self):
        report = summarize([event(1, "run_start"), event(2, "stage_start", stage="texture_flow"),
            event(4, "sampler_step", step=2, replaced_velocity=3, nonfinite_velocity=3),
            event(5, "stage_end", stage="texture_flow", wall_ms=10),
            event(6, "run_end", status="output_failed")])
        run = report["runs"][0]
        self.assertEqual(run["sampler_steps"][0]["scope"], "texture_flow")
        self.assertEqual(len(run["warnings"]), 3)

    def test_malformed_numeric_fields_are_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "raw.jsonl"
            path.write_text(json.dumps(event(1, "voxel_sampling", attempts="invalid")), encoding="utf-8")
            rows, problems = read_events([path])
        self.assertEqual(rows, [])
        self.assertEqual(len(problems), 1)


if __name__ == "__main__":
    unittest.main()
