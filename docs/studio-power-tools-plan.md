# Trellis Studio Power Tools Plan

Status: baseline proposal

Created: 2026-08-19

Scope: viewer inspection, triangle topology, practical editing, generation controls, and non-destructive history

## 1. Decisions captured

- Keep TRELLIS and triangle meshes as the default generation path.
- Redesign the workspace around a left mode rail with **Generate** and **View** modes.
- Add a mesh inspector and triangle-topology display before attempting advanced editing.
- Expose useful generation controls already present in the backend, plus a real target-face-count control.
- Make edits non-destructive and store derived versions as children of the original generation.
- Do not require quad retopology for the first implementation. Treat it as an optional future operation for workflows that benefit from it.
- Preserve the current generation, gallery, seed-sweep, automation, and auto-save behavior.

## 2. Licensing baseline

The root project is licensed under the MIT License, copyright 2026 Piotr Wilkin. MIT permits use, copying, modification, merging, publication, distribution, sublicensing, and commercial sale. Distributed copies or substantial portions must retain the copyright and permission notice.

The upstream Microsoft TRELLIS reference code and the published `microsoft/TRELLIS.2-4B` model repository are also currently identified as MIT-licensed.

Before publishing or commercially distributing Trellis Studio, complete a dependency and asset notice audit:

- Retain the repository's root `LICENSE` file and its existing copyright notice.
- Add our own copyright notice for original modifications without removing upstream notices.
- Inventory vendored and linked components, including ggml, xatlas, meshoptimizer, stb, model-viewer, Tauri, and any new viewer/editor library.
- Preserve each dependency's required license or attribution notice in a `THIRD_PARTY_NOTICES` file or equivalent distribution bundle.
- Record the exact model repository and revision used by installers.
- Do not assume that rights to user-provided input images, generated likenesses, trademarks, or third-party assets are granted by the software license.

