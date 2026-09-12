# Triastasis documentation

## User guides

- [Getting started](getting-started.md) covers installation, first-run onboarding,
  model setup, the first generation, portable use, storage, and troubleshooting.
- [Source image generation prompt](source-image-generation-prompt.md) provides
  reference-image templates and a quality gate for reconstruction inputs.
- [Generation manifests](generation-manifests.md) documents the current
  `.triastasis.json` format, importing, relinking, and recovery.

## Release information

Release notes under [`releases/`](releases/) describe a specific published or
prepared version. They are not a substitute for the current getting-started
guide.

## Implementation details

- [Research backlog](research-backlog.md) is the starting point for future runtime,
  material-quality and performance investigations, with controlled experiments
  and their current status.

- [Library storage and validation](library-storage.md) describes current save
  outcomes, metadata snapshots, compatibility, and regression-check commands.
- [TRELLIS.2 material research](trellis-material-research.md) traces the model,
  upstream appearance reports, and the experiments needed to isolate dark materials.
- [Material diagnostics](material-diagnostics.md) explains opt-in persistent
  runtime measurements and offline analysis.


For current implementation behavior, use the application and native runtime
source together with their automated tests. The inherited porting plans and
model-inspection dumps are preserved in the [native-port archive]
(archive/native-port/README.md) for provenance, not as current documentation.

For exact release behavior, use the source at that release tag.
