import tempfile
import unittest
from pathlib import Path

import numpy as np

from compare_tex_decode_replays import IDENTICAL_FILES, load_trace, resample


class DecoderReplayComparisonTests(unittest.TestCase):
    def test_partial_support_is_renormalized_without_missing_voxel_colour(self):
        values = np.array([[0]*6, [1]*6], dtype=np.float32)
        trace = {
            "ids": np.array([[0, 1, -1, -1, -1, -1, -1, -1]]),
            "active": np.array([[True, True, False, False, False, False, False, False]]),
            "weights": np.array([[.125, .375, .5, 0, 0, 0, 0, 0]], dtype=np.float32),
            "support": np.array([.5], dtype=np.float32), "valid": np.array([True])}
        np.testing.assert_array_equal(resample(values, trace), np.full((1, 6), .75))
        trace["ids"][0, 1] = 2
        with self.assertRaisesRegex(ValueError, "outside decoder output"):
            resample(values, trace)

    def test_changed_input_or_coordinate_order_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ref, variant = root/"ref", root/"variant"
            ref.mkdir(); variant.mkdir()
            for name in IDENTICAL_FILES:
                (ref/name).write_bytes(b"same")
                (variant/name).write_bytes(b"same")
            for name in ("input.latent.f32", "guide-0.u8", "stage-3.coords.i32"):
                (variant/name).write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "fixed input/order changed"):
                    load_trace(variant, ref)
                (variant/name).write_bytes(b"same")

    def test_truncated_or_nonfinite_output_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in IDENTICAL_FILES:
                (root/name).write_bytes(bytes(12))
            for data in ([0]*5, [float("nan")]*6):
                np.array(data, dtype="<f4").tofile(root/"output.raw.f32")
                with self.assertRaisesRegex(ValueError, "invalid decoder output"):
                    load_trace(root, root)
            np.array([-2, -1, 0, 1, 2, .5], dtype="<f4").tofile(root/"output.raw.f32")
            np.testing.assert_array_equal(load_trace(root, root), [[0, 0, .5, 1, 1, .75]])


if __name__ == "__main__":
    unittest.main()
