# Triastasis 0.0.5

This is an app-only maintenance release focused on dialog consistency and runtime upgrades.

## Changes

- Use consistent styling and button order for rename, project, confirmation, unsaved-edit, and generation-import dialogs.
- Keep keyboard focus within dialogs and restore it when they close. Support Enter, Escape, the close button, and backdrop dismissal consistently.
- Keep generation-import dialogs open while an operation is busy, including after repeated Escape presses.
- Track the native runtime version separately from the application version. Upgrading from 0.0.4 keeps a matching installed runtime without another runtime download or update notice.

## Runtime and downloads

Runtime 0.0.4, unchanged, copied from triastasis-v0.0.4. Runtime archives are verified against that release's `SHA256SUMS` before being reused.

The Windows x64 release provides an NSIS installer, a portable ZIP, and Vulkan, CUDA, and CUDA 12 compatibility runtime archives. ROCm remains experimental. One `SHA256SUMS` file covers the application packages and runtime archives. Model weights remain a separate download.

## Alpha limitations

- The Windows installer is not code-signed, so Windows may show an unknown-publisher or SmartScreen warning.
- The portable ZIP keeps configuration, runtime, and models beside the application, but saved Library records still use Windows application data and are shared with an installed copy. It is not an isolated Library or a complete backup.
- Suggested GLB export names can omit the final dotted portion of an asset label. Choose the desired filename in the Save dialog; exported models are unaffected.
- Generated assets are static GLBs; rigging and animation are not provided.
- Linux remains unsupported by this release.
