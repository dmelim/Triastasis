# Agent-authored humanoid rigging

## Goal

Use Blender as the geometry engine while the coding agent reasons about landmarks, hierarchy, weights, and validation. Do not add a neural rigging dependency in the default path.

## Inputs

Read `inspection/report.json` and inspect `front.png`, `back.png`, `left.png`, and `right.png`. Confirm Blender's imported Z-up coordinate system and determine which Y direction is the character's front.

The source image should already place the character in a neutral A-pose. Generated geometry that fuses arms to the torso is a generation failure, not a rigging problem.

## Rig specification

Create JSON using world-space Blender coordinates:

```json
{
  "name": "CharacterRig",
  "skin": "automatic",
  "bones": [
    {"name": "root", "head": [0, 0, 0], "tail": [0, 0, 0.12], "deform": false},
    {"name": "pelvis", "head": [0, 0, 0.85], "tail": [0, 0, 1.02], "parent": "root"},
    {"name": "spine", "head": [0, 0, 1.02], "tail": [0, 0, 1.3], "parent": "pelvis", "connect": true},
    {"name": "chest", "head": [0, 0, 1.3], "tail": [0, 0, 1.55], "parent": "spine", "connect": true},
    {"name": "neck", "head": [0, 0, 1.55], "tail": [0, 0, 1.67], "parent": "chest"},
    {"name": "head", "head": [0, 0, 1.67], "tail": [0, 0, 1.9], "parent": "neck", "connect": true}
  ]
}
```

Coordinates above are illustrative only. Derive every value from the current asset.

## Standard hierarchy

Use these names when the anatomy exists:

```text
root
└── pelvis
    ├── spine
    │   └── chest
    │       ├── neck
    │       │   └── head
    │       ├── clavicle.L -> upper_arm.L -> lower_arm.L -> hand.L
    │       └── clavicle.R -> upper_arm.R -> lower_arm.R -> hand.R
    ├── upper_leg.L -> lower_leg.L -> foot.L -> toe.L
    └── upper_leg.R -> lower_leg.R -> foot.R -> toe.R
```

Add finger, jaw, eye, tail, antenna, cloth, or prop bones only when they materially help the prototype. Keep the first rig small.

## Landmark heuristics

- Place joint heads inside the volume, not on the visible surface.
- Put the pelvis near the midpoint between hip sockets.
- Follow actual limb centers from both front and side views.
- Give every bone nonzero length.
- Keep left and right chains symmetric only when the mesh is symmetric.
- Place elbow and knee joints where the geometry narrows or changes direction.
- Place ankle and wrist joints before the terminal extremity, not at the mesh boundary.
- Keep root non-deforming and near the ground projection of the pelvis.

## Apply

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
  --background --python-exit-code 1 `
  --python ".agents\skills\triastasis-game-prototype\scripts\rig_humanoid.py" -- `
  --input "character-static.glb" `
  --spec "rig-spec.json" `
  --output "character-rigged.glb" `
  --report "validation\rig-report.json"
```

`skin` may be `automatic` or `rigid`. Automatic uses Blender bone heat. If it fails, the script falls back to nearest-bone rigid weights and records the fallback in the report.

## Validate deformation

Inspect at least:

1. Shoulder and elbow: raise one arm and bend the elbow.
2. Hip and knee: step one leg forward and bend the knee.
3. Spine and neck: rotate chest and head in opposite directions.

Render validation views. Check armpits, groin, elbows, knees, wrists, ankles, accessories, and disconnected armor pieces.

Revise bone placement before manually painting many weights. Bad landmarks cannot be repaired cleanly by weight tweaks.

Create a character-specific pose file and run the bundled validator:

```json
{
  "poses": [
    {
      "name": "arms-forward",
      "bones": {
        "upper_arm.L": {"rotationDegrees": [0, 0, -45]},
        "upper_arm.R": {"rotationDegrees": [0, 0, 45]}
      }
    },
    {
      "name": "left-step",
      "bones": {
        "upper_leg.L": {"rotationDegrees": [25, 0, 0]},
        "lower_leg.L": {"rotationDegrees": [-35, 0, 0]}
      }
    },
    {
      "name": "right-step",
      "bones": {
        "upper_leg.R": {"rotationDegrees": [25, 0, 0]},
        "lower_leg.R": {"rotationDegrees": [-35, 0, 0]}
      }
    }
  ]
}
```

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
  --background --python-exit-code 1 `
  --python ".agents\skills\triastasis-game-prototype\scripts\validate_rig.py" -- `
  --input "character-rigged.glb" `
  --poses "validation-poses.json" `
  --output-dir "validation\poses"
```

Rotations are local XYZ Euler angles in degrees. Author them for the actual bone axes; the values above are only a starting point.

The validator allows at most 0.1% unweighted vertices by default because glTF export can duplicate a small number of seam vertices without preserving weights. Still reject the rig if any pose render shows visible stationary fragments. Tighten this with `--max-unweighted-ratio 0` when the exporter preserves every weight.

## Escalation

After two meaningful agent-authored attempts fail, offer UniRig rather than repeating minor coordinate changes. UniRig requires a CUDA GPU with at least 8 GB VRAM and is MIT licensed. Do not install it without the user's approval.
