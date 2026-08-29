# Triastasis 0.0.1-alpha.1

This is the first public alpha of Triastasis, a local desktop workspace for turning a single image into a textured 3D asset through the included native C++/GGML runtime.

## Highlights

- Generate textured static GLB assets locally from one image.
- Complete first-run onboarding for credits, model terms, storage, and a hardware-recommended bundle.
- Choose verified, resumable model bundles based on available hardware and storage.
- Inspect geometry, topology, UVs, normals, and PBR channels in the desktop viewer.
- Keep local assets with favorites, version lineage, and reproducible generation manifests.
- Recover interrupted generation jobs and incomplete model downloads.
- Use the loopback-only queued automation API with local tools and the optional Codex project workflow.

## Downloads

The release workflow prepares these application packages:

- Windows x64 installer and portable ZIP.
- Linux x86-64 AppImage, Debian package, and portable archive.
- Native runtime bundles for the supported CUDA, CUDA 12 legacy, Vulkan, and experimental ROCm configurations.

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
