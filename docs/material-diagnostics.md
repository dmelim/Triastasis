# Local material diagnostics

This branch adds opt-in measurements for the
[TRELLIS.2 appearance investigation](trellis-material-research.md). They describe
what a generation did and where data changed. They do not assign a quality score
or automatically fix an asset.

The [research backlog](research-backlog.md) tracks the investigations and their
status. New sampler records include raw/applied guidance ratios, an evaluated
flag and a reason (lower/upper bound, nonfinite replacement, variance fallback,
unchanged or guards disabled). Ratios are null when not evaluated; nonfinite raw
values are also serialized as null, with the reason distinguishing them.

Preprocessing now separates model load/release, image preparation, matte
inference, matte resize/crop and cutout normalization. Mesh preparation separates
weld/fill, BVH construction and remesh component cleanup; optional dump and
auxiliary image/PLY writes are timed. These are nested, inclusive host timings.
The offline summary includes each timer's parent; do not sum a parent and child.

## Controlled replay studies

Use a trusted dump produced by the same source revision's TRELLIS_DUMP_POST
path. This binary research format has no versioned compatibility guarantee.
Create a new output directory for each study and enable diagnostics there.

```powershell
post-replay input.bin study/codec.glb --box-uv --faces 150000 --atlas 1024 --codec-study
post-replay input.bin study/sampling --faces 150000 --atlas 1024 --sampling-study
```

With a WebP-enabled build, the codec study writes WebP at the requested path, PNG at that path plus
`.png.glb`, and the exact `.base.rgba` / `.mr.rgba` atlas bytes. Both encodings
consume one BakedMesh instance. The sampling study reuses one final mesh and
writes `.box-default.glb`, `.box-project-first.glb` and `.xatlas-default.glb`, all
with PNG and raw atlas bytes. It fails instead of silently substituting another
UV method if xatlas fails. Both flags are confined to the developer replay tool.

Project-first sampling tries the existing bounded closest-surface query before
direct sampling; it retains direct/shell fallbacks. It is an opt-in experiment,
not a claim of complete reference parity or a production default. Validate
within-study pairs rather than assuming identity with a historical exported GLB:
repeated full runs have produced different simplified meshes. Current CUDA
replay and generation builds both attempt GPU QEM; a CPU-versus-GPU distinction
does not explain the observed variation. See R10 in the research backlog.

```powershell
python tools/compare_material_exports.py study/codec.glb.png.glb study/codec.glb --samples 64 --output study/error.json
```

This tool verifies geometry/normal/UV arrays and exact triangle-surface identity
despite UV vertex splitting. It estimates texture error at deterministic
area-uniform points per triangle, weighted by world-space area, using bilinear
level-0 REPEAT sampling. MR errors are independent data-channel errors; base RGB
errors are in encoded colour space. It excludes unreferenced gutters but remains
a sampling estimate, not an exact integral, mipmapped render error or quality
score. Compare sampling densities to check convergence. UV-layout mismatches
produce identity results without falsely comparing unrelated atlas pixels.

Synthetic checks: `test_compare_material_exports.py`,
`test_post_replay_studies.py --replay <exe> --scratch <new-directory>` and
`test_native_material_diagnostics.py --cli <exe> --scratch <new-directory>`.
On Windows, the test runtime's backend DLL directory must be on PATH. Native
test subprocesses stay hidden and suppress blocking loader dialogs; a missing
dependency should surface through the captured exit code instead.

### Spatial material probes

The R02 follow-up adds `post-replay input.bin probes.csv --probe-points points.txt`.
Each input line contains three finite native TRELLIS-space coordinates. The tool
rebuilds the original welded/filled mesh BVH, then skips remeshing, simplification,
UV baking and export. The CSV is created only when the destination does not exist;
the session ends as `probe_only`, not as a completed GLB generation.

Records contain direct/projected validity, pre-quantization RGB/metallic/roughness/
alpha, the projected point/face, projection distance in voxel units, populated
corner count and the sum of their interpolation weights before normalization.
Invalid values are zero-filled and must be interpreted through their validity
flags. No projection hit uses face/distance -1. Support is a weight sum, not a
confidence score. The query retains the existing eight-voxel projection limit.
The production trilinear sampler and generation defaults are unchanged.

`tools/material_probe_points.py` runs in Blender and selects nearest surface
points and UVs at pixel centres in four fixed orthographic views of a native GLB.
`tools/analyze_material_probes.py` uses NumPy, Pillow and Matplotlib to compare
the probes with the existing textures and save numerical maps. These are
screen-sampled measurements, not area-weighted errors or renderer-equivalent
images: atlas interpolation, rasterization, quantization and antialiasing differ.
Keep all point files, CSVs, plots and input manifests in ignored research output.

