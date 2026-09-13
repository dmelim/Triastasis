# Geometry and shading study

Current decision (2026-09-13): **do not pursue a higher default face target**.
After reviewing five textured examples, the user found little visible difference.
The observed benefit does not justify the added geometry and export size for
this proposed default change. This supersedes the candidate recommendations
recorded below. Keep existing defaults and manual controls; retain the evidence
and stop further adoption testing for this candidate. This is a practical review
decision, not a claim that face count never matters for other assets or uses.

2026-09-13: the saved 512 tabletop-crate capture shows visibly less crisp
shading after QEM simplification. Panel grooves, bevels and bolt edges become
softer and less even in all four inspected views. Subsequent cleanup looks
effectively identical. This identifies simplification plus the resulting smooth
normals as a useful investigation target; it does not isolate vertex movement
from normal interpolation or justify removing simplification.

## Controlled comparison

Reused `out/material-research/decoder-second-asset/capture-run/post.bin`, the
same saved research capture used in the second material precision comparison.
No neural inference or material decoding was repeated. The Library was checked;
its older crate version has different preprocessing/UV settings and is not
claimed to be the identical research capture.

The CUDA `post-replay` harness used remesh band 1 and target 150,000 faces,
matching this capture's production settings. It writes three meshes from one
execution, immediately before QEM, immediately after QEM, and after the existing
weld/hole-fill/component cleanup. Production generation behavior is unchanged.

| Stage | Vertices | Triangles |
| --- | ---: | ---: |
| Before QEM, after remesh/cleanup | 3,457,463 | 6,916,476 |
| After QEM | 69,349 | 138,936 |
| After subsequent cleanup | 69,343 | 138,928 |

Blender 5.1.2 EEVEE rendered every triangle at 768 pixels in front, back, left
and right views. All stages use the same neutral material (base 0.45,
roughness 0.65, metallic zero), area lights, world, view transform and camera
framing from the pre-QEM bounds. Blender smooth normals are recomputed using
the same method for each topology. These are diagnostic clay renders, not
the generated PBR material or the desktop export's exact normal implementation.

30,000 deterministic area-distributed surface samples per direction were queried
against the other mesh's triangle BVH. Before-to-QEM mean distance was 0.0000894
native units and the 95th percentile was 0.000370, or 0.0214% of the bounding
diagonal. Reverse-direction p95 was 0.0209% of the diagonal. The maximum sampled
forward distance was 0.00435; this is not a Hausdorff bound. Small global distances
do not rule out visible local bevel and shading changes. Cleanup removed eight
faces and produced no visible change in the inspected views.

## Decision and limits

Retain this as a candidate for improving crispness. Next compare normals on
the exact same simplified topology, then consider a higher face target if
needed. The original multi-million-face mesh is a reference, not a proposed
shipping default. No defaults, inference code or app bridge were changed.
One hard-surface asset does not establish behavior on organic assets. GPU
simplification may not reproduce identical triangles across runs.

Local evidence is under ignored `out/material-research/geometry-study/`:
`replay.log`, `meshes/`, `render.py`, `render.log`, `report.json`, `comparison.png`,
and twelve full-resolution images in `renders/`. The report records stage hashes,
counts, material, bounds, light positions/energies and surface metrics.

Reproduction from the repository root:

```powershell
./build-material-cuda/post-replay.exe out/material-research/decoder-second-asset/capture-run/post.bin out/material-research/geometry-study/unused.glb --faces 150000 --band 1 --no-bake --geometry-study out/material-research/geometry-study/meshes
```

Use a new output directory. `--geometry-study` requires `--no-bake` and QEM,
and refuses existing directories. Each binary stores two int32 counts (vertices,
triangles), float32 XYZ positions and int32 triangle indices in native coordinates.
The CUDA harness built successfully; `tools/test_post_replay_studies.py` passed,
including stage capture, the existing hole-fill behavior, refusal to overwrite,
and the pre-existing material replay checks.

## Normals-only follow-up

