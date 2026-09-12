import unittest
import numpy as np
from compare_material_exports import compare, surface_hash


class SurfaceComparisonTests(unittest.TestCase):
    def fixture(self):
        # Two triangles with area ratio 1:4; fixed UVs hit distinct texel centres.
        p = np.array([[0,0,0],[1,0,0],[0,1,0],[2,0,0],[4,0,0],[2,2,0]], dtype=np.float32)
        return {"arrays": {"POSITION": p, "TEXCOORD_0": np.array([[.25,.5]]*3+[[.75,.5]]*3),
                "indices": np.array([[0,1,2],[3,4,5]])},
                "textures": {k: np.zeros((1,2,4), dtype=np.uint8) for k in ("base", "mr")}}

    def test_area_weighting_and_sign(self):
        a, b = self.fixture(), self.fixture()
        b["textures"]["mr"][0,1,2] = 255
        r = compare(a, b, 16)
        self.assertAlmostEqual(r["surface_errors"]["mr"]["mae"][2], .8)
        self.assertAlmostEqual(r["surface_errors"]["mr"]["mean_signed_change"][2], .8)
        self.assertAlmostEqual(r["surface_errors"]["base"]["mae"][0], 0)

    def test_uv_mismatch_is_not_a_valid_surface_error(self):
        a, b = self.fixture(), self.fixture()
        b["arrays"]["TEXCOORD_0"] += .1
        r = compare(a, b)
        self.assertTrue(r["surface_identity"])
        self.assertIsNone(r["surface_errors"])

    def test_reindexing_preserves_surface_but_not_changed_geometry(self):
        a, b = self.fixture(), self.fixture()
        b["arrays"]["indices"] = np.array([[5,3,4],[1,2,0]])
        self.assertEqual(surface_hash(a), surface_hash(b))
        b["arrays"]["POSITION"][0,0] += .1
        self.assertNotEqual(surface_hash(a), surface_hash(b))


if __name__ == "__main__":
    unittest.main()
