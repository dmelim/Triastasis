import unittest
import numpy as np
from trace_material_corners import corners


class MaterialCornerTests(unittest.TestCase):
    def test_missing_corners_renormalize(self):
        coords=np.array([[0,0,0],[1,0,0]])
        values=np.array([[.2]*6,[.8]*6],dtype=np.float32)
        r=corners([[0,-.25,0]],coords,values,2)
        self.assertTrue(r["valid"][0])
        self.assertEqual(r["support"][0],.5)
        np.testing.assert_allclose(r["result"],[ [.5]*6 ],atol=1e-7)
        self.assertEqual(r["normalized"].sum(),1)

    def test_affine_dense_field_is_exact(self):
        coords=np.array([(x,y,z) for z in range(2) for y in range(2) for x in range(2)])
        values=np.repeat((coords@[.1,.2,.3])[:,None],6,axis=1).astype(np.float32)
        # Grid fraction (.25,.5,.75); affine interpolation gives .35.
        r=corners([[-.125,0,.125]],coords,values,2)
        np.testing.assert_allclose(r["result"],[[.35]*6],atol=1e-7)
        self.assertEqual(r["support"][0],1)

    def test_missing_and_duplicate_keys(self):
        coords=np.array([[0,0,0],[0,0,0]])
        values=np.array([[.2]*6,[.8]*6],dtype=np.float32)
        r=corners([[-.25,-.25,-.25],[1,1,1]],coords,values,2)
        np.testing.assert_allclose(r["result"][0],[.8]*6)
        self.assertFalse(r["valid"][1])
        self.assertEqual(r["result"][1].sum(),0)


if __name__ == "__main__":
    unittest.main()
