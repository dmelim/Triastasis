# Triastasis automation API

## Local contract

Default base URL: `http://127.0.0.1:8082`

The API is loopback-only and queues jobs serially. Multiple submissions do not mean parallel GPU inference. Requests with no `Origin`, including curl and this skill, are allowed. Tauri and same-machine development origins are also allowed. Remote browser origins are rejected.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Service readiness |
| GET | `/capabilities` | GPU, VRAM, queue, and concurrency policy |
| POST | `/jobs` | Submit native multipart generation fields |
| GET | `/jobs` | List submitted jobs with live queue metadata |
| GET | `/jobs/{id}` | Poll status |
| GET | `/jobs/{id}/model` | Download a successful GLB |
| GET | `/jobs/{id}/image` | Download the original source image after success |
| DELETE | `/jobs/{id}` | Cancel a queued job |

## Multipart fields

- `image`: source image file
- `seed`: nonnegative integer
- `resolution`: `512`, `1024`, or `1536`
- `bg_removal`: `auto`, `birefnet`, or `threshold`
- `uv`: `xatlas` or `box`

Use `512`, `birefnet`, and `xatlas` for the first prototype.

## Job states

Jobs are `queued`, `running`, `succeeded`, `failed`, or `cancelled`.

A running native GPU job cannot be interrupted safely. Cancellation is reliable only while queued.

The submission response contains a stable `id`, `statusUrl`, `modelUrl`, and `imageUrl`, plus `queuePosition` and `jobsAhead`. If another generation is active or queued, report the wait and retain the job ID for polling. `GET /jobs` and `GET /jobs/{id}` return the same URLs and live queue metadata. Download successful output through `modelUrl` rather than depending on its server-side path. During an atomic tray restart or quit, `POST /jobs` returns `503`; retry after the service is ready.

Triastasis keeps the native server and queued API resident when its window is closed. The tray reports live server and queue state and can reopen the UI or quit. Restart and quit remain blocked while work is running or queued.

## Resource policy

- Query `/capabilities` before submission.
- Respect `maxConcurrency` even if future hardware differs.
- Do not start another GPU rigging model while Triastasis occupies VRAM.
- The default agent-authored Blender rig is CPU-side and does not need another model.
