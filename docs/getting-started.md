# Getting started with Triastasis

Triastasis is a desktop app for turning one image into a textured static GLB on
your own computer. The installer adds the desktop app and matching native
runtime. The app then guides you through model setup on first launch.

Triastasis currently ships for Windows x64 and Linux x86-64.

## Install the app and native runtime

The installer detects the GPU backend, downloads the matching
`trellis-server` runtime, installs the desktop app, and writes the local runtime
configuration.

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/dmelim/Triastasis/main/install/install.sh | bash
```

### Windows

Run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/dmelim/Triastasis/main/install/install.ps1 | iex
```

Model weights are intentionally not part of the initial installation. The app
downloads and verifies the selected model bundle during onboarding.

## Complete first-run onboarding

Launch Triastasis after installation. First-run setup has three stages:

1. **Welcome** explains that generation runs locally.
2. **Credits** identifies the upstream projects and asks you to review and
   accept the terms needed for curated model downloads.
3. **Models** shows the available storage location and model bundles. Triastasis
   recommends a bundle for the detected hardware and reports its download size.

You can change the model storage location before downloading. Curated downloads
are resumable and every file is verified before activation. If compatible GGUF
files are already installed, activate the detected bundle or choose **Verify
and register**.
You can also choose a local custom model folder, which is explicitly marked as
an unverified custom bundle.

Select **Start Triastasis** after a model bundle is active. If a download is
interrupted, launch the app again and use **Verify and resume**. The Models step
reopens automatically whenever the active bundle is missing or unavailable.

## Generate your first asset

1. In **Generate**, drop an image onto the source area, browse for one, or paste
   one from the clipboard.
2. Start with the **Medium** preset. **Low** is faster and lighter. **High** uses
   the stable 1024 reconstruction path with denser geometry and a larger atlas.
   The 1536 geometry option is experimental and lives under Advanced settings.
3. Select **Generate 3D**. Additional requests can be added to the queue while a
   generation is running.
4. In **View**, rotate or zoom the model and use the texture, clay, wireframe,
   topology, UV, normal, and PBR inspection modes.
5. Use the export action in **Assets** or **Library** to save a portable GLB.
   Generated GLBs are also written automatically to the configured output
   folder.

Every completed generation is retained in the local Assets library with its
source image, settings, versions, and lineage. The Library view provides search,
filters, favourites, and version browsing.

Triastasis exports static GLBs. It does not currently rig, skin, or animate the
generated model.

## What gets stored where