For a dense line, pass `--line X0 Y0 X1 Y1 --samples N --view front` to the
Blender point tool. Coordinates use the existing image's pixel indices, with
the same half-pixel offset as full-view queries. The tool rejects a line that
leaves the surface. The default still queries all four views.

`tools/trace_material_corners.py --dump input.bin --probes probes.csv --output-dir new-directory`
reconstructs direct/projected samples from the saved volume and retains each
corner's coordinate, stored channels, presence, raw weight and normalized weight
in CSV/NPZ. It uses float32 arithmetic and the native corner order, checks both
values and support against the native CSV, and fails on disagreement above
2e-6. The native probe and independent reconstruction agreeing validates those
sample calculations; it does not validate the generated material's appearance.
Synthetic tests cover sparse normalization, an affine field, missing samples
and duplicate-coordinate behavior.

### Decoder layout and selected output-head capture

For a developer runtime, set `TRELLIS_TEX_TRACE_DIR` to a fresh existing ignored
directory and `TRELLIS_TEX_TRACE_POINTS` to a text file containing integer final
voxel coordinates. The material decoder captures input coordinates/denormalized
latent, its four guide masks and output coordinate arrays, the raw six-channel
output, and selected 64-channel features immediately before final normalization
and the output projection. It does not change decoder arithmetic. Existing files
are refused and write failures are reported on stderr without stopping inference;
validate file counts and lengths before using a capture.

The unversioned research files use native little-endian scalar arrays:
`input.coords.i32` and `stage-N.coords.i32` have three integers per voxel;
`input.latent.f32` has 32 floats per input voxel; `guide-N.u8` has eight mask bytes
per parent; `output.raw.f32` has six floats per final voxel. `selected.rows.i32`
contains row index and XYZ, and `selected.prehead.f32` has 64 floats per selected
row. Channels are contiguous within each voxel; ggml's fastest dimension is the
channel dimension. Empty/unset trace settings produce no captures.

`tools/analyze_tex_decode_trace.py` independently expands reference octant order,
checks decoder/postprocess pairing and scale/clamp identity, compares with the
previous material dump, and reconstructs the selected output head using installed
F32/F16/Q4_0 weights. Its CUDA MMA estimate models Q8 activation rounding; it is
not a full reference decoder or original-weight precision comparison. Retain the
model hash/config, capture executable hash and per-method numerical residuals.
Input latents and guide masks enable a later decoder-only replay without rerunning
the stochastic flow or postprocessing stages.

## Enable and store records

Use a runtime rebuilt from this branch. Existing installed release binaries do
not contain these hooks. Enable them in the environment of the process that
launches the runtime:

```powershell
$env:TRIASTASIS_DIAGNOSTICS = '1'
```

For the desktop app, start the rebuilt app from that PowerShell session. Its
server launcher places per-run files in the `diagnostics` subfolder of the
normal server logs directory. Find that location through Settings' server-log
folder action. Both portable and installed modes use the existing path resolver.
The normal per-launch text log continues to capture stdout/stderr as before.
An already-running app or externally reused server must be restarted from the
configured environment to inherit the setting.

For a standalone CLI, files default to the output GLB's parent directory.
For a standalone server, **set an explicit durable directory**, because its
GLB output directory is temporary. Either can use this override:

```powershell
New-Item -ItemType Directory -Force -Path .\out\material-research\runs | Out-Null
$env:TRIASTASIS_DIAGNOSTICS_DIR = (Resolve-Path .\out\material-research\runs).Path
# Launch your newly built GPU runtime/app with its usual arguments here.
```

The native logger requires its destination directory to exist. The desktop
adapter creates its default `diagnostics` subfolder; a custom override is caller
owned. If storage cannot open or write, generation continues and stderr reports
the diagnostic-storage failure. Logging does not create a missing GLB parent
directory or alter export success.

Each enabled run creates `triastasis-diagnostics-<run-id>.jsonl` with exclusive
creation, even when its seed repeats. Records flush after each event; a killed
process may leave a truncated final line or no `run_end`. This is application
buffer flushing, not a promise of survival through power loss. JSONL is plain
JSON, one event per line. The same events appear in stderr with the searchable
`[triastasis-diag]` prefix.

The structured record includes a runtime/build identity, resolved seed, and a
`correlation` event with output filename and, for HTTP generation, the existing
native request ID. Match that ID to the generation manifest's `nativeRequestId`.
The structured record does not include source pixels, tensor dumps or full model
paths. Existing text logs may still contain paths and diagnostic details.

Unset the setting or set it to `0` to disable measurements. Only exact `1`
enables them. Disabling creates no new structured files and skips data scans and
codec roundtrip decoding. The flags do not change generation defaults.

Structured records remain until explicitly removed; they are not subject to the
desktop text log's 20-launch retention policy. Keep comparisons under ignored
output folders, archive useful runs, and remove unneeded records manually.
Generated JSONL filenames are ignored by Git. No records are uploaded.

