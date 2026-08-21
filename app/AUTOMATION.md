# Trellis Studio Lab automation API

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
- `POST /jobs` using the native `/generate` multipart fields
- `GET /jobs`
- `GET /jobs/{id}`
- `GET /jobs/{id}/model`
- `GET /jobs/{id}/image` for the original source image after success
- `DELETE /jobs/{id}` to cancel a queued job

## Submit a job

```powershell
$response = curl.exe http://127.0.0.1:8082/jobs `
  -F "image=@C:\images\character.png" `
  -F "seed=42" `
  -F "resolution=512" `
  -F "bg_removal=birefnet" `
  -F "uv=xatlas" | ConvertFrom-Json

$response
```

The response contains a stable `id`, `statusUrl`, `modelUrl`, and `imageUrl`.
It also reports `queuePosition` (1-based while queued/running) and `jobsAhead`.
If another generation is active or queued, the submission response explicitly
reports how many jobs are ahead, so callers can surface that wait to the user.
During an atomic tray restart or quit, `POST /jobs` returns `503` while new
submissions are paused; retry after the service is ready.
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
