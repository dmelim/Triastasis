# Triastasis automation API

The desktop app starts a local queued API on the port immediately after the
configured TRELLIS server port. With the Lab defaults, the native server is on
`127.0.0.1:8081` and automation is on `127.0.0.1:8082`.

The API binds to loopback only. It accepts multiple jobs, but deliberately runs
one generation at a time. `GET /capabilities` reports the detected GPU, VRAM,
queue counts, and enforced concurrency policy. Browser requests must also carry
no `Origin` header or a loopback/Tauri origin (`localhost`, `127.0.0.1`,
`::1`, `tauri.localhost`, or the legacy `tauri://localhost` form); remote
origins are rejected even though the API supports the simple multipart POST
used by the skill.

## Endpoints

- `GET /health`
- `GET /capabilities`
- `POST /jobs` (multipart; fields below)
- `GET /jobs`
- `GET /jobs/{id}`
- `GET /jobs/{id}/model`
- `GET /jobs/{id}/image` for the original source image after success
- `DELETE /jobs/{id}` to cancel a queued job

## `POST /jobs` fields

The queue validates every field before accepting a job and forwards the exact
settings to the native server. Invalid, unknown, or conflicting fields return
`400`; nothing is silently defaulted.

| Field | Accepted names | Values | Default when omitted |
|---|---|---|---|
| Source image | `image` | binary image part (required) | — |
| Seed | `seed` | integer 0–4294967295 | `42` |
| Geometry resolution | `resolution` | `512`, `1024`, or `1536` | `512` |
| Background removal | `bg_removal`, `bgRemoval` | `auto`, `birefnet`, `threshold` | `auto` |
| UV unwrap | `uv` | `xatlas`, `box` | `xatlas` |
| Texturing | `texture`, `texture_enabled`, `textureEnabled` | `on`/`off`/`true`/`false`/`1`/`0` | native default (on) |
| Target faces | `target_faces`, `targetFaces` | integer 10000–1000000 | per-resolution QEM default |
| Atlas size | `atlas`, `atlas_size`, `atlasSize` | integer 128–4096 | per-resolution default |
| Texture decode resolution | `tex_res`, `texRes`, `texture_resolution`, `textureResolution` | `512` or `1024` | automatic |
| Remesh band | `band`, `remesh_band`, `remeshBand` | integer 0–8 | resolution-scaled default |
| Texture encoding | `webp`, `texture_encoding`, `textureEncoding` | `auto`, `webp`, `png` (plus the toggle spellings `on`/`off`) | WebP if available |

Notes:

- Supplying the same parameter twice through different alias spellings is
  accepted only when both values are identical; conflicting values return
  `400`.
- `request_id` cannot be supplied by clients. The queue assigns its stable job
  ID as the native request ID used by `/progress/{job-id}`; client attempts
  return `400`.
- The job status views (`GET /jobs/{id}`) echo back every accepted parameter;
  omitted optional fields appear as `null`, meaning the backend default was in
  effect.

## Submit a job

```powershell
$response = curl.exe http://127.0.0.1:8082/jobs `
  -F "image=@C:\images\character.png" `
  -F "seed=42" `
  -F "resolution=1024" `
  -F "bg_removal=birefnet" `
  -F "uv=xatlas" `
  -F "targetFaces=250000" `
  -F "atlasSize=2048" `
  -F "textureResolution=1024" `
  -F "remeshBand=2" `
  -F "textureEncoding=webp" | ConvertFrom-Json

$response
```

The response contains a stable `id`, `statusUrl`, `modelUrl`, and `imageUrl`.
It also reports `queuePosition` (1-based while queued/running) and `jobsAhead`.
If another generation is active or queued, the submission response explicitly
reports how many jobs are ahead, so callers can surface that wait to the user.
During an atomic tray restart or quit, `POST /jobs` returns `503` while new
submissions are paused; retry after the service is ready. `POST /jobs` also
returns `503` while persistence is degraded: if a job-store write fails, the
queue stops accepting new work until a successful save proves durability
again. `GET /capabilities` reports this state through `persistenceHealthy`
and `persistenceError`.
Poll the status URL until the job is `succeeded`, then download the GLB:

```powershell
curl.exe $response.modelUrl --output "C:\models\character-seed42.glb"
```

Every successful job is also saved automatically in the Studio output folder as
`automation_<job-id>.glb`.

After generation, the API checks the GLB bounding dimensions. If the thinnest
dimension is below 5% of the largest, the job remains `succeeded` because its
artifact was saved, but the response includes a `qualityWarning` with code
`collapsed-plane`, the measured dimensions, ratio, and threshold. Callers must
surface this as a warning instead of presenting the result as a normal success.
Recommend a three-quarter reference with visible depth, clear lighting, and a
neutral background. Do not automatically retry with BiRefNet. A correct mask
does not address this geometry reconstruction failure and the retry would spend
GPU time without changing the relevant input geometry cues.

`GET /jobs` and `GET /jobs/{id}` return the same stable job ID, status/model/
source URLs, and live queue metadata. The original source image is saved as
`automation_<job-id>_source.<ext>` and remains available through `imageUrl`.

The API is resident while the Studio window is hidden. Use the tray menu to
open the UI, inspect the live server/queue status, open the output folder, or
quit. Restart and quit atomically pause new submissions only after confirming
the queue is idle. They remain blocked while a job is running or queued; queued
jobs can be cancelled with `DELETE /jobs/{id}`, while a running native GPU job
must finish safely before the app can quit.

## Queue a seed range

```powershell
42..45 | ForEach-Object {
  curl.exe http://127.0.0.1:8082/jobs `
    -F "image=@C:\images\character.png" `
    -F "seed=$_" `
    -F "resolution=512" `
    -F "bg_removal=birefnet" `
    -F "uv=xatlas"
}
```

Submitting is fast because each call creates a queued job. On this machine the
worker remains serial: the RTX 4070 has 12 GB VRAM and the native TRELLIS server
permits one GPU generation at a time.