## What is measured

For isolated decoder research, build `trellis-tex-decode-replay` and run:

```powershell
cmake --build build --target trellis-tex-decode-replay
build/trellis-tex-decode-replay.exe models/tex_dec.gguf out/capture out/replay 0
```

It consumes the `input.coords.i32`, already-denormalized `input.latent.f32` and
four `guide-<stage>.u8` files from the opt-in texture trace. The output directory
must be new; it stores `output.raw.f32` (six channels before scale/clamp) and
`replay.json` with model-load/decode wall times. Capture stdout/stderr to a
separate log. The optional GPU argument defaults to 0; -1 selects CPU, and an
unavailable requested GPU is an error. This is a trusted local research format,
not an import API or supported model checkpoint format.

Set `TRELLIS_TEX_TRACE_DIR` to a separate fresh directory to retain replay input
and expanded-coordinate evidence. `tools/compare_tex_decode_replays.py --help`
documents comparison against a reference trace and saved corner/point arrays;
it rejects changed inputs or coordinate order before comparing values. Model
hashes and tensor provenance must be checked separately, as in the
[precision study](decoder-precision-study.md). Replaying with a different decoder
does not require replacing the application's installed models.

For the subsequent export check, `tools/prepare_fixed_box_replay.py --input
out/reference.glb --output out/fixed-box.bin` extracts an existing native 4x3 box
atlas. Then run `post-replay out/post.bin out/rebaked.glb --fixed-box-mesh
out/fixed-box.bin --material-raw out/trace/output.raw.f32 --project-first`.
The last flag selects the earlier research sampling variant; omit it to use
direct-then-project sampling. This path builds only the original mesh BVH and
rebakes the fixed layout, skipping remesh/decimation/unwrap. Outputs include PNG
GLB and `.base.rgba`/`.mr.rgba` arrays and must not already exist. Verify the raw
decoder coordinate order against the dump before use: this trusted format has
no embedded model/coordinate fingerprint. Only native box atlases are supported.

`fixed_box_settings` reports the effective atlas, face count and sampling method;
the earlier `replay_settings` also contains ordinary requested defaults that the
fixed path skips. `source_dump_voxel_pbr` describes the original dump;
`fixed_replay_voxel_pbr` describes the selected decoder output after scale/clamp.
Create `TRIASTASIS_DIAGNOSTICS_DIR` before launching to store JSONL independently
of captured stderr. Keep model/geometry hashes and rendering settings with each
experiment as described in the [precision study](decoder-precision-study.md).

| Event family | Observations | Interpretation |
| --- | --- | --- |
| `run_start`, `correlation`, `run_end` | Unique run ID, sequence, monotonic elapsed time, build commit/dirty flag/backend/version, seed and request correlation | `completed` means the native GLB writer returned success. `failed`, `output_failed`, `incomplete`, and background/replay-only runs are distinct. It is not proof that the client imported or saved the result. |
| `requested_settings`, `sampler_settings` | Resolutions, atlas, face target, remesh band, background/UV/encoding request, GPU/precision flags, guidance, intervals, steps and time warping | Requested auto values retain their native sentinel values, generally `-1` or `0`. Use the later decision events for actual choices. |
| `model_loaded`, `model_tensor_type` | Model basename, actual backend name, weight bytes, tensor count/type breakdown | Quantization and CPU fallback become visible. Weight bytes are not peak RAM or VRAM. These are not cryptographic model fingerprints. |
| `input_mask`, `background_method`, conditioning distributions | Dimensions, foreground fraction inputs, crop size, empty-mask fallback, effective alpha/threshold selection and feature statistics | Detects conditioning differences before generation. No source image is copied by this logger. |
| `stage_start`, `stage_end` | Inclusive host wall time and exception-unwinding indication | Includes model loads and diagnostic overhead. Nested scopes must not be summed. Unmeasured cleanup/I/O can remain between stages; these are not GPU kernel timings. |
| `sampler_step`, `sampler_end` | Actual forward count, nonfinite velocities before correction, replaced count, guidance-ratio correction, resulting nonfinite state and maximum magnitude | Shows when numerical protection changed invalid predictions instead of silently hiding them. |
| `cascade_budget`, `decoded_shape`, `material_resolution`, `material_layout` | Tried/accepted grids and tokens, mesh/voxel counts, material backoff reason and effective guide resolution, actual/expected PBR array size | Distinguishes shape grid, material volume and atlas size. |
| `distribution`, `pbr_layout` | Per-channel finite count, nonfinite count, extrema, mean, population standard deviation, out-of-range counts and fractions' numerators | Decoder before clamp, clamped volume, and atlas populations can be inspected separately. Empty populations have `null` statistics. |
| `voxel_sampling` | Direct trilinear, BVH-projected, shell-averaged and failed sample attempts | Counts include overdraw. Failed attempts are not a count of unique holes or bad texels. Successful sampling does not establish correct layer alignment. |
| `atlas_population` | Successfully baked texels before filling; whole atlas after filling | Unwritten atlas space includes gutters and uncovered chart regions. It is not automatically missing surface coverage. |
| `postprocess_settings`, `remesh_result`, `simplified_mesh`, `uv_fallback`, `bake_result` | Actual postprocessing choices, resulting counts, fallback decisions and atlas result | A fallback is observable without changing the fallback behavior. |
| `texture_encoding`, `encoding_error` | Effective PNG/WebP, encoded sizes, material layout; WebP per-channel MAE, RMSE and max error after decoding | Errors compare exact input bytes with decoded WebP, normalized to `[0,1]`. They include the whole atlas and gutters. PNG does not emit a synthetic zero-error measurement. |

