Triastasis - portable (no-install) build
============================================

This is a self-contained build: everything stays inside this folder and nothing
is written to the system (no installer, no AppData / registry / config dirs).

Layout (all next to this app):
  portable.dat   <- marker that enables portable mode -- do not delete
  data/          <- config + generated GLBs are written here (created on first run)
  runtime/       <- put the trellis-server runtime here (see setup)
  models/        <- put the GGUF model weights here (see setup)

First-time setup
----------------
  1. Download the server runtime for your GPU from the releases page and extract
     it into a "runtime" folder next to this app:
       trellis-cuda-<os>-x64      (NVIDIA)
       trellis-cuda12-<os>-x64    (NVIDIA Pascal/Volta, e.g. Tesla P100)
       trellis-rocm-<os>-x64      (AMD; needs the matching ROCm runtime on PATH)
       trellis-vulkan-<os>-x64    (AMD / Intel / universal fallback)
  2. Launch the app (triastasis / triastasis.exe). On first launch, review the
     upstream model terms and choose a verified, resumable model download. The
     app stores it in the portable "models" folder.
  3. Add an image and generate.

You can instead put an existing runtime and compatible model folder next to the
app, or select a custom model folder in Settings. Custom model files are
unverified and remain under their upstream terms.

To uninstall: delete this folder.

Linux note: the app needs the system webkit2gtk-4.1 runtime installed.
