"""Plot native material probes at fixed-view surface points (offline research).

These are screen-sampled diagnostics, not surface-area-weighted quality scores.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from compare_material_exports import load, bilinear


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--points", type=Path, required=True)
    p.add_argument("--probes", type=Path, required=True)
    p.add_argument("--default-glb", type=Path, required=True)
    p.add_argument("--projected-glb", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    args = p.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    points = np.load(args.points / "surface.npz")
    camera = json.loads((args.points / "camera.json").read_text())
    q = np.genfromtxt(args.probes, delimiter=",", names=True)
    assert len(q) == len(points["point"])
    assert np.allclose(np.stack([q[a] for a in "xyz"],axis=1), points["point"],atol=1e-8,rtol=1e-7)
    a, b = load(args.default_glb), load(args.projected_glb)
    assert all(np.array_equal(a["arrays"][k],b["arrays"][k]) for k in a["arrays"])
    # Verify Blender's Z-up points lie within the native bounds recovered from GLB.
    native = a["arrays"]["POSITION"][:,[0,2,1]].copy(); native[:,1] *= -1
    assert np.allclose(np.stack([native.min(0),native.max(0)]),camera["bounds"],atol=1e-6)
    direct = np.stack([q["direct_"+c] for c in ("r","g","b")],axis=1)
    projected = np.stack([q["projected_"+c] for c in ("r","g","b")],axis=1)
    vd, vp = q["direct_valid"].astype(bool), q["projected_valid"].astype(bool)
    valid = vd | vp
    default = np.where(vd[:,None],direct,projected)
    project_first = np.where(vp[:,None],projected,direct)
    default[~valid] = np.nan; project_first[~valid] = np.nan
    atlas_a, atlas_b = (bilinear(m["textures"]["base"],points["uv"])[:,:3] for m in (a,b))
    size = camera["size"]
    luma = np.array([.2126,.7152,.0722])
    channels = {
        "default_rgb":default,"projected_rgb":project_first,
        "default_atlas_rgb":atlas_a,"projected_atlas_rgb":atlas_b,
        "direct_support":q["direct_support"],"projected_support":q["projected_support"],
        "distance_voxels":q["distance_voxels"],"direct_valid":vd,"projected_valid":vp,
        "default_luma":default@luma,"projected_luma":project_first@luma,
        "default_atlas_luma":atlas_a@luma,"projected_atlas_luma":atlas_b@luma,
    }
    summary = {"point_count":len(q),"method":"nearest surface, four orthographic views; screen-sampled, not area weighted",
        "both_invalid":int((~valid).sum()),"direct_invalid":int((~vd).sum()),"projected_invalid":int((~vp).sum()),
        "projection_distance_voxels_percentiles":np.percentile(q["distance_voxels"][vp],[0,25,50,75,95,99,100]).tolist(),
        "support_percentiles":{k:np.percentile(q[k],[0,25,50,75,95,99,100]).tolist() for k in ("direct_support","projected_support")},
        "views":{}}
    columns = [("default_atlas_rgb","Default atlas",None),("default_rgb","Default, before atlas",None),
        ("projected_rgb","Project-first, before atlas",None),("direct_support","Direct support",1),
        ("projected_support","Projected support",1),("distance_voxels","Projection distance (voxels)",3)]
    fig, axes = plt.subplots(4,len(columns),figsize=(19,12),layout="constrained")
    maps = {}
    for vi,view in enumerate(camera["views"]):
        mask = points["view"] == vi
        x,y = points["pixel"][mask].T
        maps[view] = {}
        for key,values in channels.items():
            shape=(size,size,3) if values.ndim==2 else (size,size)
            canvas=np.full(shape,np.nan,dtype=np.float32);canvas[y,x]=values[mask]
            maps[view][key]=canvas
        summary["views"][view]={"points":int(mask.sum()),
            "default_atlas_vs_probe_rgb_mae":float(np.nanmean(np.abs(atlas_a[mask]-default[mask]))),
            "projected_atlas_vs_probe_rgb_mae":float(np.nanmean(np.abs(atlas_b[mask]-project_first[mask])))}
        for ci,(key,title,vmax) in enumerate(columns):
            ax=axes[vi,ci];ax.set_facecolor("#26292c");ax.set_title(view+" / "+title,fontsize=9)
            values=maps[view][key]
            if vmax is None:
                rgba=np.concatenate([np.nan_to_num(values),np.isfinite(values[:,:,:1]).astype(float)],axis=2)
                ax.imshow(rgba,interpolation="nearest")
            else:
                im=ax.imshow(values,vmin=0,vmax=vmax,cmap="viridis",interpolation="nearest")
                if vi==3:fig.colorbar(im,ax=ax,orientation="horizontal",fraction=.05)
            ax.set_xticks([]);ax.set_yticks([])
        np.savez_compressed(args.output_dir/(view+"-maps.npz"),**maps[view])
    fig.savefig(args.output_dir/"sampling-maps.png",dpi=140)
    plt.close(fig)
    (args.output_dir/"summary.json").write_text(json.dumps(summary,indent=2,allow_nan=False))
    print(json.dumps(summary,indent=2))


if __name__ == "__main__":
    main()
