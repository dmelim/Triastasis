# Model and runtime experiments

Research results: 2026-09-25. This records the bounded follow-up to the
[opportunity assessment](model-runtime-opportunities.md). Experiments ran
sequentially with independent review between candidates. No candidate was
integrated into the application or adopted as a production default.

## Decisions at a glance

| Candidate | Result | Decision |
| --- | --- | --- |
| Exact preparation reuse | Recomputed and cached conditioning matched exactly; measured preparation fell from about 38 seconds to about 1.7 milliseconds on cache hits. | Highest-priority integration candidate, after broader input coverage and paired full-request measurements. |
| Fixed-shape material continuation | Same-noise material replay was exact; different noise changed materials while geometry and UVs stayed identical. | Functional prototype passed; application integration and full export validation remain. |
| Eight shape steps | Sampling took 7.847 seconds versus 11.111 at twelve steps, without an obvious major regression in the inspected views of one asset. | Broader quality evaluation candidate; retain twelve as the default. |
| Sixteen shape steps | Sampling took 15.047 seconds; no clear visual improvement in this case. | No evidence supporting a default increase. |
| Streamed decoder memory implementation | Tiny real-weight comparison exceeded the predeclared numerical tolerance. | Hold adoption and investigate; larger captured-input comparison was not run. |
| CUDA graphs | Required coherent backend rebuild did not fit the resource window. | Untested, with a separate build/comparison plan. |

These decisions concern the tested paths and configuration. They do not establish
general model quality, performance across hardware, or defects throughout a
larger upstream patch.

## Scope and provenance

The real-model comparisons used one retained RGB input and an NVIDIA RTX 4070,
CUDA device 0, 512 geometry, a fixed shape seed of 42 and two backend threads.
Shape-step comparisons held ordered sparse coordinates, conditioning and initial
noise fixed. The material study used independent material seeds 142 and 143.
Inputs and generated assets are not included in this documentation.

Source analysis was based on repository commit
`f37c0ee755a731ee4887bcd7e4ee0586ddf05373`. Execution used existing CUDA research
libraries rather than a clean rebuild of that checkout. The resident server's
diagnostics reported build commit `f5c133ba4832c42825bed14637bcfadb92b2dfeb` with
a dirty-build marker. The isolated programs linked against those existing
libraries, except for the explicitly copied decoder-block implementation under
comparison. Therefore these measurements are not release benchmarks or a claim
that a clean checkout of the source-analysis commit reproduces every binary.

Local manifests preserve executable/model identities, capture dimensions, array
hashes, invocations and resource records. They remain private alongside the
research prototypes. This report preserves reusable conclusions and aggregate
measurements without publishing logs, user paths, input identities or exports.

## Baseline and exact shape replay

The corrected resident-server baseline completed three geometry-only requests:

| Measurement | Request 1 | Request 2 | Request 3 |
| --- | ---: | ---: | ---: |
| HTTP request time | 69.481 s | 68.125 s | 69.190 s |
| Preprocessing | 38.228 s | 37.185 s | 37.683 s |
| DINO conditioning | 0.165 s | 0.129 s | 0.144 s |
| Shape flow | 11.407 s | 11.376 s | 11.414 s |

The warm pair differed by about 1.6%. Preprocessing occupied roughly 55% of
request time, making repeated background removal a much more useful reuse
target than DINO alone. Stage timers are inclusive; nested timers must not be
added to their parent measurements.

The isolated shape checkpoint contained 4,314 ordered sparse coordinates,
1,029 conditioning tokens, positive/negative conditioning, exact initial shape
noise and normalized twelve-step output. Its six binary files totaled 9,585,780
bytes. An unchanged real-model replay reproduced all 552,192 output bytes
(138,048 floats) exactly, with zero maximum absolute difference. It used twenty
model forwards and 11.111 seconds of sampler time.

This validates the captured shape-flow boundary for this configuration. It does
not prove whole-export determinism: the resident requests produced equal-sized
GLBs with different hashes. Final GLB byte equality was consequently not used
as a general numerical correctness gate.

## Exact preparation reuse

The prototype cached canonical DINO conditioning directly after real BiRefNet
background removal, cutout normalization and DINO encoding. It did not save a
cutout image and reimport it through another preprocessing pass.

One immutable source was evaluated in the sequence warm recomputation, warm hit,
recomputation, hit, hit, recomputation:

| Pass | Preparation time | Model work |
| --- | ---: | --- |
| Warm recomputation | 33.9949 s | BiRefNet and DINO on CUDA0 |
| Warm hit | 1.7035 ms | Reused conditioning |
| Measured recomputation 1 | 38.0843 s | BiRefNet and DINO on CUDA0 |
| Measured hit 1 | 1.6120 ms | Reused conditioning |
| Measured hit 2 | 1.7285 ms | Reused conditioning |
| Measured recomputation 2 | 38.3619 s | BiRefNet and DINO on CUDA0 |

