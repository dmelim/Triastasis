# Triastasis showcase gallery

Seven image→3D reconstructions produced end-to-end by **trellis.cpp** (this
repository's C++/GGML reimplementation of Microsoft TRELLIS.2-4B), running on a
single Radeon 8060S (gfx1151, ROCm/HIP), pipeline version **v0.4.3**. Each asset
went through the full pipeline: DINOv3 conditioning → sparse-structure flow →
shape/texture SLAT flows → FlexiDualGrid + PBR decode → hole fill →
narrow-band DC remesh → QEM edge-collapse decimation → xatlas UV unwrap +
PBR bake → WebP-textured GLB with seam-welded normals.

Source images were generated as clean isometric studio renders (Z-Image-Turbo);
background removal is the pipeline's default BiRefNet stage (as of v0.4.3 the
neural matte is the default — the old threshold matte cut specular highlights
out of the alpha and produced holes in shiny surfaces).

All assets: res-1024 cascade, **seed 42** (embedded in each GLB's asset extras),
default 300K-face quadric target, 2048² texture atlas.

## Assets

Each `<name>/` directory contains:

- `<name>.png` — the source image fed to the pipeline
- `<name>.glb` — the textured PBR mesh output, intentionally excluded from Git;
  regenerate it with `trellis-cli <name>.png <name>.glb -s 42`
- `<name>_quad4k.png` — a 4096×4096 four-view render (front / right / back /
  left at 75° elevation, 2048×2048 per view) for detail inspection

| Asset | Description | Faces |
|-------|-------------|-------|
| **axe** | Ornate fantasy battle-axe, engraved steel head on a wooden haft | 284K |
| **chest** | Treasure chest, wood panels, brass corner fittings, steel bands, padlock | 280K |
| **cottage** | Log cabin with shingled roof, dormer, stone chimney and potted plants | 289K |
| **drone** | Sleek chrome hover-drone / concept car | 297K |
| **golem** | Stone golem, cracked-rock surface with moss and a glowing core | 291K |
| **knight** | Plate-armoured knight with blue cape and sword | 289K |
| **racer** | Red futuristic hover-racer | 292K |

### Gallery

![axe](axe/axe_quad4k.png)
![chest](chest/chest_quad4k.png)
![cottage](cottage/cottage_quad4k.png)
![drone](drone/drone_quad4k.png)
![golem](golem/golem_quad4k.png)
![knight](knight/knight_quad4k.png)
![racer](racer/racer_quad4k.png)

The preview grids show the front, right, back, and left at 75° elevation.
