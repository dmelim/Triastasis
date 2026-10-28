# Triastasis 0.0.5

This is an app-only maintenance release focused on generation reliability, model setup, dialog consistency, and runtime upgrades.

## Prerelease refresh, 28 October 2026

The Windows installer and portable ZIP now include the fixes below and replace the earlier 0.0.5 packages. This release remains a prerelease. Runtime archives are unchanged.

## Changes

- Use consistent styling and button order for rename, project, confirmation, unsaved-edit, and generation-import dialogs.
- Keep keyboard focus within dialogs and restore it when they close. Support Enter, Escape, the close button, and backdrop dismissal consistently.
- Keep generation-import dialogs open while an operation is busy, including after repeated Escape presses.
- Track the native runtime version separately from the application version. Upgrading from 0.0.4 keeps a matching installed runtime without another runtime download or update notice.
- Recognize catalog model bundles in existing folders, verify their checksums in place, and show their storage usage without moving model files or replacing the selected bundle.
- Guard overlapping model downloads and location changes, and handle resume, pause, and cancellation boundaries consistently.
- Keep sweep inputs and filenames stable, preserve the original package and asset grouping when recovering a generation, and retain asset metadata when previews finish saving.
- Recover queued and interrupted jobs conservatively, validate generation seeds, and validate replacement GLBs before changing an existing package.
- Keep each viewed model's source image and mesh list separate from the next generation input, and reset orthographic framing correctly.
- Show operation errors inside the open dialog and reset dropdown accessibility state when its list closes.
- Tie owned Windows server processes to the application lifetime, preserve managed paths when moving a portable folder, and allow the matching runtime release link to open.
- Preserve existing configuration when rerunning the standalone PowerShell installer and select a runtime compatible with the detected NVIDIA GPU.

## Runtime and downloads

Runtime 0.0.4, unchanged, copied from triastasis-v0.0.4. Runtime archives are verified against that release's `SHA256SUMS` before being reused.

The Windows x64 release provides an NSIS installer, a portable ZIP, and Vulkan, CUDA, and CUDA 12 compatibility runtime archives. ROCm remains experimental. One `SHA256SUMS` file covers the application packages and runtime archives. Model weights remain a separate download.

## Alpha limitations

- The Windows installer is not code-signed, so Windows may show an unknown-publisher or SmartScreen warning.
- The portable ZIP keeps configuration, runtime, and models beside the application, but saved Library records still use Windows application data and are shared with an installed copy. It is not an isolated Library or a complete backup.
- Suggested GLB export names can omit the final dotted portion of an asset label. Choose the desired filename in the Save dialog; exported models are unaffected.
- Generated assets are static GLBs; rigging and animation are not provided.
- Linux remains unsupported by this release.
