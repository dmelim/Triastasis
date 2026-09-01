Triastasis - portable (no-install) build
============================================

This portable build keeps its app-managed files inside this folder and does not
need an installer. Setup downloads the selected runtime and model files, but it
does not require a terminal, PowerShell, or manual archive extraction.

Layout (all next to this app):
  portable.dat   <- marker that enables portable mode -- do not delete
  data/          <- config + generated GLBs are written here (created on first run)
  runtime/       <- verified generation runtime installed by setup
  models/        <- verified model files installed by setup

First-time setup
----------------
  1. Launch triastasis.exe.
  2. Follow the Runtime step. Triastasis detects the GPU, recommends a compatible
     runtime, downloads it from the matching release, verifies its SHA-256, and
     installs it in the portable "runtime" folder.
  3. Review the upstream model terms and choose a verified, resumable model
     download. Triastasis stores it in the portable "models" folder.
  4. Add an image and generate.

Advanced users can instead put an existing compatible runtime in the "runtime"
folder or select a custom model folder in Settings. Manual setup is optional.
Custom model files are unverified and remain under their upstream terms.

To uninstall: delete this folder.

Linux note: the app needs the system webkit2gtk-4.1 runtime installed.
