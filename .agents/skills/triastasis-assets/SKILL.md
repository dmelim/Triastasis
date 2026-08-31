---
name: triastasis-assets
description: Generate, inspect, import, export, recover, and integrate static 3D assets with Triastasis. Use for prompt- or image-to-GLB generation, Triastasis library and package workflows, automation, asset validation, or placing generated assets into game projects. Do not use for character rigging, animation, or animation-ready asset claims.
---

# Triastasis Assets

Manage the complete lifecycle of static 3D assets with Triastasis. Generate from an image, inspect quality, create portable packages, safely import existing packages, recover usable outputs, and integrate assets into game projects. For new generation, prefer one controlled result and visual inspection over broad seed sweeps.

## Required workflow

1. Resolve the target directory. If no game project exists, create a portable asset package and offer a small playable harness; do not choose an engine without the user's direction.
2. Read [references/triastasis-api.md](references/triastasis-api.md).
3. Resolve the automation API URL. It is one port above the configured native server and defaults to `http://127.0.0.1:8082`. Check `/health` for HTTP availability, then `/capabilities` for queue policy and persistence health. Ask the user to start or repair Triastasis only when those checks show it is unavailable or degraded.
4. Create or select the source image.
5. Generate one fast package with `scripts/triastasis_generate.sh --export-dir` at resolution 512. Use seed 42 unless the user supplied one. The native exporter preserves the source image, GLB, portable job record, and verified generation manifest together.
6. Read the final job status. If it contains `qualityWarning`, surface it and stop before integration. A `collapsed-plane` result needs a better source view with visible depth, not an automatic BiRefNet retry. Otherwise inspect the GLB with Blender and `scripts/inspect_glb.py`. Read its JSON report and inspect all rendered views.
7. Add the inspection report and previews to the exported package. Copy that package into the target project; never move, rename, or delete the Triastasis originals. Do not bypass the native export endpoint with ad hoc filesystem copies when the completed job is still available. The endpoint refuses existing destinations and returns verified hashes.
8. Read [references/integration.md](references/integration.md). Integrate when a supported game project exists or the user requests a playable harness.

When existing Triastasis packages need to enter the desktop Library, never copy
files into the app-local gallery. Submit their common parent directory through
the app-owned import path:

```bash
bash .agents/skills/triastasis-assets/scripts/triastasis_import.sh \
  --source-dir "/c/path/to/packages"
```

To import one package from a shared directory without importing its neighbours,
submit that exact manifest:

```bash
bash .agents/skills/triastasis-assets/scripts/triastasis_import.sh \
  --source "/c/path/to/asset.triastasis.json"
```

The helper asks the running Triastasis backend to select one manifest or discover
packages recursively, wakes the desktop app, and waits until the app reports
exact imported, skipped, and failed counts. Triastasis validates manifests and
persists gallery records in its own Windows context. This avoids Codex
package-path virtualization and never moves, renames, deletes, or directly
writes the source packages.

The generation script prints the stable job ID, queue position, current stage, progress, and ETA when available. Keep the job ID in the response so the user or another agent can refer to the exact generation. Triastasis runs jobs serially, so a queued job is expected when the GPU is busy. The desktop window may be closed while the tray-resident service continues the workflow.

## Fast defaults

- Generate one 512 model first.
- Use `bg_removal=birefnet`, `uv=xatlas`, and seed 42.
- Try another seed only when the silhouette or topology is unusable.
- Upgrade to 1024 only after choosing a good 512 result and only when visual fidelity matters.
- Keep Triastasis jobs serial. Never launch simultaneous GPU generations unless `/capabilities` explicitly permits it.
- Treat `persistenceHealthy: false` as temporarily unavailable. Report `persistenceError` and do not submit work until durability recovers.

## Source image rules

When no image is supplied, use an available image-generation tool and skill.

Generate one subject or object only:

- use a three-quarter view with visible depth rather than a flat straight-on view;
- keep the complete subject inside the frame with generous margins;
- preserve a clean, readable silhouette with minimal self-occlusion;
- simple neutral background and even lighting;
- restrained accessories with no overlapping loose cloth or unrelated props;
- coherent surface details and materials;
- no text, logo, watermark, floor clutter, or dramatic shadow.

Reject and regenerate cropped subjects, severe occlusion, fused shapes, ambiguous depth, or stray duplicate parts.

## Generate with Triastasis

Run in Git Bash:

```bash
bash .agents/skills/triastasis-assets/scripts/triastasis_generate.sh \
  --image "/c/path/to/source.png" \
  --export-dir "/c/path/to/new-package" \
  --seed 42 \
  --resolution 512
```

Pass `--api` when Triastasis uses a non-default port. The helper also exposes the app's advanced texturing and mesh controls when the prototype needs them; read [references/triastasis-api.md](references/triastasis-api.md) before overriding defaults. The script submits, polls, asks the Rust service to export into a new directory, validates the GLB header, and surfaces the app's geometry-quality warning. Preserve its terminal log with the asset package when debugging.

## Inspect in Blender

Locate Blender rather than assuming it is on `PATH`.

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
  --background --python-exit-code 1 `
  --python ".agents\skills\triastasis-assets\scripts\inspect_glb.py" -- `
  --input "C:\path\asset-static.glb" `
  --output-dir "C:\path\inspection"
```

Do not integrate until the report and front, back, left, and right renders are available.

## Quality gate

Deliver or integrate the static model only when all are true:

- the GLB imports without errors;
- the automation job has no unresolved `qualityWarning`;
- the inspection report shows sensible non-collapsed dimensions;
- the rendered views show no missing major parts or unusable fused geometry;
- textures survive export;
- the packaged asset loads in the target runtime or Blender.

For a fast prototype, minor surface artifacts are acceptable. Missing major parts, collapsed geometry, inverted scale, broken textures, or an unusable root transform are not.

## Output package

Use a stable layout:

```text
<asset-name>/
  source.png
  job.json
  asset-static.glb
  asset-static.triastasis.json
  manifest.json
  inspection/
    report.json
    front.png
    back.png
    left.png
    right.png
```

Record the prompt, seed, resolution, Triastasis parameters, Blender version, scale, forward axis, license notes, and known defects in `manifest.json`. Describe the output as a static asset. Do not claim it is rigged, skinned, or animation-ready.

Treat integration as a copy operation. Keep the source package and Triastasis job outputs intact unless the user explicitly asks to remove them after verifying the integrated copy. Committing or pushing the destination files does not authorize cleanup of their source locations.