2026-09-13: changing normals alone recovers some apparent bevel sharpness, but
none of the tested alternatives provides a clear overall replacement for the
exporter's existing normals. Flat shading sharpens the panel while exposing
triangular facets on bolts, corner plates and imperfect planar surfaces.

All five variants reuse the exact `qem.bin` mesh above: 69,349 vertices and
138,936 triangles. Blender's position and triangle arrays were checked for exact
equality after each normal treatment. The same 768-pixel cameras, framing,
neutral material, lights and colour-management settings were used for twenty
renders, inspected in front, back, left and right views.

| Normal treatment | Observation |
| --- | --- |
| Blender smooth (previous comparison) | Soft bevels and uneven highlights remain. This is a continuity reference, not the native export baseline. |
| Exporter-style area-weighted, welded by exact position | Slightly cleaner in places than Blender smooth, but panel bevel softness remains. The diagnostic calculation reproduced all normal components in the saved native Q4 GLB exactly (maximum absolute error zero). |
| Flat, one normal per triangle | Clearly sharper panel bevels, with visible facets on bolts, plates and other surfaces. Useful evidence that normals contribute; not selected as a global default. |
| Blender smooth with edges above 30 degrees marked sharp | Does not clearly recover the panel's crispness; some features change, but no overall win was established. A single threshold is not an exhaustive crease test. |
| Detailed-mesh normals transferred to simplified vertices | Did not clearly restore the detailed mesh's appearance; bevel highlights remain uneven. This tests nearest-surface interpolation of area-weighted source normals at vertices, not per-pixel normal baking or every possible transfer method. |

The transfer uses the pre-QEM triangle BVH, barycentric interpolation of its
area-weighted vertex normals, and normalization at each simplified vertex.
Mean projection distance was 0.0000480 native units; maximum was 0.000877.
It preserves one shared normal per vertex and cannot encode every sharp normal
discontinuity inside the simplified triangles.

Four Blender-smooth corner normals had zero length and were excluded from
angular statistics; other variants had none. Angular differences describe
changed shading inputs, not quality scores. Render controls were checked equal
across variants and all normals were finite. Production geometry, normals,
materials and defaults remain unchanged.

### Decision

Retain selective hard-edge shading as a research candidate, not a universal
flat-shading change. A viewer-side crease treatment can be investigated without
changing inference. The existing app normal-recalculation operation does not
provide the tested selective crease treatment. Detailed-source normal transfer
would need access to a retained pre-simplification surface; it is not a capability
established by the current saved-GLB workflow. No native capability is added here.

The next controlled geometry test can raise the face target while keeping
exporter-style normals fixed. This would test whether more topology preserves
bevel transitions without the faceting exposed by flat shading. Any eventual
candidate still needs generated-material renders and more than one asset.

Evidence is retained in ignored `out/material-research/normals-study/`:
`render.py`, `render.log`, `report.json`, `analyze.py`, `validation.json`, saved
normal arrays, twenty full-resolution renders, `comparison.png`, and
`smooth-vs-flat.png`. The report records source hashes and identical render
controls; validation records exact native-normal agreement. Run `render.py`
with Blender background mode and `analyze.py` with Python; render directories
must not already exist. This follow-up changed research documentation only.

## Higher face-target follow-up

2026-09-13: targets of 300,000 and 600,000 improve the crate's panel borders,
bevel transitions and uneven highlights relative to 150,000 with the same
exporter-style normal method. The 300,000 target provides a useful visible gain;
600,000 is cleaner again, but neither completely matches the detailed reference.
This is a more promising compromise for this asset than globally flat shading.

Both CUDA replay runs used the same saved material-research capture, band 1,
and existing QEM algorithm. Their pre-QEM meshes are byte-identical to the
original test (SHA-256 `55abae96247cda37feb3d5ea90ea9da84705adc1116bfe88a50b18763deb0ba0`).
No neural generation or material baking was repeated. The comparison uses the
mesh immediately after QEM, before subsequent cleanup, consistently across
all three targets. The reference is the 6,916,476-triangle pre-QEM mesh.

