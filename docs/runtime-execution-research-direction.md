# Research direction: execution efficiency and chunk-dependent numerics

Recorded: 2026-09-29. Status: partial follow-up results; no adopted runtime change.
This direction follows the [September 25 experiments](model-runtime-experiments.md)
and the subsequent review of their source, evidence and interpretation.

## Discussion credit

This research direction was developed through a user-mediated discussion between
**Astra (high reasoning)** and **Opus 5.5 (medium reasoning)**. Both models are
credited for the critique, corrections and refinement of the diagnostic plan.
Model names and reasoning settings are recorded as supplied by the user.
This attribution concerns the discussion. September 29 experiment execution used
Sol (medium reasoning), sequentially, with Astra review between stages. Completed
work and outstanding tests are distinguished in the results below.

## Questions and maintenance boundary

Two questions deserve focused investigation:

1. Which parts of native BiRefNet execution account for its measured inference
   time, and can a targeted change reduce first-generation cost?
2. Does streamed sparse decoding introduce discrepancies beyond those already
   caused by the baseline's chunk partition and CUDA kernel selection?

These are native/runtime investigations, not app-only features. Keep prototypes
isolated. Profile before changing execution, and prepare any justified change
in a form suitable for upstream review and adoption. Production integration
requires a separate scope decision under the project's maintenance boundary.
The follow-up used isolated prototypes; no production implementation, upstream
submission or default change resulted.

## Verified facts from the review

### BiRefNet loading is not the dominant measured cost

The retained three-request baseline already separates these stages:

| Stage | Request 1 | Request 2 | Request 3 |
| --- | ---: | ---: | ---: |
| BiRefNet model loading | 0.394 s | 0.303 s | 0.488 s |
| BiRefNet inference | 37.691 s | 36.729 s | 37.045 s |

The inference timer includes host work, allocation, transfers and GPU execution.
It is not a GPU-kernel-only timer. The approximately 38-second preparation cost
is a measurement of this implementation/configuration, not a fixed model cost.
The original resource restrictions and runtime provenance still apply.

[BiRefNet](../src/birefnet.cpp) allocates and executes segmented graphs, reads
outputs back to host vectors, and performs operations including normalization,
activation, interpolation and concatenation on the CPU. Its custom
[deformable convolution](../src/deform_conv.cu) allocates device buffers and
uploads inputs and weights per call. These are profiling targets, not yet a
measured attribution of the bottleneck.

The custom deformable-convolution function already calls
`cudaDeviceSynchronize()`, copies its output to the host and frees buffers before
returning. Whole-function timing includes completion of its GPU work. Verify
timing boundaries rather than adding synchronization indiscriminately.

