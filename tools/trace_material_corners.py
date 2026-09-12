"""Reconstruct native sparse trilinear probes and retain each corner contribution.

Consumes a trusted same-revision TRELLIS_DUMP_POST file and native probe CSV.
No material or geometry is changed. The dump is an unversioned research format.
"""
import argparse
import csv
import json
from pathlib import Path
import struct

import numpy as np

CHANNELS = ("r", "g", "b", "metallic", "roughness", "alpha")


def keys(coords):
    c = np.asarray(coords).astype(np.uint32).astype(np.uint64)
    return (c[...,0] << np.uint64(40)) | (c[...,1] << np.uint64(20)) | c[...,2]


def read_volume(path):
    with path.open("rb") as f:
        header = f.read(16)
    if len(header) != 16:
        raise ValueError("truncated dump header")
    v, faces, n, res = struct.unpack("<4i",header)
    if min(v,faces,n,res) <= 0:
        raise ValueError("invalid dump dimensions")
    offset = 16 + v*12 + faces*12
    if path.stat().st_size != offset + n*12 + n*24:
        raise ValueError("dump length differs from declared arrays")
    coords = np.memmap(path,mode="r",dtype="<i4",offset=offset,shape=(n,3))
    values = np.memmap(path,mode="r",dtype="<f4",offset=offset+n*12,shape=(n,6))
    if np.any(coords < 0) or np.any(coords >= res):
        raise ValueError("unexpected voxel coordinates")
    return coords,values,res


def corners(points, coords, values, res):
    """Float32, dz/dy/dx order and absent-weight renormalization match native code."""
    points = np.asarray(points,dtype=np.float32)
    grid = (points + np.float32(.5))*np.float32(res)-np.float32(.5)
    base = np.floor(grid).astype(np.int32)
    fraction = grid-base.astype(np.float32)
    offsets = np.array([(x,y,z) for z in range(2) for y in range(2) for x in range(2)],dtype=np.int32)
    locations = base[:,None,:]+offsets[None,:,:]
    source_keys = keys(coords)
    order = np.argsort(source_keys,kind="stable")
    sorted_keys = source_keys[order]
    query = keys(locations)
    # Native unordered_map keeps the last occurrence if a dump repeats a key.
    at = np.searchsorted(sorted_keys,query,side="right")-1
    safe = np.maximum(at,0)
    present = (at>=0)&(sorted_keys[safe]==query)
    ids = np.where(present,order[safe],-1)
    weights = np.ones((len(points),8),dtype=np.float32)
    for a in range(3):
        weights *= np.where(offsets[None,:,a]!=0,fraction[:,None,a],np.float32(1)-fraction[:,None,a])
    active = present & (weights > 0)
    supported = np.where(active,weights,np.float32(0))
    raw = np.where(present[:,:,None],values[np.maximum(ids,0)],np.float32(0))
    acc = np.zeros((len(points),6),dtype=np.float32)
    total = np.zeros(len(points),dtype=np.float32)
    for c in range(8):
        acc += supported[:,c,None]*raw[:,c]
        total += supported[:,c]
    valid = total > np.float32(1e-6)
    normalized = np.divide(supported,total[:,None],out=np.zeros_like(supported),where=valid[:,None])
    result = np.divide(acc,total[:,None],out=np.zeros_like(acc),where=valid[:,None])
    return dict(locations=locations,ids=ids,present=present,active=active,weights=weights,
                normalized=normalized,raw=raw,support=total,valid=valid,result=result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump",type=Path,required=True)
    parser.add_argument("--probes",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True,exist_ok=False)
    coords,values,res = read_volume(args.dump)
    q = np.genfromtxt(args.probes,delimiter=",",names=True)
    q = np.atleast_1d(q)
    report = {"resolution":res,"samples":len(q),"modes":{}}
    for mode in ("direct","projected"):
        columns = ("x","y","z") if mode=="direct" else ("projected_x","projected_y","projected_z")
        if mode=="projected" and np.any(q["projected_face"]<0):
            raise ValueError("this trace requires successful bounded projection hits")
        points = np.stack([q[k] for k in columns],axis=1).astype(np.float32)
        result = corners(points,coords,values,res)
        native = np.stack([q[mode+"_"+c] for c in CHANNELS],axis=1)
        error = np.abs(result["result"]-native)
        support_error = np.abs(result["support"]-q[mode+"_support"])
        if not np.array_equal(result["valid"],q[mode+"_valid"].astype(bool)) or error.max()>2e-6 or support_error.max()>2e-6:
            raise ValueError(f"{mode} reconstruction differs from native: value={error.max()}, support={support_error.max()}")
        ids = np.unique(result["ids"][result["active"]])
        np.savez_compressed(args.output_dir/(mode+".npz"),points=points,**result)
        with (args.output_dir/(mode+"-corners.csv")).open("x",newline="",encoding="utf-8") as f:
            writer=csv.writer(f)
            writer.writerow(["sample","corner","voxel_id","x","y","z","present","weight","normalized_weight",*CHANNELS])
            for i in range(len(q)):
                for c in range(8):
                    writer.writerow([i,c,int(result["ids"][i,c]),*result["locations"][i,c].tolist(),
                        int(result["present"][i,c]),float(result["weights"][i,c]),float(result["normalized"][i,c]),
                        *result["raw"][i,c].tolist()])
        report["modes"][mode]={"max_native_value_error":float(error.max()),"max_native_support_error":float(support_error.max()),
            "invalid_samples":int((~result["valid"]).sum()),"unique_contributing_voxels":len(ids),
            "contributing_rgb_range":[values[ids,:3].min(axis=0).tolist(),values[ids,:3].max(axis=0).tolist()]}
    (args.output_dir/"validation.json").write_text(json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps(report,indent=2))


if __name__ == "__main__":
    main()