| Requested target | Actual triangles | Vertices | Raw position/index dump | Surface-distance p95, % of reference diagonal |
| --- | ---: | ---: | ---: | ---: |
| 150,000 | 138,936 | 69,349 | 2.50 MB | 0.02086% |
| 300,000 | 280,806 | 140,263 | 5.05 MB | 0.01368% |
| 600,000 | 572,570 | 286,114 | 10.30 MB | 0.00989% |

MB is decimal; these are position/index diagnostic files, not finished GLB
sizes or GPU memory. Surface distances use 30,000 deterministic area-distributed
samples from each simplified surface to the reference triangle BVH. They are
one-direction estimates, not Hausdorff bounds or source-image fidelity scores.
The p95 displacement decreases by about 34% and 53% relative to the baseline.

All four meshes use exact-position-welded area-weighted normals, including the
detailed reference. Sixteen 768-pixel renders were inspected across front, back,
left and right views. Material, framing, lighting, colour management and normal
method were verified equal; normals necessarily change with topology. Every
baseline image exactly matches the preceding exporter-style normals test.

Replay wall times were 39.21 and 39.83 seconds for 300k and 600k respectively.
The logged decimation/cleanup scope took 4.7 and 5.3 seconds, versus 4.2 seconds
in the earlier 150k run. These are single runs including research overhead,
not a performance benchmark. UV generation, baking, export size and viewer
performance at the higher targets have not been measured. Existing cleanup
later reduces the two new results to 280,804 and 572,544 triangles; those cleanup
meshes are retained but are not the rendered comparison surfaces.

### Decision after face-target test

Keep a 300,000 target as a candidate for hard-surface quality evaluation: it
gives a visible improvement here at roughly twice the baseline triangles.
The 600,000 target is an additional quality option at roughly four times the
baseline triangles, not a demonstrated best default. Validate generated-material
exports, downstream cost and another asset before changing presets. Existing
target-face controls support this experiment; no new native capability is needed.
Production defaults and code are unchanged by this follow-up.

Local evidence: ignored `out/material-research/face-target-study/` contains
`replay.py`, both native logs and mesh sets, `runs.json` (commands, hashes, times),
`render.py`, `render.log`, sixteen renders, `report.json` (counts, hashes, controls,
surface estimates), `analyze.py`, `validation.json`, and comparison images.

## Textured exports and downstream cost

2026-09-13: the 300k improvement is subtler with the generated textures than
in clay renders. Some panel borders, bevels and bolts look cleaner across the
inspected views, but the existing material softness and colour artifacts remain.
Unlit views show small local rebaking differences, not a clear increase in
generated material detail. This evidence supports retaining 300k as an optional
quality candidate, not changing the default based on this one asset.

Four complete postprocessing replays ran serially in 150k, 300k, 300k, 150k
order. All used the same saved Q4 material/geometry dump, resolution 512, band 1,
box UVs, 1024-square atlas and existing exporter normals. The Q8 candidate was
not introduced into this test. Each run produced both WebP and PNG GLBs from
one bake. GPU QEM was repeated, so these are fresh meshes rather than the exact
meshes from the preceding normals experiment; counts also vary between repeats.

| Measurement | 150k target | 300k target |
| --- | ---: | ---: |
| Exported triangles, two runs | 139,256–139,692 | 281,066–281,372 |
| WebP GLB | 4.88–4.89 MB | 9.21–9.22 MB |
| PNG GLB | 7.79–7.80 MB | 12.12–12.13 MB |
| Decoded geometry attributes and indices | 4.55–4.56 MB | 8.88–8.89 MB |
| Logged bake scope | 1.4 s | 2.0–2.1 s |
| Logged simplification/cleanup scope | 3.7–5.0 s | 5.4–5.5 s |
| Entire replay, including both encodings | 39.28–49.56 s | 47.46–48.15 s |

