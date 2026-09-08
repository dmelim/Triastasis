# Triastasis 0.0.2

Release candidate for the Windows desktop application.

## Changes

- Library loading placeholders and on-demand GLB loading reduce startup work.
- Safer save and migration handling protects existing asset versions.
- Library automation supports inspecting, importing, exporting, and recovering asset packages with duplicate and conflict checks.
- Viewer rendering and geometry-history handling reduce unnecessary work.
- Settings validation and save/restart feedback are clearer.

## Packages and release gate

This release ships the Windows x64 installer with a SHA-256 sidecar. Portable distribution is deferred until its Library storage is isolated.
The release tag is `triastasis-v0.0.2`; runtime downloads use that tag.
CUDA, CUDA 12 compatibility, and Vulkan runtime archives and their checksums
must be built by the release workflow and available before publication is
considered complete. ROCm remains experimental.

Before publication, verify the packaged application on a clean Windows
installation: onboarding, runtime/model download, generation, restart
persistence, GLB export/import, and uninstall. A successful local build does
not replace these acceptance checks.

Assets remain static GLBs; rigging and animation are not provided. Editing
controls remain hidden. Model weights are downloaded separately after accepting
their upstream terms.
