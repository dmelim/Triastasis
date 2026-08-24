import json
import tempfile
import unittest
from pathlib import Path

try:
    from tools.reconstruction_run import refresh_case_manifest, sha256_file
except ModuleNotFoundError:
    from reconstruction_run import refresh_case_manifest, sha256_file


def sample_record() -> dict:
    return {
        "schemaVersion": 1,
        "caseId": "test-case",
        "params": {
            "resolution": 512,
            "seed": 42,
            "bg_removal": "auto",
            "uv": "xatlas",
            "texture": True,
        },
        "startedAtUtc": "2026-08-23T10:00:00+00:00",
        "finishedAtUtc": "2026-08-23T10:01:00+00:00",
        "durationSeconds": 60.0,
        "requestId": "request-1",
        "status": "succeeded",
        "error": None,
        "metrics": {
            "dimensions": {"x": 1.0, "y": 2.0, "z": 3.0},
            "thinRatio": 0.5,
            "fileSizeBytes": 12,
        },
    }


class RefreshCaseManifestTests(unittest.TestCase):
    def make_case(self, root: Path) -> Path:
        case_dir = root / "test-case"
        case_dir.mkdir()
        (case_dir / "input.png").write_bytes(b"\x89PNG\r\n\x1a\nsource")
        (case_dir / "model.glb").write_bytes(b"glTF\x02\x00\x00\x00model")
        (case_dir / "result.json").write_text(
            json.dumps(sample_record()), encoding="utf-8"
        )
        return case_dir

    def test_create_then_unchanged_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            case_dir = self.make_case(Path(temp))
            self.assertEqual(refresh_case_manifest(case_dir), "created")
            self.assertEqual(refresh_case_manifest(case_dir), "unchanged")

            manifest = json.loads(
                (case_dir / "model.triastasis.json").read_text(encoding="utf-8")
            )
            hashes = {entry["role"]: entry["sha256"] for entry in manifest["files"]}
            self.assertEqual(hashes["sourceImage"], sha256_file(case_dir / "input.png"))
            self.assertEqual(hashes["glb"], sha256_file(case_dir / "model.glb"))

    def test_invalid_json_is_rebuilt_as_updated(self):
        with tempfile.TemporaryDirectory() as temp:
            case_dir = self.make_case(Path(temp))
            target = case_dir / "model.triastasis.json"
            target.write_text('{"broken":', encoding="utf-8")

            self.assertEqual(refresh_case_manifest(case_dir), "updated")
            rebuilt = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(rebuilt["schemaVersion"], 1)
            self.assertEqual(rebuilt["status"], "completed")
            self.assertEqual(refresh_case_manifest(case_dir), "unchanged")

    def test_wrong_json_shape_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as temp:
            case_dir = self.make_case(Path(temp))
            target = case_dir / "model.triastasis.json"
            target.write_text(json.dumps("double encoded"), encoding="utf-8")

            self.assertEqual(refresh_case_manifest(case_dir), "updated")
            self.assertIsInstance(json.loads(target.read_text(encoding="utf-8")), dict)

    def test_valid_optional_metadata_survives_refresh(self):
        with tempfile.TemporaryDirectory() as temp:
            case_dir = self.make_case(Path(temp))
            self.assertEqual(refresh_case_manifest(case_dir), "created")
            target = case_dir / "model.triastasis.json"
            manifest = json.loads(target.read_text(encoding="utf-8"))
            manifest.update(
                {
                    "assetId": "preserved-asset",
                    "parentVersionId": "parent-version",
                    "triastasisVersion": "0.5.4",
                    "qualityWarning": {
                        "code": "future-warning",
                        "message": "Preserve me",
                        "thinRatio": 0.5,
                        "threshold": 0.05,
                        "dimensions": {"x": 1.0, "y": 2.0, "z": 3.0},
                    },
                }
            )
            target.write_text(json.dumps(manifest), encoding="utf-8")

            self.assertEqual(refresh_case_manifest(case_dir), "unchanged")
            refreshed = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(refreshed["assetId"], "preserved-asset")
            self.assertEqual(refreshed["parentVersionId"], "parent-version")
            self.assertEqual(refreshed["triastasisVersion"], "0.5.4")
            self.assertEqual(refreshed["qualityWarning"]["message"], "Preserve me")

    def test_refreshes_legacy_manifest_in_place(self):
        with tempfile.TemporaryDirectory() as temp:
            case_dir = self.make_case(Path(temp))
            legacy = case_dir / "model.polyloom.json"
            legacy.write_text(
                json.dumps({"polyloomVersion": "0.0.1-alpha.1"}),
                encoding="utf-8",
            )

            self.assertEqual(refresh_case_manifest(case_dir), "updated")
            self.assertTrue(legacy.is_file())
            self.assertFalse((case_dir / "model.triastasis.json").exists())
            refreshed = json.loads(legacy.read_text(encoding="utf-8"))
            self.assertEqual(refreshed["polyloomVersion"], "0.0.1-alpha.1")
            self.assertIn("triastasisVersion", refreshed)


if __name__ == "__main__":
    unittest.main()
