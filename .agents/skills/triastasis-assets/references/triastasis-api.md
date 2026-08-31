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
| POST | `/jobs/{id}/export` | Create a new verified, portable package directory |
| DELETE | `/jobs/{id}` | Cancel a queued job |
| POST | `/imports` | Request recursive app-owned import from an absolute directory |
| GET | `/imports` | List import requests and their state |
| GET | `/imports/{id}` | Poll one import request |
| POST | `/imports/{id}/claim` | Internal desktop handoff or recovery for an unfinished request |
| POST | `/imports/{id}/complete` | Internal desktop completion report |

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

The submission response contains a stable `id`, `statusUrl`, `modelUrl`, and `imageUrl`, plus `queuePosition` and `jobsAhead`. If another generation is active or queued, report the wait and retain the job ID for polling. `GET /jobs` and `GET /jobs/{id}` return the same URLs and live queue metadata. Job views also echo accepted parameters and expose `progress` with stage, percentage, and ETA when the native server supplies them.

For a durable package, prefer `POST /jobs/{id}/export` over downloading and copying files by hand:

```json
{ "destinationPath": "C:\\absolute\\path\\to\\new-package" }
```

The destination must be an absolute path whose parent already exists. The destination itself must not exist. Triastasis copies the durable source and model, verifies SHA-256 before and after the copy, writes portable `job.json` and `asset-static.triastasis.json` records, validates the manifest, and only then publishes the package directory. It never moves or deletes the job originals and never overwrites a destination. The successful `201` response lists all exported files, byte counts, and hashes.

Use `modelUrl` only when a standalone GLB download is explicitly needed.

## App-owned imports

To import existing packages into the desktop Library, submit an absolute source
directory or one exact `.triastasis.json` manifest:

```json
{ "sourcePath": "C:\\absolute\\path\\to\\packages" }
```

For a directory, `POST /imports` recursively discovers current
`.triastasis.json` files without following directory symlinks or junctions. For
a file, it selects only that current manifest. It returns `202`, a stable import
request ID, `statusUrl`, selected manifest paths, and scan warnings. The desktop
app claims the request, validates each manifest and referenced file,
persists valid completed generations through its own gallery storage, skips
records already identified by manifest path or automation job ID, and publishes
exact results back to the request. Poll `statusUrl` until `status` is
`completed`.

An unfinished `running` request can be claimed again after a frontend refresh.
The repeated pass remains safe because already persisted paths and job IDs are
skipped before another gallery record is written.

Use `scripts/triastasis_import.sh --source-dir` for a tree or `--source` for one
manifest instead of calling these endpoints manually. A completed request may
contain per-manifest failures; treat those as a partial failure and report them.
Import requests are process-local, so resubmit after an app restart. Re-importing
is safe because the app deduplicates stable paths and job IDs.

The import path exists specifically to avoid direct writes from packaged tools
into the app's Windows local-data directory. It never modifies or deletes source
packages.

During an atomic tray restart or quit, `POST /jobs` returns `503`; retry after the service is ready. It also returns `503` when durable persistence is degraded. Check `persistenceHealthy` and surface `persistenceError` from `/capabilities` before submitting. A successful `/health` response alone does not prove that new work can be accepted or generated.

After generation, inspect `qualityWarning`. A job with a `collapsed-plane` warning remains `succeeded` because the artifact was saved, but it must not be treated as a normal result or integrated into a game. Surface the warning and improve the source with a three-quarter view, visible depth, clear lighting, and a neutral background. Do not automatically retry with BiRefNet because masking does not restore missing depth cues.

Triastasis keeps the native server and queued API resident when its window is closed. The durable queue survives app restarts and reconciles interrupted work. The tray reports live server and queue state and can reopen the UI or quit. Restart and quit remain blocked while work is running or queued.

## Resource policy

- Query `/capabilities` before submission.
- Respect `maxConcurrency` even if future hardware differs.
- Do not start another GPU-heavy model while Triastasis occupies VRAM.
