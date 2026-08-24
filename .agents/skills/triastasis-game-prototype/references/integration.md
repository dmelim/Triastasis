# Game integration

## Detect before changing

Inspect the target directory and identify an existing runtime from its project files:

- Three.js or React Three Fiber: `package.json` contains `three`, `@react-three/fiber`, or `@react-three/drei`.
- Godot: `project.godot`.
- Unity: `Assets/` and `ProjectSettings/ProjectVersion.txt`.
- Unreal: a `.uproject` file.
- Other engine: follow its established asset and scene conventions.

Do not initialize a new engine merely because none is detected. Ask which engine or harness the user wants when a playable prototype is requested without an existing project.

## No-engine result

Create the documented asset package, validate the rigged GLB in Blender, and offer a lightweight viewer or playable harness as the next step.

## Existing-engine result

1. Preserve the project's asset naming and folder structure.
2. Copy the rigged GLB into a clearly generated asset folder.
3. Add the smallest loader or scene needed to display it.
4. Normalize scale and forward axis at the integration boundary rather than destructively rewriting the source.
5. If animations exist, play one named clip through the engine's normal animation system.
6. Add a minimal smoke test or launch the relevant scene.

## Engine notes

### Three.js

Use `GLTFLoader` and `AnimationMixer`. Reuse the project's renderer, camera, loop, and loading conventions. Dispose cloned geometries and materials only when ownership is clear.

### Godot

Import the GLB, instantiate its generated scene, and drive clips through `AnimationPlayer` or `AnimationTree`. Avoid editing generated import artifacts directly.

### Unity

Place the asset under `Assets/Generated/<character>/`. Confirm the imported rig type and avatar before creating a prefab. Do not assume Humanoid mapping succeeds for a custom skeleton.

### Unreal

Import through the project's established content path. Confirm skeleton assignment, unit scale, and axis conversion. Avoid creating a permanent Animation Blueprint for a throwaway preview unless requested.

## Prototype acceptance

The integration passes when the project starts, the character appears at a sensible scale and orientation, materials render, and at least one deformation or animation test can be observed.
