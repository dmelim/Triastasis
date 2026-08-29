# Archived native-port engineering notes

> Historical archive. These files document the investigation and implementation
> of the original native TRELLIS.2 port. They are not maintained product
> documentation, and some contain assumptions later disproved by the source and
> tests.

This directory is retained for provenance and contributor archaeology. It is not
required to build, package, install, or run Triastasis.

Known supersessions and corrections:

- `00-synthesis.md`, `26-mvp-synthesis.md`, and `IMPL_NOTES_*` are completed
  implementation plans.
- `20-dinov3.md` supersedes the checkpoint naming and QKV-bias claims in
  `02-image_feature.md`.
- `27-reference-postprocess.md` records corrections to `01-pipeline.md`,
  `11-tex_dec.md`, `12-ovoxel_mesh.md`, and `25-mesh_glb.md`.
- The addenda at the end of `28-divergence-matrix.md` supersede its original
  matrix and backlog.
- `29-perf-profile.md` is a dated hardware snapshot, not a performance promise.
- Paths beginning with `/tmp/`, `/devel/`, or `docs/spec/` record the original
  research environment and former directory layout.

Use the current source and automated tests as the authority for implementation
behavior.