#!/usr/bin/env python3
"""Golden dump for SparseStructureDecoder: SS latent -> occupancy logits.
    python tools/ref_ss_dec.py
"""
import os, sys, json
os.environ["ATTN_BACKEND"] = "sdpa"
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
sys.path.insert(0, "/tmp/TRELLIS.2")
import numpy as np, torch
from safetensors.torch import load_file
from trellis2.models.sparse_structure_vae import SparseStructureDecoder

MODELS = os.environ.get("TRELLIS2_MODELS", "models")
CK = f"{MODELS}/tilarge/ckpts/ss_dec_conv3d_16l8_fp16"
ZIN = os.environ.get("SS_SAMPLES", f"{MODELS}/ref/ss_sample/samples.npy")
OUT = os.environ.get("OUT", f"{MODELS}/ref/ss_dec"); os.makedirs(OUT, exist_ok=True)
DEV = os.environ.get("REF_DEV", "cuda:1")

cfg = json.load(open(CK + ".json"))["args"]; cfg["use_fp16"] = False
with torch.device(DEV):
    dec = SparseStructureDecoder(**cfg)
dec.load_state_dict({k: v.float() for k, v in load_file(CK + ".safetensors", device=DEV).items()}, strict=False)
dec.eval()

z = torch.from_numpy(np.load(ZIN)).to(DEV).float()         # [1,8,16,16,16]
with torch.no_grad():
    logits = dec(z)                                         # [1,1,64,64,64]
occ = (logits > 0)
print("logits", list(logits.shape), "active voxels:", int(occ.sum()), "/", occ.numel())
np.save(f"{OUT}/logits.npy", np.ascontiguousarray(logits.float().cpu().numpy()))
print("DONE ->", OUT)
