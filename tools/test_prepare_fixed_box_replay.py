import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from prepare_fixed_box_replay import extract


class FixedBoxExtractionTests(unittest.TestCase):
    def fixture(self):
        return {"arrays": {"POSITION": np.array([[1, 2, 3], [2, 2, 3], [1, 3, 3]], dtype=np.float32),
                           "TEXCOORD_0": np.array([[.05, .05], [.2, .05], [.05, .2]], dtype=np.float32),
                           "indices": np.array([[0, 1, 2]], dtype=np.uint32)},
                "textures": {"base": np.zeros((24, 24, 4), dtype=np.uint8)}}

    def test_native_coordinates_and_array_order(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp)/"source.glb", Path(temp)/"fixed.bin"
            source.write_bytes(b"synthetic fixture")
            with patch("prepare_fixed_box_replay.load", return_value=self.fixture()):
                report = extract(source, output)
                self.assertEqual(report["bucket_face_counts"], [1]+[0]*11)
                data = output.read_bytes()
                self.assertEqual(struct.unpack_from("<3i", data), (3, 1, 24))
                np.testing.assert_array_equal(np.frombuffer(data, dtype="<f4", offset=12, count=9).reshape(3, 3),
                                              [[1, -3, 2], [2, -3, 2], [1, -3, 3]])
                with self.assertRaises(FileExistsError):
                    extract(source, output)

    def test_cross_cell_face_rejected_before_write(self):
        model = self.fixture()
        model["arrays"]["TEXCOORD_0"][2] = [.3, .2]
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/"fixed.bin"
            with patch("prepare_fixed_box_replay.load", return_value=model):
                with self.assertRaisesRegex(ValueError, "crosses box atlas cells"):
                    extract(Path(temp)/"source.glb", output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
