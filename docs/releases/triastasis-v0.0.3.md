# Triastasis 0.0.3 — replacement prerelease

This replacement prerelease restores the checksum files required by runtime
installation and supplies all four runtime archives. The earlier September 21,
2026 prerelease was incomplete and runtime setup failed because its checksum
files were missing.

The desktop application code is unchanged by this replacement. Existing 0.0.3
installers use the same release URLs and can retry runtime setup once these
assets are published. The replacement installer is rebuilt from the release
commit; its checksum identifies the downloadable package.

## Changes since 0.0.2

- Library selection responds immediately while an asset loads and skips superseded queued selections.
- The asset dock is hidden in the full-page Library view.
- Interrupted-generation recovery excludes jobs already queued or running and guards against duplicate sweep restoration.
- Application versions and installer defaults target `triastasis-v0.0.3`.

## Runtime provenance and checksums

All four runtime ZIPs (Vulkan, CUDA, CUDA 12 compatibility, and experimental
ROCm) are reused byte-for-byte from `triastasis-v0.0.2`. Native sources,
third-party dependency contents, and native build configuration are unchanged.
Each archive retains its matching `.sha256` file, as required by the existing
desktop downloader. `SHA256SUMS` also lists every downloadable package.

Release builds are manually dispatched when binaries need rebuilding.
Publishing a release does not automatically rebuild or overwrite reused assets.

## Availability

This remains a prerelease pending clean-Windows acceptance testing. Download
`triastasis-windows-x64-setup.exe`; the app downloads its runtime and models during
setup. ROCm remains experimental. Portable distribution remains deferred until
its Library storage is isolated from installed application data.
