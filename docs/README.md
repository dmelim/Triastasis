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

- [Research findings](findings.md) keeps short references to useful discoveries,
  their tradeoffs and the decision on whether to adopt them.
- [Research backlog](research-backlog.md) is the starting point for future runtime,
  material-quality and performance investigations, with controlled experiments
  and their current status.
- [Model and runtime opportunities](model-runtime-opportunities.md) assesses
  stage-specific sampling, conditioning reuse, upstream memory fixes, graph
  replay and other ways to get more from the existing models, with evidence
  limits and maintenance boundaries.
- [Model and runtime experiments](model-runtime-experiments.md) records measured
  preparation reuse, fixed-shape material continuation, shape-step comparisons,
  the failed memory screen, resource accounting and remaining adoption gates.
- [Library storage and validation](library-storage.md) describes current save
  outcomes, metadata snapshots, compatibility, and regression-check commands.
- [TRELLIS.2 material research](trellis-material-research.md) traces the model,
  upstream appearance reports, and the experiments needed to isolate dark materials.
- [Material diagnostics](material-diagnostics.md) explains opt-in persistent
  runtime measurements and offline analysis.
- [Decoder precision study](decoder-precision-study.md) records the controlled
  Q4/Q8/F16 comparison, observed striping reduction and remaining validation.
- [Material resolution study](material-resolution-study.md) separates generated
  material resolution from atlas size across controlled exports, with visual
  findings, timing and storage costs, and the decision to retain defaults.


For current implementation behavior, use the application and native runtime
source together with their automated tests. The inherited porting plans and
model-inspection dumps are preserved in the [native-port archive]
(archive/native-port/README.md) for provenance, not as current documentation.

For exact release behavior, use the source at that release tag.