Every result matched the warm reference byte for byte, including both fresh
recomputations. The reference also matched conditioning captured during the
earlier full generation. Thus equality was not established merely by comparing
a cached vector with itself. Hit timings included reading source bytes, checking
the key and comparing the result.

The one-entry payload was 5,500,323 bytes, approximately 5.25 MiB. This is payload
size, not measured allocator overhead. The key covered exact source bytes,
resolved background mode, crop/implementation version, model identities,
resolution and precision/attention settings. Nine independently restored
one-field invalidation checks passed, along with the payload ceiling check.

**Limits:** this is a stage comparison on one immutable source. Concurrent file
mutation safety, broader image coverage, integrated cache lifecycle and paired
full-request speedup remain unproven. Do not describe a complete generation as
taking 1.7 milliseconds. Production integration requires a native preparation
cache capability; it is not an app-only switch already exposed by the protocol.

## Shape sampling effort

The controlled replay changed only the shape step count:

| Steps | Actual model forwards | Sampler time |
| --- | ---: | ---: |
| 8 | 14 | 7.84676 s |
| 12 | 20 | 11.1108 s |
| 16 | 27 | 15.0472 s |

Eight steps saved about 3.264 seconds in sampling; sixteen added about 3.936
seconds. These are single observations from separate launches, excluding model
loading, preprocessing, sparse-structure generation, decoding and packaging.
They are not end-to-end speedup percentages.

All three outputs were decoded using the same normalization and small-hole
policy. Four fixed Z-up views used shared framing and lighting, with every
triangle rendered rather than a randomly thinned preview. The main silhouette,
part groups and trunk structure remained similar. Small surface differences
were visible, with no clear sixteen-step improvement at 320 pixels per view.

This supports testing eight steps further. One asset, one seed and these views
cannot rule out missing thin parts, topology changes or source-fidelity losses
on other inputs. Latent distances and triangle counts were not treated as
perceptual quality scores. The twelve-step default remains unchanged.

## Streamed decoder memory screen