Initial attribution and dependency findings are recorded in [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The remaining release audit must be repeated against the exact dependency lockfiles, populated submodules, packaged files, and model revisions used for a release.

This is an engineering licensing baseline, not a substitute for legal review before a public commercial release.

## 3. Product goal

Turn Trellis Studio from a generate-and-preview application into a compact 3D workspace where:

1. A casual user can generate, compare, inspect, and export a model without learning 3D terminology.
2. A power user can inspect topology and materials, make practical non-destructive corrections, and export an optimized model.
3. Advanced operations such as retopology or rigging can be added later without redesigning the project model.

## 4. Proposed workspace design

### Left mode rail

Use a narrow vertical rail inspired by the reference application's information architecture, without copying its branding or exact implementation.

- **Generate**: input image, model-input mask, generation controls, seed sweep, and generate action.
- **View**: display modes, mesh statistics, scene controls, selection, and editing tools.

The selected mode opens a contextual sidebar immediately to the right of the rail. The 3D canvas remains the largest area of the window. The existing gallery/version strip can remain below the workspace initially.

### Generate mode

Keep the current controls and progressively add:

- Resolution: 512, 1024, 1536.
- Seed and seed sweep.
- Background removal mode and model-input preview.
- UV method: xatlas or box projection.
- Target triangle count presets plus a custom value.
- Texture generation: on or off.
- Texture atlas size.
- Texture decode resolution.
- Remesh strength/band under an **Advanced** disclosure.
- Texture encoding under **Advanced**, if it provides a meaningful export benefit.

Guidance strengths and low-level runtime flags should remain hidden from the default UI until we have evidence that users can improve results with them.

### View mode

Organize the sidebar into these sections:

**Model information**

- Triangles/faces.
- Render vertices.
- Mesh primitives or parts.
- Materials and textures.
- Texture dimensions and encoding.
- GLB file size.
- Model dimensions and bounding box.
- Topology label: `Triangles` for current Trellis output.

**Display**

- Textured.
- Clay.
- Wireframe.
- Textured + wireframe overlay.
- Surface normals.
- UV checker.
- Base color, metallic, roughness, and unlit inspection modes.
- Grid and world axes.

**Scene**

- Environment/light preset.
- Exposure and shadow strength.
- Background color or transparency.
- Perspective/orthographic camera.
- Front, back, left, right, top, and bottom camera presets.
- Reset and frame selection.

**Selection and edit**

- Select a connected mesh component or exported primitive.
- Isolate, hide, or show a selected component.
- Delete an unwanted disconnected component.
- Move, rotate, or scale a selected object/component where safe.
- Edit material base color, metallic, roughness, and opacity.
- Recalculate or flip normals.
- Undo and redo.

## 5. Triangle topology strategy

### Why triangles should remain the default

- GPUs and real-time renderers ultimately render triangles.
- glTF/GLB and game engines have excellent triangle-mesh interoperability.
- Every face has an unambiguous shape; there is no hidden choice about how a non-planar quad is triangulated.
- The existing Trellis remesh, cleanup, QEM decimation, UV bake, and GLB export pipeline already operates on triangles.
- Triangle output is suitable for static props, previews, 3D printing preparation, collision generation, and many game-ready assets.
- Showing triangle topology requires no regeneration: it is a viewer display mode.

### Triangle limitations

- Generated meshes can be dense and visually irregular for manual vertex editing.
- Triangle flow is less convenient for loop selection, subdivision modelling, sculpting, and hand-authored deformation.
- A heavily decimated triangle mesh may deform less cleanly around shoulders, elbows, knees, mouths, and eyes.

### When quads are valuable

Quad-dominant topology is valuable when a model will receive extensive manual modelling, subdivision, facial work, or high-quality character deformation. Even then, a GLB export is triangulated for rendering; the editable source format is where quad structure matters.

### Recommendation

Do not replace Trellis triangle topology. Add excellent triangle inspection and useful cleanup first. Later, offer **Retopologize** as an optional derived-version operation with presets such as `Static asset`, `Character`, or `Custom target`. Retopology must never overwrite the original mesh.

## 6. What “editable” means for the first release

Trying to reproduce Blender inside Trellis Studio would create a large, unfocused product. The first editing release should target common corrections that are valuable after AI generation:

- Remove floating or unwanted disconnected geometry.
- Inspect, isolate, hide, and restore mesh parts.
- Correct orientation, scale, and pivot.
- Correct inverted normals.
- Adjust material properties.
- Choose an optimization target and create a simplified version.
- Export the result or hand it off to a full DCC application.

Direct vertex, edge, and face manipulation can be explored after component selection and undo/redo are reliable. If added, begin with selection, delete, transform, and a small set of safe cleanup commands rather than sculpting tools.

## 7. Technical direction

### Viewer

The current `<model-viewer>` wrapper is appropriate for previewing but restrictive for topology inspection and editing. Move the main workspace toward a direct Three.js-based viewer with explicit ownership of the scene, renderer, meshes, materials, raycasting, selection, and overlays.

The migration can be incremental:

1. Parse GLB metadata independently and add statistics around the existing viewer.
2. Prototype a direct viewer behind the new View mode.
3. Reach feature parity for loading, camera controls, framing, shadows, screenshots, and WebP-textured PBR display.
4. Switch the main canvas after visual and performance parity is verified.

Do not rely on private internals of the vendored `<model-viewer>` implementation.

### Accurate mesh metrics

Metrics must have explicit definitions:

- **Triangles**: sum of rendered triangle primitives; indexed primitives use `indexAccessor.count / 3`.
- **Render vertices**: sum of position accessor counts. This includes UV- or normal-split duplicates.
- **Unique positions**: optional welded-position estimate, clearly labelled because tolerance affects the result.
- **Parts**: number of scene mesh nodes and primitives, shown separately.

This avoids presenting a misleading single “vertices” number.

### Generation API

Extend the generation parameter flow across shared TypeScript types, request form fields, server request parsing, `TrellisParams`, and the post-processing call.

Priority controls:

1. `targetFaces`: replace the hardcoded 150K/300K QEM targets when supplied.
2. `texture`: enable or disable texture generation.
3. `atlasSize`: expose the existing atlas parameter.
4. `textureResolution`: expose the existing texture decode resolution.
5. `remeshBand`: expose the server's existing band field in Advanced controls.
6. `textureEncoding`: expose the server's existing WebP/PNG field only if needed.

Validation must clamp expensive or unsafe values on the server; the UI must not be the only validation layer.

### Non-destructive versions

Evolve the gallery record into a small asset/version model:

- Stable asset/group ID.
- Version ID and optional parent version ID.
- Operation type: generated, simplified, cleaned, material-edited, retopologized, or rigged.
- Operation parameters.
- Creation time, thumbnail, GLB, and model metrics.
- Human-readable label and optional favorite marker.

Every geometry-changing operation creates a new version. Undo/redo handles changes within the active edit session; version history handles committed transformations.

## 8. Delivery phases

### Phase A — Inspector foundation

- Add the Generate/View mode rail and contextual left sidebar.
- Parse loaded GLB metadata.
- Show triangle, render-vertex, part, material, texture, size, and dimension statistics.
- Add grid, axes, camera presets, background, and lighting controls that are practical with the current viewer.
- Preserve current generation and gallery behavior.

Acceptance: a user can load any generated or gallery GLB and understand its basic geometry/material cost without regenerating it.

### Phase B — Direct topology viewer

- Introduce the direct Three.js canvas.
- Match current PBR appearance, framing, screenshots, and interaction.
- Add clay, wireframe, textured-wireframe, normals, UV checker, and channel inspection.
- Add raycast selection and part isolation.

Acceptance: topology modes render correctly on current Trellis GLBs, including large 300K-triangle models, without breaking texture display or gallery thumbnails.

### Phase C — Generation controls

- Add target triangle count with safe presets and custom validation.
- Add texture toggle, atlas size, texture resolution, and remesh band.
- Persist parameters with each generation and show requested versus actual metrics.
- Verify texture quality at each face-count preset.

Acceptance: the selected target affects pre-bake QEM decimation, the returned GLB remains valid, and the UI reports actual output statistics.

### Phase D — Practical editing and history

- Add part selection, isolate/hide, disconnected-component deletion, transforms, normals repair, and material editing.
- Add undo/redo for the active edit session.
- Save an edited result as a derived version.
- Add version history navigation and comparison.

Acceptance: edits never overwrite the original generation, survive application restart, and export to a valid GLB.

### Phase E — Optional advanced pipeline

- Evaluate quad-dominant retopology as an opt-in derived operation.
- Evaluate automatic rigging and animation handoff separately.
- Add DCC handoff/export workflows where an external editor is a better tool.

Acceptance: advanced operations are clearly optional, report failure safely, and preserve the original triangle model.

## 9. Validation plan

- Test representative 512, 1024, and 1536 outputs.
- Test textured and geometry-only GLBs.
- Test meshes with multiple components, primitives, and materials.
- Compare displayed triangle/vertex metrics with `tools/glb_metrics.py` and an external DCC application.
- Measure viewer frame rate and memory on 25K, 100K, 300K, and full-resolution models.
- Verify transparent and WebP-textured GLBs.
- Verify gallery migration for records created before version history exists.
- Verify every edit path has undo or creates a recoverable derived version.
- Run a third-party license/notice audit before packaging a public build.

## 10. Immediate implementation baseline

The first implementation should cover Phase A only, while structuring the sidebar and state model so Phase B can replace the viewer without another UI redesign. Phase A should not add geometry editing or alter generated GLBs.

## 11. Implementation snapshot

An early implementation pass was created on 2026-08-19 before this document was confirmed as planning-only. Keep it as an experimental baseline, but do not treat the broader roadmap as implemented.

### Present in the working tree

- Generate and View mode rail with a contextual left sidebar.
- Existing Generate controls preserved inside Generate mode.
- Direct Three.js GLB viewer replacing the preview-only wrapper.
- Loaded-model metrics for triangles, render vertices, mesh parts, materials, textures, dimensions, file size, and animations.
- Textured, clay, wireframe, and texture-plus-wireframe display modes.
- Grid, axes, auto-rotate, shadows, exposure, background, and camera presets.
- Existing gallery records can be loaded into the inspector.
- Production web build passes.

### Verification performed

- Loaded an existing 512-resolution gallery GLB successfully.
- Reported 139,892 triangles, 87,261 render vertices, one mesh part, one material, two textures, and a 4.9 MB GLB.
- Confirmed that Generate/View switching and the inspector controls are present and interactive.
- Confirmed that the TypeScript and Vite production build completes.

### Known limitations in the early pass

- Dense wireframe lines merge into a bright silhouette at normal viewing distance. The topology view needs adaptive line density, depth-aware styling, close-up guidance, or a lower-detail inspection proxy.
- Three.js increases the initial JavaScript bundle to about 660 kB before gzip. It should be lazy-loaded or split into a viewer chunk.
- The old vendored `<model-viewer>` asset and related comments remain in the repository even though the new viewer no longer uses them.
- The new viewer needs broader GLB compatibility testing, resource disposal checks, WebP testing in the desktop webview, and performance testing at 300K triangles.
- The View sidebar can become vertically dense at shorter window heights and needs final scrolling/focus polish.
- No model-editing operations are implemented.
- No target-face-count or additional generation controls are implemented.
- No derived-version history or gallery data migration is implemented.
- No quad retopology, rigging, segmentation, or DCC handoff is implemented.

## 12. Planned work from the current baseline

No additional implementation should begin without explicit approval of the relevant slice.

### Stabilize the inspector

- Decide whether to keep the direct Three.js viewer after testing WebP GLBs in Tauri.
- Improve dense topology visualization.
- Lazy-load the 3D viewer bundle.
- Remove the obsolete viewer implementation and vendored asset only after parity is confirmed.
- Add cleanup/disposal for replaced scenes, geometries, materials, and textures.
- Test keyboard navigation, focus movement, narrow desktop windows, and high-DPI rendering.
- Test 25K, 100K, 300K, and full-resolution meshes.

### Expose generation controls

- Add a server-validated target triangle count.
- Add texture on/off, atlas size, texture resolution, and remesh-band controls.
- Persist requested settings and actual output metrics with each generation.
- Compare output quality and processing time across presets before choosing defaults.

### Add practical editing

- Begin with connected-component selection, isolate/hide, unwanted-component removal, transforms, normals repair, and material adjustments.
- Add an explicit edit session with undo and redo.
- Save geometry-changing operations as derived versions rather than overwriting the original GLB.
- Add export and optional DCC handoff after derived versions are reliable.

### Add version history

- Introduce asset, version, and parent-version identifiers.
- Record the operation and parameters that produced each version.
- Design and test migration for existing IndexedDB gallery records.
- Add comparison, naming, favorite, and restore behavior only after the data model is stable.

### Revisit advanced topology later

- Keep triangle topology as the default.
- Evaluate quad-dominant retopology only as an optional derived operation.
- Evaluate character-oriented retopology and rigging separately from static-asset cleanup.
