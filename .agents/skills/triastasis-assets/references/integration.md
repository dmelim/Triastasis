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

Create the documented asset package, validate the static GLB in Blender, and offer a lightweight viewer or playable harness as the next step.

## Existing-engine result

1. Preserve the project's asset naming and folder structure.
2. Copy the static GLB into a clearly generated asset folder.
3. Add the smallest loader or scene needed to display it.
4. Normalize scale and forward axis at the integration boundary rather than destructively rewriting the source.
5. Add a minimal smoke test or launch the relevant scene.

## Engine notes

### Three.js

Use `GLTFLoader`. Reuse the project's renderer, camera, loop, and loading conventions. Dispose cloned geometries and materials only when ownership is clear.

### Godot

Import the GLB and instantiate its generated scene. Avoid editing generated import artifacts directly.

### Unity

Place the asset under `Assets/Generated/<asset>/` and create a prefab only when that matches the project's normal workflow.

### Unreal

Import through the project's established content path. Confirm unit scale and axis conversion.

## Prototype acceptance

The integration passes when the project starts, the asset appears at a sensible scale and orientation, materials render, and the asset participates in the requested prototype scene or interaction.
