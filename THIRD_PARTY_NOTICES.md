# Third-Party Notices

This repository is a modified version of [`pwilkin/trellis.cpp`](https://github.com/pwilkin/trellis.cpp). The project is distributed under the MIT License found in [`LICENSE`](LICENSE). That license and the original copyright notice must remain with copies or substantial portions of the software.

This file is an attribution and release-audit baseline. It does not replace the full license texts shipped with third-party source packages, dependencies, or model repositories.

## Upstream project and reference implementation

| Component | Copyright or project | License | Source |
|---|---|---|---|
| trellis.cpp and Trellis Studio | Copyright 2026 Piotr Wilkin | MIT | <https://github.com/pwilkin/trellis.cpp> |
| TRELLIS reference implementation | Microsoft Corporation | MIT | <https://github.com/microsoft/TRELLIS> |
| TRELLIS.2-4B source checkpoints | Microsoft | MIT according to the model repository metadata | <https://huggingface.co/microsoft/TRELLIS.2-4B> |

Modifications made in this repository do not remove or replace upstream copyright notices. Contributors may add notices for their original work while continuing to distribute the combined project under the MIT License.

## Native runtime and mesh-processing components

| Component | Copyright or project | License | Location or source |
|---|---|---|---|
| ggml | The ggml authors | MIT | `thirdparty/ggml`, <https://github.com/ggml-org/ggml> |
| xatlas | Jonathan Young; Thekla, Inc.; NVIDIA Corporation | MIT | `thirdparty/xatlas/xatlas.h` |
| meshoptimizer | Arseny Kapoulkine | MIT | `thirdparty/meshoptimizer/LICENSE.md` |
| Fast Quadric Mesh Simplification | Spacerat and contributors | MIT | `thirdparty/fqms/LICENSE.md` |
| stb image libraries | Sean Barrett and contributors | Public domain or MIT, at the user's option | `thirdparty/stb` source headers |
| cpp-httplib | Yuji Hirose | MIT | `thirdparty/cpp-httplib/httplib.h` |
| libwebp | Google LLC and contributors | BSD 3-Clause | Retrieved during configured builds from <https://github.com/webmproject/libwebp> |

The ggml submodule is not populated in every source checkout. Release packaging must include its license from the exact checked-out revision.

## Desktop and web application components

| Component | Copyright or project | License | Location or source |
|---|---|---|---|
| Tauri and official Tauri plugins | Tauri Programme within The Commons Conservancy | Apache-2.0 or MIT | `app/package.json`, `app/src-tauri/Cargo.toml`, <https://github.com/tauri-apps/tauri> |
| Three.js | three.js authors | MIT | `app/node_modules/three/LICENSE`, <https://github.com/mrdoob/three.js> |
| Three.js TypeScript definitions | DefinitelyTyped contributors | MIT | `app/package.json`, <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| model-viewer | Google LLC | Apache-2.0 | `app/public/vendor/model-viewer.min.js`, <https://github.com/google/model-viewer> |
| Lit code contained in the vendored model-viewer bundle | Google LLC | BSD 3-Clause | License headers inside `app/public/vendor/model-viewer.min.js` |
| Inter typeface | The Inter Project Authors (Rasmus Andersson and contributors) | SIL Open Font License 1.1 | `app/public/fonts/InterVariable.woff2` with its license at `app/public/fonts/LICENSE.txt`, <https://github.com/rsms/inter> |
| Phosphor Icons | Copyright 2023 Phosphor Icons | MIT | `app/public/icons`, <https://github.com/phosphor-icons/core> |
| TypeScript | Microsoft Corporation | Apache-2.0 | `app/package.json`, <https://github.com/microsoft/TypeScript> |
| Vite | Evan You and Vite contributors | MIT | `app/package.json`, <https://github.com/vitejs/vite> |

The vendored model-viewer file remains in the working tree even though the experimental direct Three.js viewer no longer imports it. Until it is removed from source and release artifacts, its notices still apply.

Rust and npm dependencies have transitive dependencies with their own terms. A release build must generate or verify a lockfile-based license inventory rather than relying only on this direct-dependency list.

## Model files downloaded by the installer

The application does not store the approximately 16.5 GB model set in this Git repository. The installers currently download converted GGUF files from:

- <https://huggingface.co/ilintar/trellis2-gguf>

That repository's Hugging Face license metadata currently reports `other`. The files are conversions of several upstream models, including Microsoft TRELLIS.2, DINOv3 image conditioning, and BiRefNet background removal. Each upstream model may carry its own license or acceptable-use terms.

Until the converted repository provides an explicit, verified license chain:

- Keep model downloads separate from the source-code distribution.
- Do not describe the downloaded GGUF collection as covered by this repository's MIT License.
- Do not mirror or bundle the GGUF files in a release without verifying redistribution rights for every source model.
- Record the exact repository revision and upstream model sources used by the installer.
- Present model terms separately from the application's software license where appropriate.

## User inputs and generated assets

The software license does not grant rights to user-provided images, recognizable likenesses, trademarks, copyrighted characters, or other third-party material. Users remain responsible for having the rights needed for their inputs and intended uses of generated assets.

## Release checklist

Before publishing a packaged release:

1. Keep the root `LICENSE` file and Piotr Wilkin's original copyright notice.
2. Keep this attribution file with the source and packaged application.
3. Include the complete license text required by each bundled dependency.
4. Generate a dependency report from `package-lock.json`, `Cargo.lock`, the CMake dependency revisions, and the populated ggml submodule.
5. Verify the model-download license chain separately from the source-code license.
6. Add contributor copyright notices for original modifications if desired, without removing upstream notices.