PBR channel order is base red/green/blue, metallic, roughness, alpha. Texture
metallic is stored in blue and roughness in green. Distribution thresholds are
`<= 0.05` and `>= 0.95`; divide counts by `finite`, never by an unrelated voxel or
pixel count. `base_code_luma` is `0.2126R + 0.7152G + 0.0722B` in the stored colour
domain. It is a darkness proxy, **not** linear luminance, perceptual fidelity or
an exposure recommendation.

Do not subtract the mean of all generated voxels from the mean of baked texels
and label that “quality lost in baking.” The populations differ. Spatially matched
sampling and controlled renders are still needed to confirm a cause.

## Read and compare saved runs

The summarizer uses Python's standard library. Pass one or more JSONL files or
normal desktop server logs; records present in both are deduplicated by run ID
and sequence.

```powershell
$runLogs = @(Get-ChildItem .\out\material-research\runs -Filter *.jsonl |
    ForEach-Object FullName)
python tools/material_diagnostics.py @runLogs --output out/material-research/summary.json
```

The output groups distributions, settings, timings, sampling rates, numerical
corrections and codec errors per run. It marks missing lifecycle events, sequence
gaps, invalid JSON and conflicting duplicate events. Reports are created without
overwriting existing files. Omit `--output` to print JSON. Exit code 2 means there
were parse/file problems or no supported events; an incomplete generation is
reported in the JSON rather than conflated with a parser failure.

Keep source hashes, exact GLBs, runtime/model hashes, manifests and fixed camera/
lighting conditions with each experiment. A runtime commit plus tensor-type
counts does not identify exact weights. Request-ID correlation is not content
identity. Same seeds across Python and C++ do not imply matching random samples.

`post-replay` also opens a diagnostic session and records its effective settings
and replayed material volume. Its seed is marked unknown via the `replay` event;
the `run_start` seed of 0 is a placeholder. The replay tool uses its existing
defaults, including band 1; match production explicitly when comparing.

## Validation

The focused native executable uses small synthetic data, no model weights or GPU
inference. Run from a Visual Studio developer terminal after configuring a CPU
build (WebP enabled exercises codec diagnostics):

```powershell
cmake --build build-material-diagnostics --target trellis-test-diagnostics trellis-cli trellis-server post-replay
.\build-material-diagnostics\trellis-test-diagnostics.exe out/material-research/native-unit
python -m unittest discover -s tools -p test_material_diagnostics.py
python tools/test_native_material_diagnostics.py --cli build-material-diagnostics/trellis-cli.exe --scratch out/material-research
cargo fmt --manifest-path app/src-tauri/Cargo.toml --check
cargo check --offline --manifest-path app/src-tauri/Cargo.toml
```

Tests cover identical baked geometry/UV/texture arrays with measurements on/off
for all three UV methods; nonfinite statistics; sampler correction counting;
unique stored runs; disabled logging; storage failure; and JSON parsing. The
real CLI test checks byte-identical cutouts, Unicode log-directory paths,
repeated seeds, failed preprocessing, and persistence independent of stderr.
Synthetic test output stays under ignored `out/`.

Validation on this branch includes CPU/WebP and CUDA native builds, focused
synthetic checks, Rust checks, five Low generations, controlled codec/sampling
replays and four repeated CUDA generations. This does not validate Vulkan/ROCm
inference or a packaged desktop launch. Research inputs were exported through
the library workflow; original records were preserved. Full-tensor scans and
WebP decoding add work when enabled; two repetitions per logging condition do
not establish a reliable overhead estimate. Peak-memory costs remain unmeasured.

The follow-ups retain fixed renderer settings and surface-weighted codec
comparisons. Viewer lighting snapshots, spatially paired volume-to-surface
samples, distribution percentiles, peak device memory and per-layer GPU timings
remain outside this instrumentation step. These aggregate logs are not a
complete explanation of appearance.