Upstream review at
[`c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f`](https://github.com/pwilkin/trellis.cpp/blob/c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f/src/birefnet.cpp)
found a multi-backend execution wrapper but retained these segmented graphs,
host readbacks and host operations. No fix removing this execution structure
was identified. External PyTorch/FP16 timings on other GPUs do not establish a
performance target for this GGML configuration.

### Resolution and cache scope

The campaign tested 512 geometry: the resolution used by Low and seed sweeps,
not a complete validation of the Low preset. Medium and High use a 1024 cascade
with an additional high-resolution shape pass. The eight-step finding cannot
be assumed to transfer to that pass. Eight versus twelve steps reduced actual
shape model calls from 20 to 14, or 30%, in the tested configuration.

The cache's 5,500,323-byte payload consists of 4,214,784 bytes of conditioning
and 1,285,539 bytes of original source-file data. This excludes key metadata,
allocator overhead and other live copies. The 1024 cascade additionally needs
4101-token conditioning: 16,797,696 bytes of F32 features. Both feature arrays
together occupy 21,012,480 bytes, approximately 20.04 MiB; this was not tested
as an integrated cache.

The pipeline already creates one canonical cutout and normalizes it for both
resolutions. Separate matte/cutout reuse could avoid matting again when moving
from a sweep to 1024; dependency keys and lifecycle still need validation.
Store canonical arrays rather than reimporting an exported cutout through the
preprocessing pipeline.

A strong content hash plus size is a possible production key, replacing stored
source bytes with negligible collision risk rather than literal byte equality.
Hash the bytes actually consumed and preserve all model/settings/version
dependencies. Seeds reuse one entry for the same image and preparation settings;
sweeps do not inherently add a cache entry per seed. No production cache design
has been selected.

### Streamed-block failure and kernel-selection hypothesis

The extracted streamed function failed the original criterion on 128 of 65,664
values, with maximum absolute difference 0.292694. This remains a failed
comparison in our harness, not a demonstrated upstream defect. The September 25
run did not retain failure indices; the [September 29 follow-up](#september-29-results)
subsequently established their location and tested matched partitions.

The 1 MiB activation budget with 128 channels yields chunks of 512 and 1 voxel
for the 513-voxel input. This originally suggested all 128 channels of the tail
voxel as the discrepancy's location. The baseline already supports chunking through
`TRELLIS_BLOCK_CHUNK_MB`; the candidate uses `TRELLIS_CONVNEXT_CHUNK_MB`.

The function text in patch
[`fbd6bcc59930032f7501bd6033096759c2882659`](https://github.com/pwilkin/trellis.cpp/blob/fbd6bcc59930032f7501bd6033096759c2882659/src/sparse.cpp)
and merge
[`99ae104b1f955cb0e4999f643ffebb58492cf536`](https://github.com/pwilkin/trellis.cpp/blob/99ae104b1f955cb0e4999f643ffebb58492cf536/src/sparse.cpp)
was byte-identical. It was also unchanged in the inspected upstream `c0bed38`.
This establishes function identity, not equivalence of complete builds or
surrounding integration.

The tested model file's block has F16 convolution weights and Q4_0 MLP weights.
Pinned GGML `737e88f25d4f62254f3b7a726fd9663036cc94da` defines
`MMVQ_MAX_BATCH_SIZE` as 8. Its CUDA quantized vector path can serve up to eight
rows; the matrix path also quantizes activations. F16 operations have separate
dispatch rules. Source inspection supports a kernel-selection hypothesis, but
does not prove the kernels used by the earlier research binaries or explain
the measured error. Avoiding only one-row tails is not a validated fix.

A CPU-only reconstruction of the host remapping rules preserved neighbors and
output coverage for 512/513/514 voxels with whole and 512-row chunks. It did not
execute the C++ comparator, validate CUDA numerics or establish the failure's
cause. Successful upstream generations likewise do not settle this numerical
comparison.

## September 29 results

The bounded follow-up completed S1 repeatability/reproduction, the S2
matched-partition B/C comparison, an S6 dequantized-weight F64 CPU reference,
and a read-only review of retained decoder stage counts. D (candidate as one
chunk), S3 (tail-size sweep), S4 (intermediate comparisons) and B1 (BiRefNet
timing) did not run. The BiRefNet instrumentation prototype built, but its
matte-equivalence gate remains untested.

### Synthetic block comparison

The case remained `blocks.3.0`, N=513, C=128, with the same real shape-decoder
model, full neighbor table and deterministic input as the earlier screen.
A used the baseline's 1,500 MiB budget (one chunk); B used baseline 1 MiB
(512+1); C used candidate 1 MiB (512+1).

| Check | Result |
| --- | --- |
| S1 repeatability | Five outputs per implementation across three processes were bitwise identical within each implementation. |
| Original A/C failure reproduced | Exactly 128 of 65,664 values failed the unchanged tolerance, all 128 channels of row 512; maximum absolute difference 0.2926939055. |
| S2 matched partitions | B and C were bitwise identical throughout. |
| Ordinary rows | A and B were bitwise identical on rows 0–511 despite the 513-versus-512 batch sizes. |

The baseline's own partition reproduces the entire candidate discrepancy in
this fixture. The candidate adds no discrepancy at the matched partition;
this is not a candidate-specific defect demonstrated by the original screen.
Ordinary-row equality establishes no observable final-output batch-size effect
there, but does not establish whether stream-k ran.

The CPU reference used the same dequantized tensors and saved inputs, F64
arithmetic, LayerNorm epsilon 1e-6, SiLU and the residual. Analytic and Q4_0
unpacking controls passed. Per-row relative L2 error divides error norm by that
row's F64 reference norm; no reference row had zero norm.

| Output vs F64 | Ordinary-row relative error median / p99 / maximum | Tail relative error | Tail absolute RMS error |
| --- | --- | ---: | ---: |
| A, one chunk | 1.2301% / 1.6766% / 1.8018% | 1.5624% | 0.0224101 |
| B/C, split 512+1 | Same ordinary rows | 5.2129% | 0.0747724 |

Ordinary rows' pooled absolute RMS error was 0.0220398. A's tail was within
the ordinary distribution; 22 ordinary rows had at least its relative error.
B/C's tail exceeded every ordinary row, at **2.89 times the ordinary maximum**.
Tail reference norm was 16.2281 versus ordinary median 19.9055, so this was not
a near-zero denominator artifact.

The original GPU-to-GPU tolerance remains unchanged. Applying it against F64
rejects 65,070 values for either output, but that does not invalidate an
accuracy reference with different arithmetic. Relevant quantized CUDA paths
use Q8_1 activations; the full measured error floor has not been isolated to
that rounding. The reference comparison establishes the split-tail anomaly
for this fixture, not its kernel cause or downstream significance.

### Retained stage counts and adoption scope

One retained material-512 capture supplied all four block-stage input counts.
The source-derived default layouts are:

| Stage | N | C | Baseline 1,500 MiB | Candidate 256 MiB, 65,536-row cap |
| --- | ---: | ---: | --- | --- |
| 0 | 6,715 | 1,024 | One chunk | One chunk |
| 1 | 29,618 | 512 | One chunk | One chunk |
| 2 | 123,764 | 256 | One chunk | 65,536 + 58,228 |
| 3 | 511,234 | 128 | One chunk | 7 × 65,536 + 52,482 |

No short tail of eight rows or fewer is predicted for this capture. The
candidate nevertheless changes partitioning at the two larger stages; equality
for the tiny 512/513-row comparison does not establish equality at these sizes.
These layouts are predictions from retained counts, not newly measured GPU
results. Geometry-512 and geometry/material-1024 coverage was partial: no
complete intermediate geometry-stage or material-1024 sequence was established.
Production short-tail frequency remains unknown.

### Provenance, resources and limits

The comparator reused the September 25 research libraries and model; recorded
source, binary, library and model identities were checked. It did not rebuild
GGML or integrate the upstream patch. The pinned GGML revision remains
`737e88f25d4f62254f3b7a726fd9663036cc94da`; the earlier research-build provenance
limitations still apply. Model loading took 0.673–0.863 seconds in S1.

Four GPU-process launches charged **6.194 seconds (about 6.2 seconds)** against
the fresh 1,000-second follow-up ceiling. This is elapsed process time including
host work and loading, not kernel-active GPU time. Work ran sequentially with
thread/CPU limits, memory reserves, readiness checks and deadlines. B1 and D
were blocked before launch by desktop activity; no owned processes remained.
CPU-only reference and retained-log analysis added no GPU charge.

This is one synthetic block with real weights, not a full decoder validation.
There was no trace of actual kernel dispatch, no accepted speed/memory benefit,
and no production adoption. Raw evidence remains private; the aggregate results
above support [F10](findings.md).

## Diagnostic sequence and remaining work

The original sequence below explains the controls; completed portions are
identified in [September 29 results](#september-29-results). Next comes D, then
S3, with a separately gated large-partition comparison considered afterward.
BiRefNet timing waits for an idle window with its historical CPU configuration.

### Streamed decoder: explain the discrepancy before expanding

1. Preserve source/build/model identities and repeat the unchanged baseline.
   Measure within-process and fresh-process repeatability before interpreting
   differences. Exact shape replay does not prove this block is deterministic.
2. Save output arrays and failing voxel/channel indices. Report absolute error,
   affected-row magnitude and normalized row error with an explicit denominator;
   relative error near zero must not be the only metric.
3. Compare baseline with one full chunk, baseline with the candidate's partition,
   and candidate with that same partition. For this tiny case, setting both
   chunk budgets to 1 MiB gives 512+1 while retaining the original neighbors.
   Compare candidate-versus-matched-baseline error with the baseline's own
   partition-dependent error. Agreement is evidence, not proof of general safety.
4. Cover 512/513/514 voxels and tails around the eight-row boundary, including
   8 and 9 rows. Do not remove neighboring input voxels to create a single-output
   control; retain the full input/neighborhood and select the output range.
5. Inspect the first divergent intermediate and actual F16/Q4 kernel dispatch.
   Use lightweight instrumentation where practical; reserve a bounded Nsight
   Systems trace for unresolved dispatch questions. Keep traces out of timing
   comparisons and private evidence out of Git.
6. Compare against a controlled reference dequantizing the same tested tensors.
   The existing F32 convolution switch does not also convert MLP weights.
   Control arithmetic precision so the reference does not silently select a
   lower-precision path. Preserve the original tolerance failure; report this
   new reference comparison separately rather than changing the old criterion.
7. Only after explanation and correction, evaluate the larger captured block
   and full decoder output, memory, latency and visual consequences. A plausible
   kernel explanation alone neither proves negligible impact nor accepts the
   patch; differences can propagate through later blocks.

### BiRefNet: coarse timing before implementation

Measure total inference and three exclusive buckets: accumulated `run_graph`
time/count, host operations, and whole `deform_conv2d_run` time/count. Preserve
an unaccounted remainder for construction outside the graph runner, bookkeeping,
copies and other host loops. Avoid nested double-counting. Verify completion
boundaries; the custom deformable-convolution function already synchronizes.

Use these measurements to select one targeted optimization. Preserve bounded
memory and numerical/visual checks; do not assume a single monolithic graph is
the appropriate solution. Check upstream again before implementation and record
the revision reviewed. Favor an upstream-compatible change with a small diff.

Use the historical two backend threads, below-normal priority and four logical
CPUs, without an aggregate CPU hard cap, in an idle window. A one-core/10% cap
can distort host-versus-GPU bucket shares and should not select the optimization
target. Retain readiness, memory, thermal, cleanup and elapsed-budget safeguards.

## Resource and decision rules

The initial review covered discussion, source inspection and a CPU indexing
check; subsequent GPU and CPU work is recorded in [September 29 results](#september-29-results).
The follow-up established its own 1,000-second ceiling, separate from September
25; keep its 6.194-second charge cumulative across sessions. Before further
execution, establish a fresh elapsed window and verify GPU availability.
Run one job at a time with deadlines, RAM/VRAM reserves,
limited threads and capped output. Charge failed attempts and profiling runs.
Stop at failed controls rather than expanding the workload.

Exact preparation caching remains a complementary candidate for repeated inputs.
BiRefNet execution work targets first requests as well. Neither replaces broader
1024 coverage, full decoder validation or a native-maintenance scope decision.
