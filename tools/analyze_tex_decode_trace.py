"""Audit captured texture coordinates, material layout and the selected output head.

GGUF reader is deliberately limited to F16/F32/Q4_0 requested tensors;
metadata types follow the repository's gguf.h. No model inference or mutation.
"""
import argparse
import json
from pathlib import Path
import struct

import numpy as np
from trace_material_corners import read_volume


def gguf_head(path):
    with path.open("rb") as f:
        def read(fmt):
            return struct.unpack("<"+fmt,f.read(struct.calcsize("<"+fmt)))[0]
        def string():
            return f.read(read("Q")).decode("utf-8")
        formats={0:"B",1:"b",2:"H",3:"h",4:"I",5:"i",6:"f",7:"?",10:"Q",11:"q",12:"d"}
        def value(kind):
            if kind==8:return string()
            if kind==9:
                subtype,n=read("I"),read("Q")
                return [value(subtype) for _ in range(n)]
            return read(formats[kind])
        if f.read(4)!=b"GGUF" or read("I")!=3:raise ValueError("expected GGUF v3")
        nt,nk=read("Q"),read("Q")
        metadata={}
        for _ in range(nk):
            name=string();metadata[name]=value(read("I"))
        tensors={}
        names=[]
        for _ in range(nt):
            name=string();dims=read("I");shape=[read("Q") for _ in range(dims)];kind,offset=read("I"),read("Q")
            names.append(name)
            if name in ("output_layer.weight","output_layer.bias"):tensors[name]=(shape,kind,offset)
        alignment=metadata.get("general.alignment",32)
        base=(f.tell()+alignment-1)//alignment*alignment
        result={};head_types={}
        for name,(shape,kind,offset) in tensors.items():
            head_types[name]=kind;f.seek(base+offset)
            if kind==2:
                count=int(np.prod(shape))
                if count%32:raise ValueError("Q4_0 shape is not block aligned")
                blocks=np.frombuffer(f.read(count//32*18),dtype=np.dtype([("d","<f2"),("qs","u1",16)]))
                codes=np.concatenate([blocks["qs"]&15,blocks["qs"]>>4],axis=1).astype(np.int16)-8
                result[name]=(codes.astype(np.float32)*blocks["d"].astype(np.float32)[:,None]).reshape(shape[::-1])
                result[name+".q4_scales"]=blocks["d"].astype(np.float32).reshape(shape[1],-1)
                result[name+".q4_codes"]=(codes+8).reshape(shape[1],-1,32)
            elif kind in (0,1):
                dtype=np.dtype("<f4" if kind==0 else "<f2")
                result[name]=np.frombuffer(f.read(int(np.prod(shape))*dtype.itemsize),dtype).reshape(shape[::-1]).astype(np.float32)
            else:raise ValueError(f"head tensor {name} has unsupported GGML type {kind}")
        metadata["trace.head_types"]=head_types
    return result,metadata,names


def expand_reference(coords, mask):
    """Pinned SparseChannel2Spatial: nonzero parent/octant order, x least-significant."""
    parent,octant=np.nonzero(mask.reshape(len(coords),8))
    offsets=(octant[:,None]//(2**np.arange(3))[None,:])%2
    return (coords[parent]*2+offsets).astype(np.int32)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--capture",type=Path,required=True)
    p.add_argument("--model",type=Path,required=True)
    p.add_argument("--post",type=Path,required=True)
    p.add_argument("--previous-post",type=Path,required=True)
    p.add_argument("--output",type=Path,required=True)
    args=p.parse_args();c=args.capture
    coords=np.fromfile(c/"input.coords.i32",dtype="<i4").reshape(-1,3)
    stages=[]
    for stage in range(4):
        mask=np.fromfile(c/f"guide-{stage}.u8",dtype=np.uint8)
        expected=expand_reference(coords,mask)
        actual=np.fromfile(c/f"stage-{stage}.coords.i32",dtype="<i4").reshape(-1,3)
        equal=np.array_equal(expected,actual)
        stages.append({"stage":stage,"parents":len(coords),"children":len(actual),"reference_order_identity":equal})
        if not equal:raise ValueError(f"coordinate order differs at stage {stage}")
        coords=actual
    post_coords,post_values,res=read_volume(args.post)
    previous_coords,previous_values,_=read_volume(args.previous_post)
    raw=np.fromfile(c/"output.raw.f32",dtype="<f4").reshape(-1,6)
    rows=np.fromfile(c/"selected.rows.i32",dtype="<i4").reshape(-1,4)
    h=np.fromfile(c/"selected.prehead.f32",dtype="<f4").reshape(-1,64)
    if len(rows)!=len(h) or not len(rows):raise ValueError("selected feature rows missing")
    coordinate_identity=np.array_equal(coords,post_coords)
    if not coordinate_identity or not np.array_equal(coords[rows[:,0]],rows[:,1:]):raise ValueError("output coordinate pairing differs")
    scaled=np.clip(raw*np.float32(.5)+np.float32(.5),0,1)
    if not np.array_equal(scaled,post_values):raise ValueError("PBR scale/clamp/layout differs from capture")
    weights,metadata,names=gguf_head(args.model)
    w,b=weights["output_layer.weight"],weights["output_layer.bias"]
    if w.shape!=(6,64) or b.shape!=(6,):raise ValueError("unexpected head shape")
    # Reference final layer_norm is non-affine with torch's default eps=1e-5.
    hd=h.astype(np.float64)
    normalized=(hd-hd.mean(1,keepdims=True))/np.sqrt(hd.var(1,keepdims=True)+1e-5)
    estimate=normalized@w.astype(np.float64).T+b
    half_estimate=normalized.astype(np.float16).astype(np.float64)@w.astype(np.float64).T+b
    selected=raw[rows[:,0]].astype(np.float64)
    estimates=[("fp64_accumulation",estimate),("fp16_rounded_activations",half_estimate)]
    if "output_layer.weight.q4_scales" in weights:
        # CUDA Q4_0 MMQ uses Q8_1 activations: half scales and original block
        # sums, not merely dequantized Q4 weights multiplied by full F32 inputs.
        blocks=normalized.astype(np.float32).reshape(len(h),-1,32)
        scale=np.max(np.abs(blocks),axis=2)/np.float32(127)
        q8=np.rint(blocks/scale[:,:,None]).astype(np.int32)
        d8=scale.astype(np.float16).astype(np.float64)
        s8=blocks.sum(2).astype(np.float16).astype(np.float64)
        codes=weights["output_layer.weight.q4_codes"]
        dot=np.einsum("nbi,obi->nob",q8,codes)
        quantized=((d8[:,None,:]*dot-8*s8[:,None,:])*weights["output_layer.weight.q4_scales"][None,:,:]).sum(2)+b
        estimates.append(("cuda_dp4a_q4_0_q8_1",quantized))
        # RTX 4070 uses the MMA D4 layout: signed Q4 integers, F32 activation
        # scales and no original-sum correction (mmq.cuh Q4_0 type traits).
        signed_dot=np.einsum("nbi,obi->nob",q8,codes-8)
        mma=(signed_dot*scale[:,None,:]*weights["output_layer.weight.q4_scales"][None,:,:]).sum(2)+b
        estimates.append(("cuda_mma_q4_0_q8_1",mma))
    errors={}
    for name,pred in estimates:
        d=np.abs(pred-selected);errors[name]={"max_abs_raw":float(d.max()),"mean_abs_raw":float(d.mean()),
            "max_abs_scaled":float((d*.5).max())}
    same_coords=np.array_equal(previous_coords,post_coords)
    same_material=same_coords and np.array_equal(previous_values,post_values)
    report={"stages":stages,"decoder_to_post_coordinate_identity":coordinate_identity,
        "scale_clamp_and_channel_storage_identity":True,"previous_coordinate_identity":same_coords,
        "previous_material_identity":same_material,"selected_rows":len(rows),"voxel_count":len(coords),
        "head_reference_errors":errors,"model_config":metadata.get("trellis.config_json"),
        "final_stage_tensor_names":[n for n in names if n.startswith("blocks.4.")],
        "head_shape":[6,64],"head_ggml_types":metadata["trace.head_types"],
        "precision_note":"NumPy reference uses installed weights; not a full-precision or complete PyTorch/flex_gemm decoder parity test"}
    if same_coords:report["previous_material_max_abs_error"]=float(np.max(np.abs(previous_values-post_values)))
    with args.output.open("x",encoding="utf-8") as f:json.dump(report,f,indent=2,allow_nan=False)
    print(json.dumps(report,indent=2))


if __name__ == "__main__":main()
