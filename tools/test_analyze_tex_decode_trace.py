import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np
from analyze_tex_decode_trace import expand_reference, gguf_head


class DecodeLayoutTests(unittest.TestCase):
    def test_tagged_parent_octant_order(self):
        coords=np.array([[3,7,11],[13,17,19]],dtype=np.int32)
        mask=np.zeros((2,8),dtype=np.uint8)
        mask[0,[1,2,4]]=1;mask[1,[0,7]]=1
        expected=[[7,14,22],[6,15,22],[6,14,23],[26,34,38],[27,35,39]]
        np.testing.assert_array_equal(expand_reference(coords,mask),expected)

    def test_q4_nibbles_negative_scale_and_head_bias(self):
        def string(s):
            b=s.encode();return struct.pack("<Q",len(b))+b
        header=b"GGUF"+struct.pack("<IQQ",3,2,0)
        header+=string("output_layer.weight")+struct.pack("<IQQIQ",2,64,6,2,0)
        header+=string("output_layer.bias")+struct.pack("<IQIQ",1,6,0,224)
        header+=b"\0"*((-len(header))%32)
        blocks=b"".join(struct.pack("<e",.25 if i%2==0 else -.5)+bytes([0xf0])*16 for i in range(12))
        bias=np.arange(6,dtype="<f4")
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"synthetic.gguf"
            path.write_bytes(header+blocks+b"\0"*8+bias.tobytes())
            w,meta,_=gguf_head(path)
        expected=np.array([-2]*16+[1.75]*16+[4]*16+[-3.5]*16,dtype=np.float32)
        np.testing.assert_array_equal(w["output_layer.weight"],np.tile(expected,(6,1)))
        np.testing.assert_array_equal(w["output_layer.bias"],bias)
        self.assertEqual(meta["trace.head_types"]["output_layer.weight"],2)


if __name__ == "__main__":unittest.main()