MB is decimal. WebP exports grow about 89%, PNG exports about 56%, and geometry
array payload almost doubles. These array sizes do not represent total runtime
memory or VRAM. Both retain two 1024-square RGBA decoded textures (8.39 MB before
mipmaps and runtime overhead). The wall-time ranges overlap; two repeats per
target do not establish a reliable whole-pipeline slowdown. No neural inference
is included, and producing both encodings is extra research work.

All four exports passed checks: identical PNG/WebP geometry within each run,
exact agreement of decoded PNG textures with raw baked arrays, finite positions
and normals, valid indices, exporter normal reconstruction, equal material
definitions, correct atlas dimensions, and zero faces lost during baking.

The first export at each target was inspected in Blender 5.1.2 using lossless
PNG, with four fixed 768-pixel PBR views and four unlit views. Cameras, framing,
lights and colour management were verified equal within each mode. The PNG
comparison avoids introducing lossy codec differences. The dark PBR material
also limits how much of the clay shading improvement is visible under these
fixed conditions. No texture-resolution or exposure change was made.

As an exploratory downstream check, repeated Blender imports after the first
load took 0.171–0.182 s at 150k and 0.343–0.346 s at 300k. Five repeated warm
EEVEE right-view renders had medians of 0.192 and 0.198 s respectively. These
are same-process, fixed-order observations, not an isolated import benchmark
or GPU kernel timings. Blender render-operator time is not interactive FPS;
desktop Three.js/WebView performance and low-end GPU behavior remain unmeasured.

The current decision is to retain the existing default and keep 300k as an
optional hard-surface quality candidate. A further adoption decision needs
another asset and actual desktop-viewer validation; the larger payload is an
established cost, while the textured visual improvement here is modest.

Evidence is in ignored `out/material-research/textured-face-study/`: four
export pairs, raw atlases, native logs, `runs.json`, `summary.json`, replay and
validation scripts, `render-report.json`, sixteen images in `renders-verified/`,
comparison sheets and `render-verified.log`. An initial render attempt stopped
on a colour-management reset error; its partial `renders/` output and log are
excluded. The corrected complete run explicitly resets the view transform and
passes equal-control checks. No production code or defaults changed.

## Five-example comparison set

2026-09-13: the user found the textured crate difference difficult to see and
requested five examples. A comparison set now covers crate, toolbox, rock,
tree and penguin, with 150k versus 300k targets for each. The crate reuses the
validated textured export pair; the other four reuse saved 512 captures and
run native postprocessing only. Source material, band 1, box UVs, 1024 atlas
and native normal method are fixed within each pair. No neural inference or
model-precision change was made.

| Example | 150k actual triangles | 300k actual triangles |
| --- | ---: | ---: |
| Crate | 139,256 | 281,372 |
| Toolbox | 147,390 | 289,186 |
| Rock | 139,534 | 296,788 |
| Tree | 142,580 | 296,760 |
| Penguin | 148,642 | 288,086 |

Each pair has matching front, right and three-quarter textured views, plus a
three-quarter clay view. Forty images render at 1024 pixels in Blender 5.1.2.
Lighting is four times the earlier textured study's light energy, equally for
both targets, to make inspection easier. Exposure remains zero. Clay uses base
0.12 and roughness 0.65 under this lighting. Camera bounds are shared within
each pair. These images should not be treated as a pixel comparison against
the darker previous study. The modest-looking textured differences remain for
user review; this set does not select a new default.

The local comparison page provides angle selection, an image slider, full-size
image viewing and ten downloadable PNG-textured GLBs. Source exports remain
untouched; download copies are hash-verified. All pairs passed finite geometry,
index bounds, equal material definitions, atlas dimensions, exact PNG-to-raw
texture checks, image-count checks and equal render-control checks. Browser
checks exercised the angle control and image slider.

Evidence: ignored `out/material-research/five-face-examples/`, including
`index.html`, `runs.json`, `render-report.json`, `validation.json`, replay,
render and page-build scripts, forty images, comparison sheets and `models/`.
Open `index.html` locally, or serve that directory with a loopback HTTP server.
Production defaults are unchanged.
