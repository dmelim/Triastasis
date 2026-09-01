# Triastasis 0.0.1-alpha.1

This is the first public alpha of Triastasis, a local desktop workspace for turning a single image into a textured 3D asset through a native C++/GGML runtime. It is designed to make local image-to-3D generation approachable for non-developers as well as technical users.

## Highlights

- Generate textured static GLB assets locally from one image.
- Complete guided first-run onboarding for runtime installation, credits, model terms, storage, and a hardware-recommended bundle.
- Install the recommended verified runtime without using a terminal, PowerShell, or manually extracting an archive.
- Choose verified, resumable model bundles based on available hardware and storage.
- Inspect geometry, topology, UVs, normals, and PBR channels in the desktop viewer.
- Keep local assets with favorites, version lineage, and reproducible generation manifests.
- Recover interrupted generation jobs and incomplete model downloads.
- Use the loopback-only queued automation API with local tools and the optional Codex project workflow.

## Downloads

This alpha release provides:

- Windows x64 installer and portable ZIP.
- Windows native runtime bundles for CUDA, CUDA 12 compatibility, Vulkan, and experimental ROCm configurations. Triastasis downloads and verifies the selected runtime during onboarding.

Linux support remains work in progress and is not supported by this release.

Model weights are not included in the application packages. Triastasis offers separate curated downloads after the applicable upstream terms are reviewed and accepted.

## Alpha limitations

- Generated assets are static GLBs. Triastasis does not currently provide rigging, skinning, or animation-ready output.
- Compatibility with unpublished internal builds, the former Trellis Studio package identity, and manually copied application-data directories is not guaranteed.
- On Windows, manually copied data can retain permissions or application capability metadata that prevents the app from reading it. Use a clean profile for release testing and preserve backups before attempting a migration.
- The Windows installer is not code-signed yet, so Windows may show an unknown-publisher or SmartScreen warning.
- Hardware and driver combinations vary. Vulkan is the default fallback; ROCm remains experimental and requires a compatible external runtime.
- This alpha has no automatic updater. Install later versions from their published release packages.

Please report ordinary bugs through the repository issue template. Report suspected vulnerabilities privately using the instructions in `SECURITY.md`.

## Open-source lineage

Triastasis is an independent downstream project based on Piotr Wilkin's `trellis.cpp` and Trellis Studio, which port Microsoft TRELLIS.2 to a native C++/GGML runtime. Triastasis is not affiliated with or endorsed by Microsoft. See `THIRD_PARTY_NOTICES.md` for software and separately downloaded model terms.
