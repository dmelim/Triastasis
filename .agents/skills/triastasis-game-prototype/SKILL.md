---
name: triastasis-game-prototype
description: Quickly create playable 3D game prototypes with Triastasis by turning a prompt or reference image into a generated GLB, inspecting and rigging characters in Blender, validating deformation, and integrating the result into an existing Three.js, Godot, Unity, Unreal, or other game project. Use for rapid prompt-to-game-character work, image-to-rigged-GLB, Triastasis automation, Blender auto-rigging without another neural model, or placing a generated asset into a prototype game.
---

# Triastasis Game Prototype

Turn an idea into a usable 3D game prototype quickly. Use Triastasis for local image-to-3D generation, then prefer one controlled generation and an agent-authored Blender rig over broad seed sweeps or another neural model.

## Required workflow

1. Resolve the target directory. If no game project exists, create a portable asset package and offer a small playable harness; do not choose an engine without the user's direction.
2. Read [references/triastasis-api.md](references/triastasis-api.md).
3. Check `GET http://127.0.0.1:8082/health` and `/capabilities`. Ask the user to start Triastasis only if unavailable.
4. Create or select the source image.
5. Generate one fast GLB with `scripts/triastasis_generate.sh` at resolution 512. Use seed 42 unless the user supplied one.
6. Inspect the GLB with Blender and `scripts/inspect_glb.py`. Read its JSON report and inspect all rendered views.
7. If the asset is humanoid, read [references/rigging.md](references/rigging.md), author a character-specific rig specification, and apply it with `scripts/rig_humanoid.py`.
8. Author at least three character-specific test poses and run `scripts/validate_rig.py`. Inspect its renders and report. Iterate the specification or weights when a joint collapses or pulls unrelated geometry.
9. Package the source image, static GLB, rigged GLB when applicable, reports, and previews together.
10. Read [references/integration.md](references/integration.md). Integrate when a supported game project exists or the user requests a playable harness.

The generation script prints the stable job ID and current queue position. Keep that ID in the response so the user or another agent can refer to the exact generation. Triastasis runs jobs serially, so a queued job is expected when the GPU is busy. The desktop window may be closed while the tray-resident service continues the workflow.

## Fast defaults

- Generate one 512 model first.
- Use `bg_removal=birefnet`, `uv=xatlas`, and seed 42.
- Try another seed only when the silhouette or topology is unusable.
- Upgrade to 1024 only after choosing a good 512 result and only when visual fidelity matters.
- Keep Triastasis jobs serial. Never launch simultaneous GPU generations unless `/capabilities` explicitly permits it.
- Rig with Blender geometry and agent reasoning first. Do not install or invoke UniRig unless the user opts into the fallback after poor results.

## Source image rules

When no image is supplied, use an available image-generation tool and skill.

For a riggable character, generate one subject only:

- neutral A-pose, straight-on front view, near-orthographic perspective;
- arms separated from the torso and legs separated from each other;
- complete head, hands, and feet with generous margins;
- readable limb joints and a clean silhouette;
- simple neutral background and even lighting;
- restrained accessories with no cape, weapon, held prop, or overlapping loose cloth;
- coherent front-facing costume details and materials;
- no text, logo, watermark, floor clutter, or dramatic shadow.

Reject and regenerate cropped limbs, fused arms, hidden hands, crossed legs, extreme poses, or stray duplicate body parts.

## Generate with Triastasis

Run in Git Bash:

```bash
bash .agents/skills/triastasis-game-prototype/scripts/triastasis_generate.sh \
  --image "/c/path/to/character.png" \
  --output "/c/path/to/package/character-static.glb" \
  --seed 42 \
  --resolution 512
```

The script submits, polls, downloads, and validates the GLB header. Preserve its terminal log with the asset package when debugging.

## Inspect in Blender

Locate Blender rather than assuming it is on `PATH`.

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
  --background --python-exit-code 1 `
  --python ".agents\skills\triastasis-game-prototype\scripts\inspect_glb.py" -- `
  --input "C:\path\character-static.glb" `
  --output-dir "C:\path\inspection"
```

Do not rig until the report and front, back, left, and right renders are available.

## Rigging policy

- Treat rigging as an iterative geometry task, not a guaranteed one-click operation.
- Author bone coordinates from the inspection report and rendered views.
- Use the standard humanoid bone names in [references/rigging.md](references/rigging.md).
- Prefer Blender automatic weights. Allow the bundled rigid nearest-bone fallback only for a quick prototype or when bone heat fails.
- Preserve textures, materials, object transforms, and the original static GLB.
- Never claim success from the presence of an armature alone. Validate weighted vertices and visible deformation.
- Keep a static fallback when the generated topology cannot deform acceptably.

## Quality gate

Deliver the rigged model only when all are true:

- the GLB imports without errors;
- one armature exists and bone parents form a valid hierarchy;
- at least 99.9% of exported mesh vertices have deform weights, and pose renders show no visible stuck fragments;
- shoulders, elbows, hips, knees, neck, and ankles bend without catastrophic collapse;
- unrelated props or armor do not follow the wrong limb;
- textures survive export;
- the packaged asset loads in the target runtime or Blender.

For a fast prototype, minor clipping is acceptable. Missing limbs, exploding vertices, inverted scale, broken textures, or an unusable root transform are not.

## Output package

Use a stable layout:

```text
<character-name>/
  source.png
  character-static.glb
  character-rigged.glb
  manifest.json
  inspection/
    report.json
    front.png
    back.png
    left.png
    right.png
  validation/
```

Record the prompt, seed, resolution, Triastasis parameters, rig method, Blender version, scale, forward axis, license notes, and known defects in `manifest.json`.

## Fallback boundary

If two meaningful agent-authored rig attempts fail the quality gate, stop iterating blindly. Offer UniRig as an opt-in fallback. UniRig is MIT licensed and requires at least 8 GB of CUDA VRAM, but it introduces another environment and model. Do not install it silently.
