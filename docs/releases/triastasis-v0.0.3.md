# Triastasis 0.0.3

Prerelease of the Windows desktop application for clean-install acceptance
testing on a second computer.

## Changes

- Library selection responds immediately while an asset loads and skips superseded queued selections.
- The asset dock is hidden in the full-page Library view.
- Interrupted-generation recovery excludes jobs already queued or running and guards against duplicate sweep restoration.
- Application versions and installer defaults target `triastasis-v0.0.3`.

## Packages and release gate

Portable distribution remains deferred until its Library storage is isolated
from installed application data.

Before promoting the prerelease to a full release:

- Build and verify the frontend, Rust application, and Windows NSIS installer from the intended release commit.
- Build the Vulkan, CUDA, and CUDA 12 compatibility runtime archives through the release workflow. ROCm remains experimental and is not a release blocker.
- Record the SHA-256 hash of every published package and runtime archive in the
  GitHub prerelease description, without separate checksum assets.
- Verify installation, GPU recommendation, runtime and model downloads, restart persistence, generation, GLB export/import, and uninstall on a clean Windows installation.
- Verify rapid Library selection, preservation of unsaved edits, and interrupted sweep recovery without duplicate queued jobs.

The prerelease tag is `triastasis-v0.0.3`; version-derived runtime downloads
require the corresponding runtime archives to be available before testing.
