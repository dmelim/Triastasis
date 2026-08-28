# Getting started with Triastasis

**Triastasis** is a desktop app that runs Microsoft TRELLIS.2 image→3D
reconstruction locally (via `trellis.cpp`) and previews the result in an
interactive 3D viewer. This guide gets a brand-new machine from zero to a
generated `.glb`.

## One-command install

The installer auto-detects your GPU runtime (**CUDA → ROCm → Vulkan** fallback),
downloads the matching `trellis-server` build, installs the desktop app, and
writes the config the app reads on launch.

**Model weights are not part of the installer.** The app is a small initial
download; on first launch, Triastasis offers a choice of model bundles between
approximately 6.5 GB and 16.5 GB with verified, resumable downloads and a
hardware-based recommendation. To pre-download weights in the installer instead
(legacy behavior, kept for one transition release), pass `-IncludeModels` /
`--include-models`.

### Linux (x86-64)

```bash
curl -fsSL https://raw.githubusercontent.com/dmelim/Triastasis/main/install/install.sh | bash
```

### Windows (x64), in PowerShell

```powershell
irm https://raw.githubusercontent.com/dmelim/Triastasis/main/install/install.ps1 | iex
```

That's it. Launch **Triastasis**, drop in an image, and click **Generate 3D**.

## What gets installed where

| what | Linux | Windows |
|------|-------|---------|
| server + runtime libs | `~/.local/share/triastasis/runtime/` | `%LOCALAPPDATA%\triastasis\runtime\` |
| model bundles (in-app download) | `~/.local/share/triastasis/models/installed/…` (configurable in-app) | `%LOCALAPPDATA%\triastasis\models\installed\…` |
| app config | `~/.config/triastasis/config.json` | `%APPDATA%\triastasis\config.json` |
| desktop app | `.AppImage` in the install dir | installed via the setup .exe (Start menu) |

Upgrades still read the former `trellis-studio` config location when the new
Triastasis config does not exist, so existing model and output paths carry over.

## Installer options

Both scripts accept the same flags (`--flag value` on Linux, `-Flag value` on
Windows):

| flag | effect |
|------|--------|
| `--backend cuda\|rocm\|vulkan` | force a runtime instead of auto-detecting |
| `--gpu N` | GPU index (default `0`; `<0` = CPU) |
| `--port P` | server port (default `8080`) |
| `--dest DIR` | install location |
| `--models-dir DIR` | where to store weights when using `--include-models` (e.g. a bigger drive) |
| `--quant q8\|q4` | quantized weights for `--include-models`: `q8` ~10 GB (near-lossless), `q4` ~6.5 GB. Default is f16 (~16.5 GB). |
| `--include-models` / `-IncludeModels` | LEGACY: download weights in the installer instead of in-app on first launch (one transition release) |
| `--skip-app` / `-SkipApp` | don't download the desktop app |
| `-y` / `-Yes` | don't prompt for confirmation |

Examples:

```bash
# force Vulkan; pick the model bundle inside the app on first launch
./install/install.sh --backend vulkan

# legacy: pre-download Q8 weights on a fast drive during install
./install/install.sh --backend vulkan --include-models --models-dir /mnt/ssd/trellis --quant q8
```

## Backend detection

- **NVIDIA** → CUDA (the bundle ships the CUDA runtime; nothing else needed).
- **AMD / Intel / everything else** → **Vulkan**, which is self-contained and, on
  the validated Strix Halo iGPU, actually the fastest backend. The installer
  notes when an AMD card is ROCm-capable.
- **ROCm** is opt-in with `--backend rocm`. The published ROCm bundle needs a
  matching TheRock ROCm 7.x runtime on your library path (`LD_LIBRARY_PATH` /
  `PATH`); if the server won't start, re-run with `--backend vulkan`.

## Using the app

1. **Drop or pick an image** (or paste from the clipboard).
2. Adjust **Resolution** (512 light / 1024 cascade / 1536 high), **seed**,
   **background removal**, and **UV unwrap** if you like.
3. **Generate 3D** — this takes a few minutes; the live stage line shows progress.
4. **Rotate/zoom** in the preview; **Reset view** re-frames; **Save GLB…** exports.
5. Every result is saved to a local **gallery** (native app storage) — click a thumbnail to
   reload it, even after restarting the app.

## No app? Use it in a browser

The UI is a plain web bundle, so you can skip the desktop app entirely:

```bash
# start the server the installer downloaded
~/.local/share/triastasis/runtime/trellis-server \
  --models ~/.local/share/triastasis/models --port 8080
```

then open the built UI (or `npm run dev` in `app/`) and point it at
`127.0.0.1:8080` in **Settings**.

## Portable (no-install)

Prefer not to install anything? Grab the portable archive from the releases page
instead of running an installer:

- Windows: `triastasis-windows-x64-portable.zip`
- Linux: `triastasis-linux-x86_64-portable.tar.gz`

Unzip it anywhere and run the app in place — it keeps **everything inside that
folder** (config and generated GLBs go to `./data/`, and it auto-detects a
`./runtime/` server and `./models/` weights next to it), so nothing is written to
your system. Drop the `trellis-<backend>-<os>-x64` runtime into a `runtime/`
folder and the GGUFs into `models/` (or point it at existing ones in Settings),
and you're set. Delete the folder to uninstall. (Linux still needs system
`webkit2gtk-4.1`.)

## Where are the logs?

Every server launch is written to a timestamped log file (the last 20 are kept):

| | Linux | Windows |
|--|-------|---------|
| installed | `~/.local/share/triastasis/logs/` | `%LOCALAPPDATA%\triastasis\logs\` |
| portable | `./data/logs/` next to the app | `.\data\logs\` next to the app |

Open the folder straight from **Settings → Server logs → Open**. The log records
the exact `--models` path, GPU index and backend the server was launched with,
plus its full stdout/stderr — attach the newest file to a bug report.

## Troubleshooting

- **"Server is offline"** right after generating — the pipeline is still loading
  the models; large weights take a moment on the first request.
- **Blank white window / the desktop flickers on launch** (common on NVIDIA and
  some Wayland setups) — the app now disables WebKit's DMA-BUF renderer on Linux
  automatically. If you still hit it, launch with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`; to opt back in, set it to `0`.
- **Legacy gallery is empty immediately after a development update** — launch
  the packaged app once. Triastasis copies the old origin-bound IndexedDB gallery
  into app-local storage; later packaged and development builds share it.
- **Settings changes (e.g. models directory) seem ignored** — an older build
  could reuse a server left running by a previous crash. Fully quit the app (or
  reboot) once after updating; the current build kills the server with the app
  and no longer reuses a stale one when you hit **Save & restart**.
- **The app can't read the server response / a CORS error appears** — the app
  needs a `trellis-server` build that sends CORS headers (v0.4.4+). The installer
  pulls the *latest* release, so update if you're on an older server bundle.
- **"setup needed" banner** — no `config.json` was found. Re-run the installer, or
  open **Settings** and point it at your models directory.
- **ROCm server won't start** — install the gfx-matched TheRock ROCm runtime, or
  switch to Vulkan (`--backend vulkan`).