The candidate was the exact `sparse_convnext_streamed` function extracted from
upstream commit
[`fbd6bcc59930032f7501bd6033096759c2882659`](https://github.com/pwilkin/trellis.cpp/commit/fbd6bcc59930032f7501bd6033096759c2882659).
The saved patch SHA-256 was
`245a70f7fcec24e33f3336b014b46c24782044454afa33a6d299b746f9000712`.
Only allocation/chunk instrumentation was added to the extracted function;
the complete upstream patch was not integrated.

The existing block and streamed implementation used real shape-decoder weights
on CUDA0, with deterministic small-grid features: `blocks.3.0`, 128 channels,
513 voxels. A forced 1 MiB wide-activation budget exercised two candidate chunks.
The baseline allocation was released before the candidate ran, and both block
timers included graph construction and cleanup.

The predeclared per-element criterion was:

`abs(candidate - baseline) <= 1e-4 + 1e-4 * abs(baseline)`

| Measurement | Result |
| --- | ---: |
| Values exceeding tolerance | 128 / 65,664 |
| Maximum absolute difference | 0.292694 |
| RMSE | 0.00344861 |
| Baseline graph working allocation | 1,575,936 bytes |
| Maximum streamed graph working allocation | 1,891,328 bytes |
| Baseline / streamed block time | 69.898 / 24.479 ms |

**Correctness failed.** These first-use tiny-case timings do not establish a
speed benefit, and the small working-buffer figures do not establish useful
large-decoder memory savings. They exclude the resident model and are not total
VRAM measurements. The larger captured-input comparison was intentionally not
launched, and the tolerance was not relaxed.

The failing value indices were not saved, so 128 failures do not prove a single
bad voxel row. Tail-chunk behavior, numerical kernel differences and indexing
remain hypotheses rather than established causes. Hold adoption pending a
focused diagnosis; do not generalize this result to every upstream memory fix.

## Fixed-shape material continuation

A material checkpoint referenced the exact saved shape, ordered coordinates
and conditioning. Shape-guide decoding produced 1,416,585 PBR coordinates and
four subdivision masks. A box atlas was constructed once over the fixed mesh:
384 x 384 pixels, 2,480,382 atlas vertices and 2,916,162 faces. Every face's UVs
were validated against its common padded atlas cell.

Material flow used the source's 64-channel concatenation of noise and normalized
shape, twelve steps/forwards, guidance 1, guidance rescale 0, interval 0.6–0.9
and time rescale 3. Texture decoding used the saved guides, source normalization
constants and clamp. Geometry, UVs, indices and face groups were frozen for
rebaking. Independent material seeds 142/143 do not claim to reproduce an
earlier full pipeline's sequential RNG state.

The reference and unchanged-noise replay were byte-identical in all five saved
products: normalized material latent, raw PBR, clamped PBR, base-colour atlas
and metallic/roughness atlas. Changed noise altered all five products while
in-memory geometry/UV/group byte comparisons and pre/post checkpoint hashes
remained exact. Model/source identities were also checked before and after.

The reference measured 7.091 seconds for material flow including loading,
5.475 seconds for guided decoding and 0.511 seconds for rebaking. The sampler
itself took about 6.7 seconds. Guarded initialization plus all three material
runs consumed 62.174 process-seconds in total.

**Result:** deterministic material-only continuation and variation worked for
this input. Aesthetic improvement, full-request savings and production exports
were not established. The fixed rebake used direct voxel sampling without the
production original-mesh BVH snap or remesh/QEM stages. No new GLB export was
needed for the functional comparison. A product feature would require a new
native checkpoint/continuation capability and a narrow bridge to expose it.

## CUDA graphs: not tested

The existing backend was built with `GGML_CUDA_GRAPHS=OFF`. Enabling graphs adds
conditional fields inside the CUDA backend context. Replacing a single ON
object while retaining OFF kernel objects would mix incompatible layouts;
a coherent backend rebuild is required.

Historical local compilation records for 138 CUDA objects totaled 3,622.212
compiler-seconds. Dividing by two workers gives approximately 30.185 minutes
before configuration/linking. This is a rough feasibility estimate: prior
contention, caching and flags may differ. It did not justify a full build inside
the remaining campaign window. No graph capture, correctness or performance
claim is supported.

A later isolated build can compare the same graph-enabled binary in fresh
processes with `GGML_CUDA_DISABLE_GRAPHS` present versus absent, using the saved
shape boundary. Actual capture/launch instrumentation and unchanged-output
correctness must precede timing conclusions. Include warmup, capture and first
request costs rather than reporting only favorable steady launches. A build
flag alone does not demonstrate that any graph was captured.

## Resource accounting and harness findings

The campaign retained a cumulative ceiling of 1,200 GPU-process seconds,
including loading, warmup and failed attempts. Actual use was **625.849 seconds
(10.43 minutes)**. This is guarded workload wall time, including CPU work inside
GPU-mode jobs, not measured GPU busy time or energy consumption.

The elapsed window was extended from 45 to 90 minutes to accommodate harness
repairs; the cumulative GPU allowance was not reset or enlarged. All GPU work
finished within that window. Builds, inference and rendering ran serially.
Owned jobs used below-normal priority, four logical CPUs, two backend/build
threads, an 8 GiB private-commit limit, RAM/VRAM reserves, bounded outputs and
strict deadlines. Neural-stage children were limited to 120 seconds; full
requests to 300 seconds.

Across runtime samples, peak private commit was 5,403,983,872 bytes (5.03 GiB),
and minimum free VRAM was 7,080 MiB (6.91 GiB). Retained experiment/build output
was approximately 642 MiB. No owned native experiment processes remained at the
final audit. The GPU returned to the observed P8, 210 MHz, low-power desktop
state. One-second sampling can miss transient peaks.

The initial utilization-only launch gate rejected an otherwise low-power desktop
state. A documented alternative required three fresh samples with P8, graphics
clock at most 300 MHz, power at most 25 W, utilization below 40%, sufficient
free VRAM and an unchanged known desktop process inventory. This was not an
assumption that utilization alone proves idleness. A later P5 rejection remained
a rejection; no model launched until the unchanged gate passed on retry.

Two early native requests completed, but their clients failed on an undersized
response bound and a parser error. Their 113.114 process-seconds remained charged.
The geometry-only path produced about 2.9 million faces despite a requested
150k target: that target belongs to the textured postprocessing path. Native
completion and successful client validation must be distinguished.

A missing CUDA DLL was resolved by correcting the research launchers' local
library search paths. Subsequent real runs passed; no reinstall or global DLL
replacement was required. Loader dialogs were suppressed for guarded children.
Pre-execution review also caught a truncated normalization-constant initializer
in the new memory comparator; it was corrected and checked against source before
GPU execution. This did not affect the earlier shape-step comparison.

## What remains before adoption

1. **Preparation cache:** broaden input/invalidation coverage, define lifecycle
   and mutation behavior, and measure paired full requests before integration.
2. **Eight steps:** evaluate thin structures, holes, hard surfaces and multiple
   seeds, including failures and worst cases; retain twelve meanwhile.
3. **Material continuation:** extend to additional assets and the complete export
   path, then decide whether the native/API maintenance cost fits product scope.
4. **Memory streaming:** locate the numerical discrepancy before retrying the
   larger captured block or considering upstream adoption.
5. **CUDA graphs:** reserve a separate coherent-build window, then run a bounded
   correctness and actual-capture comparison.

Approximate caching, higher-order solvers, cross-attention projection reuse and
selective model residency remain opportunities from the original assessment,
not completed or validated experiments in this campaign.
