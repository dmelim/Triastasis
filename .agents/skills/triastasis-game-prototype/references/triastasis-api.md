# Triastasis automation API

## Local contract

The automation API uses the port immediately above the configured native server port. The default base URL is `http://127.0.0.1:8082`; pass the actual URL to the helper with `--api` when the server port was changed.

The API is loopback-only and queues jobs serially. Multiple submissions do not mean parallel GPU inference. Requests with no `Origin`, including curl and this skill, are allowed. Tauri and same-machine development origins are also allowed. Remote browser origins are rejected.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Automation HTTP process availability |
| GET | `/capabilities` | GPU, VRAM, queue, and concurrency policy |
| POST | `/jobs` | Submit native multipart generation fields |
| GET | `/jobs` | List submitted jobs with live queue metadata |
| GET | `/jobs/{id}` | Poll status |
| GET | `/jobs/{id}/model` | Download a successful GLB |
| GET | `/jobs/{id}/image` | Download the original source image after success |
| DELETE | `/jobs/{id}` | Cancel a queued job |

## Multipart fields

Unknown fields and conflicting aliases return `400`. The queue assigns `request_id`; clients must not supply it.

| Field | Accepted names | Values | Default when omitted |
|---|---|---|---|
| Source image | `image` | binary image part, required | none |
| Seed | `seed` | integer `0` to `4294967295` | `42` |
| Geometry resolution | `resolution` | `512`, `1024`, or `1536` | `512` |
| Background removal | `bg_removal`, `bgRemoval` | `auto`, `birefnet`, or `threshold` | `auto` |
| UV unwrap | `uv` | `xatlas` or `box` | `xatlas` |
| Texturing | `texture`, `texture_enabled`, `textureEnabled` | `on`, `off`, `true`, `false`, `1`, or `0` | native default, on |
| Target faces | `target_faces`, `targetFaces` | integer `10000` to `1000000` | per-resolution default |
| Atlas size | `atlas`, `atlas_size`, `atlasSize` | integer `128` to `4096` | per-resolution default |
| Texture decode resolution | `tex_res`, `texRes`, `texture_resolution`, `textureResolution` | `512` or `1024` | automatic |
| Remesh band | `band`, `remesh_band`, `remeshBand` | integer `0` to `8` | resolution-scaled default |
| Texture encoding | `webp`, `texture_encoding`, `textureEncoding` | `auto`, `webp`, or `png`; toggle spellings are also accepted | WebP when available |

Use `512`, `birefnet`, and `xatlas` for the first prototype.

## Job states

Jobs are `queued`, `running`, `succeeded`, `failed`, or `cancelled`.

A running native GPU job cannot be interrupted safely. Cancellation is reliable only while queued.

The submission response contains a stable `id`, `statusUrl`, `modelUrl`, and `imageUrl`, plus `queuePosition` and `jobsAhead`. If another generation is active or queued, report the wait and retain the job ID for polling. `GET /jobs` and `GET /jobs/{id}` return the same URLs and live queue metadata. Job views also echo accepted parameters and expose `progress` with stage, percentage, and ETA when the native server supplies them. Download successful output through `modelUrl` rather than depending on its server-side path.

During an atomic tray restart or quit, `POST /jobs` returns `503`; retry after the service is ready. It also returns `503` when durable persistence is degraded. Check `persistenceHealthy` and surface `persistenceError` from `/capabilities` before submitting. A successful `/health` response alone does not prove that new work can be accepted or generated.

After generation, inspect `qualityWarning`. A job with a `collapsed-plane` warning remains `succeeded` because the artifact was saved, but it must not be treated as a normal result or integrated into a game. Surface the warning and improve the source with a three-quarter view, visible depth, clear lighting, and a neutral background. Do not automatically retry with BiRefNet because masking does not restore missing depth cues.

Triastasis keeps the native server and queued API resident when its window is closed. The durable queue survives app restarts and reconciles interrupted work. The tray reports live server and queue state and can reopen the UI or quit. Restart and quit remain blocked while work is running or queued.

## Resource policy

- Query `/capabilities` before submission.
- Respect `maxConcurrency` even if future hardware differs.
- Do not start another GPU-heavy model while Triastasis occupies VRAM.
