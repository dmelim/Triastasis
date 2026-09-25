# Getting more from the existing TRELLIS.2 models

Research snapshot: 2026-09-24. This is a source-based opportunity assessment,
not a benchmark result or an implementation commitment. No inference, runtime
installation, model download, upstream integration, or production change was
performed for this report.

Follow-up (2026-09-25): [controlled experiment results](model-runtime-experiments.md)
now record exact preparation reuse and material continuation, the 8/12/16-step
screen, a failed streamed-block numerical check and the untested CUDA-graphs
comparison. Use those decisions for current prioritization; the proposals below
remain the historical source-based assessment, not adopted changes.

## Recommendation

There is meaningful room beyond the previous material investigation. Pursue
three outcomes separately: better reconstruction from the same weights, less
work when exploring alternatives, and successful generation within available
memory. A faster kernel alone does not improve reconstruction; it can make a
better sampling budget or more candidate exploration affordable.

The best first investigations are **stage-specific sampling**, **input and
conditioning reuse**, and **the upstream bounded-memory patch**. A separate
**CUDA graph replay** build experiment is worthwhile on supported NVIDIA GPUs.
Preserving a chosen shape while regenerating its materials is a larger but
potentially valuable workflow improvement. Approximate step caching belongs
later, after establishing ordinary fewer-step baselines.

One important product distinction: the current **High preset does not spend
more sampling steps on the models than Medium**. Both request 1024 geometry;
High primarily raises the face target and atlas size and selects PNG and
BiRefNet. All flows still use 12 steps. See
[presets](../app/src/generation-presets.ts) and
[pipeline](../src/trellis_cli.cpp). A future inference-quality preset would be
a genuinely different control, and would need evidence before adoption.

## Evidence and versions

- Local source: `f37c0ee755a731ee4887bcd7e4ee0586ddf05373` on
  `research/trellis-material-diagnostics`; GGML gitlink
  `737e88f25d4f62254f3b7a726fd9663036cc94da`.
- Microsoft reference: `75fbf0183001ed9876c8dbb35de6b68552ee08bd`, verified as
  current `main` through the GitHub API on the research date.
