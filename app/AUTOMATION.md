# Trellis Studio Lab automation API

The desktop app starts a local queued API on the port immediately after the
configured TRELLIS server port. With the Lab defaults, the native server is on
`127.0.0.1:8081` and automation is on `127.0.0.1:8082`.

The API binds to loopback only. It accepts multiple jobs, but deliberately runs
one generation at a time. `GET /capabilities` reports the detected GPU, VRAM,
queue counts, and enforced concurrency policy.

## Endpoints

- `GET /health`
- `GET /capabilities`
- `POST /jobs` using the native `/generate` multipart fields
- `GET /jobs`
- `GET /jobs/{id}`
- `GET /jobs/{id}/model`
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

The response contains `statusUrl` and `modelUrl`. Poll the status URL until the
job is `succeeded`, then download the GLB:

```powershell
curl.exe $response.modelUrl --output "C:\models\character-seed42.glb"
```

Every successful job is also saved automatically in the Studio output folder as
`automation_<job-id>.glb`.

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