| Data | Linux | Windows |
| --- | --- | --- |
| Native runtime | `~/.local/share/triastasis/runtime/` | `%LOCALAPPDATA%\triastasis\runtime\` |
| Managed model bundles | `~/.local/share/triastasis/models/installed/<revision>/<tier>/` | `%LOCALAPPDATA%\triastasis\models\installed\<revision>\<tier>\` |
| Runtime configuration | `~/.config/triastasis/config.json` | `%APPDATA%\triastasis\config.json` |
| Generated GLB output | `~/.local/share/triastasis/output/` | `%LOCALAPPDATA%\triastasis\output\` |
| Server logs | `~/.local/share/triastasis/logs/` | `%LOCALAPPDATA%\triastasis\logs\` |
| Assets library | Tauri app-local data, managed by Triastasis | Tauri app-local data, managed by Triastasis |
| Desktop app | `Triastasis.AppImage` in the install directory | Per-user Start menu installation |

The installer can set a different install or output location. The onboarding
Models step can move the managed model root before a download. Use the app's
export actions for assets instead of editing its internal library files.

For upgrades, Triastasis reads the former `trellis-studio` configuration only
when the new configuration does not exist. Existing model and output paths can
therefore carry forward without making the old directory the active location.

## Backend selection

- Supported NVIDIA GPUs use **CUDA**.
- NVIDIA Pascal and Volta devices use the separate **CUDA 12 legacy** runtime.
- AMD, Intel, and other GPUs use **Vulkan** by default.
- **ROCm** is experimental and must be selected explicitly. Its runtime requires
  a compatible, architecture-matched TheRock ROCm installation.

Vulkan is the safest fallback if automatic detection chooses an unsuitable
backend or ROCm cannot start.

## Portable installation

Download the portable application archive from the release page:

- `triastasis-windows-x64-portable.zip`
- `triastasis-linux-x86_64-portable.tar.gz`

Extract it to a writable directory. Download the matching
`trellis-<backend>-<os>-x64` runtime archive from the same release and extract
its server and libraries into the portable `runtime/` directory. Keep the
included `portable.dat` marker beside the executable.

Launch the app and complete the same first-run onboarding. Curated model bundles
are downloaded into the portable `models/` directory by default. Configuration,
output, logs, and app-managed data remain under the portable folder. Linux still
requires the system WebKitGTK 4.1 libraries.

## Advanced installer options

The normal installation needs no options. Use these only to override detected
hardware or storage:

| Linux flag / Windows parameter | Effect |
| --- | --- |
| `--backend` / `-Backend` | Force `cuda`, `cuda12`, `rocm`, or `vulkan` |
| `--gpu` / `-Gpu` | Choose the GPU index; a negative value requests CPU |
| `--port` / `-Port` | Set the native server port; default `8080` |
| `--dest` / `-Dest` | Change the runtime and output installation root |
| `--release-tag` / `-ReleaseTag` | Install artifacts from a specific Triastasis release |
| `--skip-app` / `-SkipApp` | Install only the native runtime and configuration |
| `--yes` / `-Yes` | Skip the installer confirmation prompt |

The alpha installer temporarily retains `--include-models` / `-IncludeModels`
for compatibility with the former installer-side model download. That path also
uses `--models-dir`, `--quant`, and explicit model-term acceptance. New
installations should use the in-app onboarding flow instead.

Example backend override:

```bash
./install/install.sh --backend vulkan
```

## Browser-only development

Browser mode is an advanced development workflow, not the normal installation
path. It requires a manually started `trellis-server` and an active model-bundle
directory. See the development instructions in [`app/README.md`](../app/README.md)
instead of using browser mode for first-run setup.

## Logs and diagnostics

Open **Settings**, select **Storage**, and use **Open** next to **Server logs**.
The newest timestamped file contains the server command, model directory, GPU,
backend, and full output. Triastasis keeps the most recent 20 server logs.

## Troubleshooting

- **Onboarding cannot read model storage:** confirm the selected folder exists,
  is writable, and has enough free space. Choose another location in Models if
  necessary.
- **A model download stopped:** use **Try resume again** or **Verify and resume**.
  If verification continues to fail, choose **Delete incomplete files** and
  start that bundle again. Completed bundles are not removed.
- **The model server is offline after launch:** allow the native runtime time to
  start, then check the active bundle under **Settings > Storage** and the server
  state under **Settings > Runtime**. Install the app and runtime from the same
  release.
- **The Models step appears again:** the configured model bundle is missing or
  unavailable. Activate an installed bundle, resume its download, or choose a
  custom folder. Reinstalling the app is not normally required.
- **Settings changes seem ignored:** use **Save & restart** under
  **Settings > Runtime**. If an older development build left a server process
  behind, fully quit Triastasis once before retrying.
- **Blank or flickering Linux window:** Triastasis disables WebKit's DMA-BUF
  renderer by default. If the problem remains, launch with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
- **Legacy development gallery appears empty:** launch the packaged app once so
  the old origin-bound IndexedDB data can be copied into app-local storage.
- **Browser development reports CORS errors:** use the `trellis-server` from the
  same Triastasis release as the UI and connect to its configured loopback port.
- **ROCm cannot start:** install the compatible TheRock runtime or switch to
  Vulkan.