- Native upstream: `4f5be33a95b712ada079ea485637de61f85ebad4`, current `main`
  and the [v0.8.0 release](https://github.com/pwilkin/trellis.cpp/releases/tag/v0.8.0)
  published on the research date. The earlier material investigation examined
  upstream `2516c48b677050c570f47eba2e68dc8a5bc918b0`.
- Third-party acceleration sources: fast-trellis2
  `e56b07810366f7d6d0b9c5915441ece546964ea5`; ComfyUI-TRELLIS2-HiCache
  `af838dfdf08aa7db5ddbabeda2c5b55ad03f679c`.

Local source observations below establish available mechanisms, not measured
benefits. External benchmarks remain their authors' results on their workloads.
Proposed experiments and rankings are our assessment. The prior Q8 material
decoder candidate remains deferred to final evaluation; this report does not
restart that work.

## Opportunity map

Boundary labels: **App** consumes the existing request protocol; **Expose**
surfaces a native capability with a small bridge change; **Native** requires a
new capability or sustained native work; **Upstream** reviews an existing
upstream change for integration. Native proposals need a scope decision before
implementation under the project's maintenance policy.

| Opportunity | What it could improve | Evidence today | Boundary / priority |
| --- | --- | --- | --- |
| Stage-specific steps, guidance and time schedule | Fidelity per second; spend work on the stage that needs it | Parameters exist internally; steps are fixed by orchestration | Expose/Native; first quality study |
| Mask and crop quality; exact conditioning cache | Better input fidelity; faster repeated seeds | Existing alpha input; repeated BiRefNet/DINO work; prior matte timing | App for prepared input; Native for exact cache; first study |
| Bounded dense decoding and attention memory | Complete difficult assets at the intended resolution | Upstream patch with reported Windows/Vulkan runs; absent locally | Upstream; first runtime review |
| CUDA graph replay | Lower repeated kernel launch overhead | Bundled GGML mechanism, disabled by default in this build configuration | Runtime build experiment; early, NVIDIA-specific |
| Retain a shape and rerun only materials | More useful attempts per minute; preserve accepted geometry | Internal stages are separate; no product continuation protocol | Native plus small protocol; high product value, larger scope |
| Cache fixed cross-attention projections | Avoid repeated identical matrix work within a flow | Direct dependency analysis of local graph | Native; profile before implementing |
| Selective model residency and GPU sampling state | Reduce loading, transfers and synchronization | Explicit load/free and host round trips in local source | Native; profile before implementing |
| Precision allocation beyond the material decoder | Protect the stages that actually lose useful information | Mixed files are loadable; quality benefit unmeasured for these stages | Native research/catalog work; later |
| Approximate velocity/feature caching | Fewer expensive transformer evaluations | Third-party TRELLIS.2 implementations and author benchmarks | Native port; experimental, later |
| Higher-order flow solvers | Better integration at a fixed evaluation budget | General rectified-flow research; no local validation | Native sampler research; later |
| Multiple input views | More evidence about hidden surfaces | Unmerged reference proposals, no local support | Native or separate adapter; exploratory |

## 1. Allocate inference work by stage

The native pipeline fixes `flow_steps = 12` and uses it for sparse structure,
low-resolution shape, high-resolution shape when enabled, and materials.
`SamplerParams` already represents step count, guidance strength/rescale,
guidance interval and time rescaling. Only sparse/shape guidance strengths are
CLI/environment options; the app's request API does not expose them. Other
sampler settings are assigned in C++.
[Sampler interface](../include/flow_runner.h),
[arguments](../include/trellis_args.h), [request API](../app/src/api.ts).

Our defaults match the published stage settings: sparse/shape guidance 7.5,
material guidance 1, and 12 steps. They are a defensible baseline, not proof
of the best settings for every asset.
[Microsoft model configuration](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/main/pipeline.json).

**Proposed quality study:** vary one stage at a time, beginning with 8/12/16/24
steps for shape. Freeze input conditioning and starting noise. Test texture
steps only after fixing the shape latent, so geometry variation cannot masquerade
as a material improvement. Examine thin parts, hard edges, organic forms and
repeated details. Then test a small guidance/time-schedule neighborhood only for
the stage showing an actionable failure. More guidance can distort shape; more
steps can converge toward an imperfect model prediction rather than the source.

Compare actual model forward calls and elapsed time, not steps alone:
classifier-free guidance executes conditioned and unconditioned passes within
its interval. Materials at guidance 1 currently need only one pass per step.
[Local sampler](../src/flow_runner.cpp),
[reference Euler sampler](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/pipelines/samplers/flow_euler.py).

This first needs a small research parameterization of orchestration and progress
totals; it is not achievable through a hidden existing HTTP setting. Only add
product controls and manifest fields after identifying useful configurations.

## 2. Improve and reuse what the models see

Input preparation is upstream of every generative decision. A missing handle
or erased highlight in the mask cannot reliably be recovered by increasing
sampling effort. Local alpha input is already supported. Crop size, alpha-edge
treatment and resizing are useful quality variables, particularly for thin,
white, reflective or partially transparent subjects.

The local crop adds a 10% margin; the inspected reference uses no added margin.
The alpha-presence tests also differ. These are concrete comparison targets,
not established defects or instructions to change the native defaults.
[Local preprocessing](../src/preprocess.cpp),
[reference preprocessing](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/pipelines/trellis2_image_to_3d.py).

Every request reruns preparation and DINOv3 encoding, even for the same image
with a different seed. The previous research isolated **36.33 seconds of matte
inference in one run**; that observation motivates profiling but is not a
general speedup estimate. Exact-input reuse is already an untested R08/R11
candidate, now with a concrete runtime target.
[Existing backlog](research-backlog.md).

Cache the canonical prepared arrays and/or DINO features, keyed by source
content, mask/options, preprocessing version, conditioning resolution, model
hash/precision and relevant backend identity. Bound the cache and invalidate it
when any dependency changes. The current 512 and 1024 feature arrays together
are about **20 MiB** of F32 data, derived from `(1029 + 4101) * 1024 * 4` bytes;
this is an array-size calculation, not measured cache overhead.
[Encoder](../src/dinov3.cpp).

Do not implement this by sending our exported cutout through preprocessing
again. The cutout already contains cropped, premultiplied RGB plus alpha;
re-import can crop again and multiply fractional alpha again. A real cache
must bypass that work and demonstrate identical conditioning arrays. A
user-supplied correctly prepared RGBA image is a separate existing input option.

## 3. Review upstream memory fixes before inventing new ones

[Upstream PR #46](https://github.com/pwilkin/trellis.cpp/pull/46) bounds attention
mask allocations, streams large sparse decoder work and reduces host
postprocessing memory. Its author reports 18 completed consecutive Windows
Vulkan generations on a 16 GB RX 9070 XT. That soak used an earlier base; the
reported rebased integration was compile-tested. These are reliability results,
not a quality or speed benchmark for Triastasis.

GitHub's live API confirms merge on **2026-09-19**, merge commit
`99ae104b1f955cb0e4999f643ffebb58492cf536`; the search-indexed PR page still
showed it open. The patch commit is
[`fbd6bcc59930032f7501bd6033096759c2882659`](https://github.com/pwilkin/trellis.cpp/commit/fbd6bcc59930032f7501bd6033096759c2882659).

Local comparison confirms the full-flow attention mask and older decoder
allocation paths remain. There is already some chunking locally, so the
opportunity is the improved bounds and lifetimes, not adding chunking from zero.
[Attention](../src/dit.cpp), [sparse decode](../src/sparse.cpp),
[shape decoder](../src/shape_decoder.cpp).

Review this patch in isolation on an integration branch, retaining our
diagnostics and protocol behavior. Test both ordinary and dense inputs, peak
host/GPU memory, time, intermediate numerical agreement and visual output.
Smaller working sets can introduce transfers and slow execution. A completed
high-resolution run is valuable, but lower allocation size alone does not
establish identical output or acceptable duration. No patch was adopted here.

The earlier FlashAttention value scaling, mask-stride safeguards, CPU threading
and striped BiRefNet work are already represented locally; they are not new
opportunities from this survey.

## 4. Test CUDA graph replay as a bounded build experiment

Each `DitRunner` already builds one GGML graph and reuses it through the flow.
GGML's **CUDA graph replay is a separate lower-level mechanism** that can
reduce repeated launch overhead. Our pinned GGML defaults `GGML_CUDA_GRAPHS`
to OFF, and the root build/release workflow does not enable it. This establishes
the repository build configuration, not the flags in an independently installed
binary.
[GGML CMake](../thirdparty/ggml/CMakeLists.txt),
[release workflow](../.github/workflows/release.yml),
[runner](../src/flow_runner.cpp).

The pinned implementation has warmup and graph-compatibility checks and disables
this path below Ampere. Its option description says "llama.cpp only", so it
needs an isolated compatibility experiment rather than an assumed supported
Trellis optimization.
[CUDA implementation](../thirdparty/ggml/src/ggml-cuda/ggml-cuda.cu).

Compare the same source, weights and workloads with the build option off/on on
an eligible GPU. Verify actual capture/replay, amortized stage time and output
agreement, including repeated requests and changing token counts. Twelve-step
flows may offer limited amortization. This is unrelated to `torch.compile`,
which cannot optimize our C++/GGML execution path.

## 5. Preserve accepted work between attempts

The app already has **512 seed sweeps**; adding seed search is not a new feature.
They retain the selected texture setting. Geometry-only generation also exists.
A useful app-level experiment is whether geometry-only candidate screening
saves enough time without causing users to select worse final assets.
[Sweep orchestration](../app/src/main.ts), [parameters](../app/src/types.ts).

The larger missing capability is **continuation from saved internal state**:
retain shape latents, ordered coordinates, subdivision masks, conditioning and
resolved settings, then regenerate only materials or continue the cascade.
Today the server calls the full pipeline for every generation. Existing decoder
and postprocess replay tools are research facilities, not a supported resumable
generation contract.
[Server](../src/trellis-server.cpp), [replay diagnostics](material-diagnostics.md).

This could let a user keep a good shape while exploring several materials, and
avoid repeating preprocessing and geometry. A final GLB cannot substitute for
the internal shape state. Preserve the exported geometry too if exact mesh
identity matters, because final postprocessing repeatability remains unresolved.
Record the realized seed and state/noise at boundaries: the current pipeline
uses a sequential RNG, and seed 0 requests randomness. Re-seeding one later
stage is not equivalent to continuing the original sequence.

Microsoft also provides an external-mesh texturing pipeline, but it voxelizes
the supplied mesh and uses a shape encoder. That is a different, larger native
capability than retaining the shape we already generated.
[Reference texturing pipeline](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/trellis2/pipelines/trellis2_texturing.py).

## 6. Profile exact reuse inside the runtime

Three source-derived hypotheses deserve separate measurements:

- **Cross-attention K/V projections.** Every block computes `to_kv(cond)` on
  every forward, although the image conditioning and weights are fixed within
  the stage. Precomputing this branch, including fixed key normalization, is an
  exact-reuse candidate if it preserves arithmetic and dtype. Conditional and
  unconditional branches need separate entries; self-attention K/V changes with
  the latent and cannot be cached this way. Retaining all 30 blocks' K/V at
  4101 conditioning tokens costs about 1.41 GiB per branch in F32 before overhead
  (`30 * 2 * 1536 * 4101 * 4` bytes). Lower-precision storage changes the numerical
  question. The memory tradeoff may outweigh saved work.
  [Cross-attention code](../src/dit.cpp).
- **Weight residency.** The resident process does not retain every model's
  weights. `Model::load` streams tensors from disk into backend buffers and
  `free` releases them at stage boundaries. Profile disk reads, transfers and
  initialization separately, including OS page-cache effects. A bounded host
  cache or selective GPU residency is more plausible than retaining everything;
  activation headroom must determine eviction. The shape decoder is loaded at
  multiple points in some cascade/material paths.
  [Loader](../src/trellis_model.cpp), [orchestration](../src/trellis_cli.cpp).
- **GPU-resident sampling.** Each forward uploads the latent, conditioning and
  RoPE inputs, computes the graph and reads velocity to the CPU. Guidance,
  statistics and Euler updates run on host vectors. Device-side updates could
  remove transfers/synchronization, but need to preserve guards, progress and
  diagnostic behavior. Do not simply remove the constant uploads: the runner
  explicitly notes that its allocator reuses those input buffers.
  [Forward and sampler](../src/flow_runner.cpp).

These are new native maintenance, with no measured local speedup. Profile first;
focus on whichever cost is material. Launching simultaneous requests is not an
equivalent shortcut: the server serializes generation and the pipeline uses
shared runtime flags, so concurrency requires its own correctness/memory design.

## 7. Approximate acceleration and alternative samplers

There is TRELLIS.2-specific evidence worth investigating, beyond generic video
diffusion claims:

- [fast-trellis2](https://github.com/Archerkattri/fast-trellis2/tree/e56b07810366f7d6d0b9c5915441ece546964ea5)
  ports Taylor/delta caching and token carving. Its README reports 1.89x
  end-to-end speedup on an RTX 5090, 1024 cascade, resident weights, and the 35
  objects completed by every configuration from a 40-object test. The author
  labels this prior-run evidence, not current acceptance. Completed-case
  selection and geometry-focused scores limit the quality conclusion.
- [TRELLIS2 HiCache](https://github.com/Archerkattri/ComfyUI-TRELLIS2-HiCache/blob/af838dfdf08aa7db5ddbabeda2c5b55ad03f679c/README.md)
  reports 1.9x on an RTX 5090 with the 512 pipeline and shape-stage forecasting.
  It maintains separate conditional/unconditional forecast states. Its distance
  to the stock mesh does not establish correct materials, source fidelity or
  performance on our quantized GGML runtime.

These predict omitted model computations and can change output. Neither is a
drop-in DLL or GGML flag. A port must handle decreasing time, guidance-interval
transitions and cache invalidation across stages, resolutions and voxel layouts.
Our short 12-step schedule leaves less room after warmup than long diffusion
schedules. Test shape stages first and compare against simply using fewer Euler
steps at the **same wall-clock budget**. Include every failed case and texture
quality before claiming a win. Do not describe forecasting as lossless caching.

A higher-order solver is another training-free possibility. For example,
[RF-Solver](https://arxiv.org/abs/2411.04746) studies rectified-flow integration
for image/video generation and inversion. That motivates an experiment, not a
TRELLIS.2 recommendation. Compare Euler with a velocity-appropriate higher-order
method at matched forward-call and time budgets; additional evaluations per
step and guidance discontinuities matter. Do not substitute a diffusion sampler
without adapting its mathematical conventions.

## 8. Precision, additional views and model alternatives

Beyond the parked material-decoder finding, study precision **one model stage at
a time** if a concrete quality failure remains. BiRefNet affects masks, DINO
affects conditioning, and sparse/shape flow and shape decoding affect geometry.
Use compatible files from the same conversion lineage. Fixed decoder replays
isolate arithmetic; end-to-end comparisons measure the downstream consequences.
Q4/Q8/F16 file size alone does not predict speed, activation memory or fidelity.
The F32 compute switch cannot reconstruct information removed from Q4 weights.
Avoid disabling numeric safeguards or using experimental fast attention modes
as an assumed free improvement.
[Model loader](../src/trellis_model.cpp), [precision study](decoder-precision-study.md).

Multiple consistent views could supply missing evidence about backs and hidden
parts, but reference [PR #104](https://github.com/microsoft/TRELLIS.2/pull/104)
remains an unmerged proposal. There are also
[reports of worse multi-image output](https://github.com/microsoft/TRELLIS.2/issues/103).
Treat it as research needing view-consistency and quality evaluation, not an
existing model feature we can activate from the UI. A collage is not a
substitute for a validated multi-view conditioning algorithm.

Native upstream v0.8.0 now includes Pixal3D support, changing the implementation
options for the separate optional-engine idea. It uses additional weights and
conditioning behavior; it is outside this same-model optimization study. The
release still lacks ported MoGe-2 camera estimation. Reassess that engine
separately rather than presenting it as a TRELLIS runtime setting.
[Release details](https://github.com/pwilkin/trellis.cpp/releases/tag/v0.8.0).

## Proposed experiment order and decision rules

1. **Establish the cost and quality baseline.** Reuse existing diagnostics;
   separate cold process, warm process and repeated-image cases. Record actual
   runtime/backend, model hashes, resolved seed, requested/accepted resolution,
   stage times, forward calls and peak RAM/VRAM. Verify GPU use and fallback.
2. **Investigate input conditioning and exact reuse.** Compare mask/crop choices
   for quality separately from caching. Require identical cached conditioning
   and no stale result after an input/model/settings change.
3. **Run the stage-budget quality screen.** Use fixed input/noise and a small
   representative set; compare models at equal time as well as equal steps.
   Expand only promising settings. More triangles or agreement with a larger
   atlas is not a quality score.
4. **Evaluate isolated upstream memory integration and eligible CUDA graph
   builds.** Keep these as separate interventions. Accept memory changes for
   reliable completion with tolerable latency and output agreement, and graph
   replay only for measured savings after capture overhead.
5. **Choose a continuation or runtime-reuse prototype from measured costs.**
   Prefer a narrow saved-shape/material-rerun contract if user iteration is the
   main expense. Prioritize K/V caching, residency or GPU sampling only when
   their measured share warrants the maintenance and memory cost.
6. **Evaluate approximate caching/solvers last.** Require a better quality/time
   tradeoff than fewer-step Euler, not only a faster transformer stage.

For the initial screen, a proposed set is six varied inputs with two fixed,
nonzero seeds. Use repeated timing runs only for promising candidates and
randomize comparison order. Review front/back silhouettes, missing parts,
floating geometry and materials under fixed views and lighting. Use held-out
inputs before changing defaults; report failure rate and worst cases, not only
successful-run means. These counts are a practical screening proposal, not
statistical proof of general improvement.

For intended exact changes, compare stage arrays before stochastic downstream
and postprocessing effects; final GLB byte equality is not a reliable gate while
the existing repeatability question remains unresolved. For changes intended
to improve quality, preserve per-stage noise explicitly when token layouts
change. Run resource-intensive experiments serially on an available GPU. Keep
private inputs, raw logs and generated assets in ignored research output.

No new candidate is marked adopted. This report adds directions beyond the
[material appearance conclusions](material-research-consolidated-report.md)
and leaves their prior decisions intact.
