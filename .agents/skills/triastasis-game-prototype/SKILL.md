---
name: triastasis-game-prototype
description: Quickly create playable 3D game prototypes with Triastasis by turning a prompt or reference image into a static GLB, inspecting its geometry and materials, and integrating it into an existing Three.js, Godot, Unity, Unreal, or other game project. Use for prompt-to-3D, image-to-static-GLB, Triastasis automation, or placing a generated static asset into a prototype game. Do not use this skill for character rigging or animation-ready asset claims.
---

# Triastasis Game Prototype

Turn an idea into a usable static 3D game asset quickly. Use Triastasis for local image-to-3D generation, then prefer one controlled generation, visual inspection, and lightweight game integration over broad seed sweeps.

## Required workflow

1. Resolve the target directory. If no game project exists, create a portable asset package and offer a small playable harness; do not choose an engine without the user's direction.
2. Read [references/triastasis-api.md](references/triastasis-api.md).
3. Resolve the automation API URL. It is one port above the configured native server and defaults to `http://127.0.0.1:8082`. Check `/health` for HTTP availability, then `/capabilities` for queue policy and persistence health. Ask the user to start or repair Triastasis only when those checks show it is unavailable or degraded.
4. Create or select the source image.
5. Generate one fast GLB with `scripts/triastasis_generate.sh` at resolution 512. Use seed 42 unless the user supplied one. Preserve the final job JSON with `--job-json` when packaging the result.
6. Read the final job status. If it contains `qualityWarning`, surface it and stop before integration. A `collapsed-plane` result needs a better source view with visible depth, not an automatic BiRefNet retry. Otherwise inspect the GLB with Blender and `scripts/inspect_glb.py`. Read its JSON report and inspect all rendered views.
7. Package the source image, static GLB, job record, inspection report, and previews together.
8. Read [references/integration.md](references/integration.md). Integrate when a supported game project exists or the user requests a playable harness.

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
bash .agents/skills/triastasis-game-prototype/scripts/triastasis_generate.sh \
  --image "/c/path/to/source.png" \
  --output "/c/path/to/package/asset-static.glb" \
  --job-json "/c/path/to/package/job.json" \
  --seed 42 \
  --resolution 512
```

Pass `--api` when Triastasis uses a non-default port. The helper also exposes the app's advanced texturing and mesh controls when the prototype needs them; read [references/triastasis-api.md](references/triastasis-api.md) before overriding defaults. The script submits, polls, downloads, validates the GLB header, and surfaces the app's geometry-quality warning. Preserve its terminal log with the asset package when debugging.

## Inspect in Blender

Locate Blender rather than assuming it is on `PATH`.

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
  --background --python-exit-code 1 `
  --python ".agents\skills\triastasis-game-prototype\scripts\inspect_glb.py" -- `
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
  manifest.json
  inspection/
    report.json
    front.png
    back.png
    left.png
    right.png
```

Record the prompt, seed, resolution, Triastasis parameters, Blender version, scale, forward axis, license notes, and known defects in `manifest.json`. Describe the output as a static asset. Do not claim it is rigged, skinned, or animation-ready.
