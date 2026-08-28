# Third-Party Notices

Triastasis contains substantial modified code from [`pwilkin/trellis.cpp`](https://github.com/pwilkin/trellis.cpp). The root [`LICENSE`](LICENSE) retains Piotr Wilkin's MIT copyright and permission notice, as required when distributing copies or substantial portions of that software. It also identifies the Triastasis modifications separately.

This file is an attribution and release-audit baseline. It does not replace the full license texts shipped with third-party source packages, dependencies, or model repositories.

## Upstream project and reference implementation

| Component | Copyright or project | License | Source |
|---|---|---|---|
| trellis.cpp and Trellis Studio | Copyright 2026 Piotr Wilkin | MIT | <https://github.com/pwilkin/trellis.cpp> |
| TRELLIS.2 reference implementation | Microsoft Corporation | MIT | <https://github.com/microsoft/TRELLIS.2> |
| TRELLIS.2-4B source checkpoints | Microsoft | MIT according to the model repository metadata | <https://huggingface.co/microsoft/TRELLIS.2-4B> |

Modifications made in this repository do not remove or replace upstream copyright notices. Contributors may add notices for their original work while continuing to distribute the combined project under the MIT License.

## Native runtime and mesh-processing components

| Component | Copyright or project | License | Location or source |
|---|---|---|---|
| ggml | The ggml authors | MIT | `thirdparty/ggml`, <https://github.com/ggml-org/ggml> |
| xatlas | Jonathan Young; Thekla, Inc.; NVIDIA Corporation | MIT | `thirdparty/xatlas/xatlas.h`, packaged text at `thirdparty/xatlas-LICENSE.txt` |
| meshoptimizer | Arseny Kapoulkine | MIT | `thirdparty/meshoptimizer/LICENSE.md` |
| Fast Quadric Mesh Simplification | Spacerat and contributors | MIT | `thirdparty/fqms/LICENSE.md` |
| stb image libraries | Sean Barrett and contributors | Public domain or MIT, at the user's option | `thirdparty/stb` source headers, packaged text at `thirdparty/stb-LICENSE.txt` |
| cpp-httplib | Yuji Hirose | MIT | `thirdparty/cpp-httplib/httplib.h`, packaged text at `thirdparty/cpp-httplib-LICENSE.txt` |
| libwebp 1.5.0 | Google LLC and contributors | BSD 3-Clause | Retrieved during configured builds from <https://github.com/webmproject/libwebp>; packaged text at `thirdparty/libwebp-COPYING.txt` |

The ggml submodule is not populated in every source checkout. Release packaging must include its license from the exact checked-out revision.

## Desktop and web application components

| Component | Copyright or project | License | Location or source |
|---|---|---|---|
| Tauri and official Tauri plugins | Tauri Programme within The Commons Conservancy | Apache-2.0 or MIT | `app/package.json`, `app/src-tauri/Cargo.toml`, <https://github.com/tauri-apps/tauri> |
| Three.js | three.js authors | MIT | `app/node_modules/three/LICENSE`, <https://github.com/mrdoob/three.js> |
| Three.js TypeScript definitions | DefinitelyTyped contributors | MIT | `app/package.json`, <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| Inter typeface | The Inter Project Authors (Rasmus Andersson and contributors) | SIL Open Font License 1.1 | `app/public/fonts/InterVariable.woff2` with its license at `app/public/fonts/LICENSE.txt`, <https://github.com/rsms/inter> |
| Lucide icons | Lucide Contributors and Feather contributors | ISC and MIT | `app/public/icons`, with the bundled license at `app/public/icons/LICENSE-lucide.txt`, <https://github.com/lucide-icons/lucide> |
| TypeScript | Microsoft Corporation | Apache-2.0 | `app/package.json`, <https://github.com/microsoft/TypeScript> |
| Vite | Evan You and Vite contributors | MIT | `app/package.json`, <https://github.com/vitejs/vite> |

Rust and npm dependencies have transitive dependencies with their own terms. A release build must generate or verify a lockfile-based license inventory rather than relying only on this direct-dependency list.

## Separately downloaded model files

The application does not store the model bundles in this Git repository or package them with a release. The desktop app downloads curated GGUF bundles from the following repository only after the user reviews and accepts the applicable upstream terms. The legacy installer can perform the same separate download when explicitly requested.

- <https://huggingface.co/ilintar/trellis2-gguf>

The embedded catalog pins repository revision `a57397bd3d351599d9729fc144b3f87c3f87d65b`. The converted repository's Hugging Face license metadata reports `other`. Its bundle combines material from multiple sources with separate terms:

| Model component | Upstream source | Terms |
|---|---|---|
| TRELLIS.2 generation checkpoints | <https://huggingface.co/microsoft/TRELLIS.2-4B> | MIT according to the upstream model metadata |
| TRELLIS decoder checkpoint reused by TRELLIS.2 | <https://huggingface.co/microsoft/TRELLIS-image-large> | MIT according to the upstream model metadata |
| DINOv3 image conditioning | <https://github.com/facebookresearch/dinov3> | DINOv3 License Agreement, not the Triastasis MIT License |
| BiRefNet background removal | <https://github.com/ZhengPeng7/BiRefNet> | MIT |

The DINOv3 License Agreement applies to the DINOv3 model material and requires acceptance by its users. Triastasis records only the local acknowledgement needed to enable its curated download buttons. That acknowledgement does not make Triastasis the licensor, replace the upstream terms, or certify that the converted repository has a complete redistribution chain.

Until the converted repository provides an explicit, verified license chain:

- Keep model downloads separate from the source-code distribution.
- Do not describe the downloaded GGUF collection as covered by this repository's MIT License.
- Do not mirror or bundle the GGUF files in a release without verifying redistribution rights for every source model.
- Record the exact repository revision and upstream model sources used by the installer.
- Continue presenting and requiring acknowledgement of model terms separately from the application's software license.

## User inputs and generated assets

The software license does not grant rights to user-provided images, recognizable likenesses, trademarks, copyrighted characters, or other third-party material. Users remain responsible for having the rights needed for their inputs and intended uses of generated assets.

## Release checklist

Before publishing a packaged release:

1. Keep the root `LICENSE` file and Piotr Wilkin's original copyright notice.
2. Keep this attribution file with the source and packaged application.
3. Include the complete license text required by each bundled dependency.
4. Generate a dependency report from `package-lock.json`, `Cargo.lock`, the CMake dependency revisions, and the populated ggml submodule.
5. Verify the model-download license chain separately from the source-code license.
6. Keep contributor copyright notices for original modifications without removing upstream notices.
7. After release assets are final, publish a `SHA256SUMS.txt` file and add artifact attestations before announcing the download links.
