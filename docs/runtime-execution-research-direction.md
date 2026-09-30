# Research direction: execution efficiency and chunk-dependent numerics

Recorded: 2026-09-29; updated 2026-09-30. Status: validated local interpolation
change; streaming adoption remains on hold. No packaged runtime update.
This direction follows the [September 25 experiments](model-runtime-experiments.md)
and the subsequent review of their source, evidence and interpretation.

## Discussion credit

This research direction was developed through a user-mediated discussion between
**Astra (high reasoning)** and **Opus 5.5 (medium reasoning)**. Both models are
credited for the critique, corrections and refinement of the diagnostic plan.
Model names and reasoning settings are recorded as supplied by the user.
This attribution concerns the discussion. September 29–30 experiment execution used
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
The initial follow-up used isolated prototypes. On September 30 the user approved
the small native interpolation change recorded below. It is locally validated;
no packaged runtime, upstream submission or generation-default change resulted.

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

The first session of the bounded follow-up completed S1 repeatability/reproduction, the S2
matched-partition B/C comparison, an S6 dequantized-weight F64 CPU reference,
and a read-only review of retained decoder stage counts. D (candidate as one
chunk), S3 (tail-size sweep), S4 (intermediate comparisons) and B1 (BiRefNet
timing) had not run at that point. Subsequent D, S3, large-partition and BiRefNet
results are recorded in the second-session sections below.

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

## Second-session partition results

Sequential follow-up completed the one-chunk candidate control (D), the tail
sweep (S3), and a larger synthetic block comparison. D matched the frozen
one-chunk baseline bitwise in both repetitions.

For each tested tail, baseline and candidate with the **same partition** matched
bitwise. Comparing a single baseline chunk against a 512-row candidate chunk
plus a tail gave:

| Tail rows | Values outside the original tolerance | Result |
| --- | --- | --- |
| 0 | 0 | Bitwise equal |
| 1 | 128 | Only tail rows differ |
| 2 | 255 | Only tail rows differ |
| 7 | 891 | Only tail rows differ |
| 8 | 1,019 | Only tail rows differ |
| 9 | 1,085 | Only tail rows differ |
| 16 | 2,016 | Only tail rows differ |
| 32, 64, 128, 256 | 0 | Bitwise equal |

Tail 32 was added after observing the initial sweep; tail 1 reused the verified
earlier evidence. The first 512 rows matched bitwise throughout. The discrepancy
therefore extends beyond eight rows in this fixture. These observations do not
establish an exact dispatch boundary, behavior at untested tail sizes, or which
kernels actually ran.

### Large partitions

A separately checked 80-cubed synthetic coordinate layout retained all input
neighbors, C=128 and the same real shape-block weights. Pilot comparisons at
N=65,537 and N=131,073 matched bitwise except for the final single-row tail.
At N=65,537, a selected-row F64 reference gave tail relative L2 errors of 1.46%
for the one-chunk baseline and 3.52% for the split candidate; seven sampled
ordinary rows were identical across implementations. This is a selected-row
reference, not an all-row accuracy distribution.

At **N=511,234**, the baseline's one chunk and candidate's
**7 x 65,536 + 52,482** layout produced bitwise-identical complete outputs in
both repetitions. Baseline graph allocation was 1,570,510,848 bytes versus
248,595,968 bytes for the candidate's peak chunk allocation, about 84% lower.
These are graph allocator capacities, not whole-device peak memory. The candidate
was slower in this restricted-CPU screen (632–670 ms versus 380–432 ms); two
ordered repetitions do not establish production latency.

This matches the retained material-stage **size**, using a synthetic spatial
layout and shape-decoder weights. It is not a material decoder or full geometry
decoder validation. The larger split passed its numerical gate; production
adoption still requires broader decoder checks.

## Full 512-resolution decoder comparison

The successful synthetic block did **not** carry over to a saved full shape
decoder case. The native baseline produced 1,416,585 final voxels; the isolated
streamed candidate produced 1,416,520. The first two subdivision masks matched
exactly, but the third differed. Stage inputs were:

| Stage | Channels | Baseline input voxels | Candidate input voxels |
| --- | --- | --- | --- |
| 0 | 1,024 | 4,314 | 4,314 |
| 1 | 512 | 19,644 | 19,644 |
| 2 | 256 | 83,274 | 83,274 |
| 3 | 128 | 339,093 | 339,080 |

The candidate splits stage 2 into 65,536 + 17,738 rows. Stage 3 also uses large
chunks and a substantial tail. Thus the observed full-decoder difference cannot
be dismissed as the previously tested single-row-tail case. Exact early masks
do not prove early features were identical; the first divergent operation has
not been isolated. The candidate changed only ConvNeXt execution, preserving
subdivision and final-head code. Input normalization was checked against the
validated replay source before execution.

The third subdivision mask differed in 139 bits: three before row 65,536 and
136 after it. Final coordinate sets shared 1,415,560 voxels, with 1,025
baseline-only and 960 candidate-only coordinates. Among shared coordinates,
346,617 seven-channel feature rows changed; 2,395,915 of 9,908,920 scalar values
exceeded the original tolerance. Maximum absolute difference was about 77.50,
with RMS difference about 0.4903. These are raw decoder values, not a rendered
visual-quality metric.

The full-decoder numerical gate failed. The net difference of 65 voxels therefore
understates the changed coordinate set and does not establish negligible visual
impact. Adoption remains on hold despite the successful C=128 synthetic block.
This comparison does not distinguish an implementation defect from the baseline's
own response to these larger partitions; a matched-partition control on real
stage features is still needed. The earlier matched-block equality remains
valid within its tested scope. No 1024 or material decoder run was added.

One fresh repeat of each implementation was run solely as a repeatability
control after the failure. Coordinates, all four masks and all feature values
were bitwise-identical within each implementation, reproducing the discrepancy.
Restricted-CPU decode times were 5.396/5.490 seconds for the baseline and
8.055/8.143 seconds for the candidate. These are small-sample research timings;
neither a full-decoder speed improvement nor a full-decoder memory benefit was
established. The single-block allocation saving must not be extrapolated to
the whole decoder.

## BiRefNet profiling results

The isolated profiler used the historical configuration: two backend threads,
four logical CPUs, below-normal priority and no aggregate CPU hard cap. It
reused the existing research libraries. One timing-off reference, one timing-on
warmup and three measured passes produced bitwise-identical finite mattes.

The measured inference wall times were **36.499, 36.869 and 35.769 seconds**.
Their range was 3.02% of the mean, within the predeclared 5% stability gate.
Mean exclusive internal buckets were:

| Bucket | Mean seconds | Share of internal total |
| --- | --- | --- |
| CPU interpolation (12 calls) | 30.045 | 82.69% |
| Graph runner (142 calls) | 2.936 | 8.08% |
| Whole deformable-convolution calls (20) | 0.917 | 2.52% |
| Other named host operations | 0.316 | 0.87% |
| Unaccounted remainder | 2.119 | 5.83% |

Rounding accounts for small differences in the sum. The remainder passed the
10% coverage gate. The graph bucket includes setup, allocation, upload, compute,
readback and free; its compute component alone averaged about 0.538 seconds.
The deform bucket includes the existing device synchronization, transfers and
allocation/free. Inclusive backbone/decoder subtotals are not added again.
Internal total excludes some final destruction overhead; measured wall time
averaged about 0.046 seconds more.

CPU interpolation is the strongest first optimization target in this fixture.
Its channel-major data is traversed with channel as the innermost loop;
improving locality is a source-based hypothesis to test, not a measured fix.
This supports a focused upstream-compatible prototype before a network rewrite.

The timing-off reference took 17.152 seconds and warmup 22.098 seconds. Their
large difference from the measured runs remains unexplained. Output parity
does not establish zero instrumentation overhead, and no optimization or
first-request speedup was tested.

A separate fresh timing-on process produced the same matte and normalized input,
with the same operation counts. Its inference took 33.787 seconds: interpolation
27.552 seconds, graph runner 2.747, deformable convolution 0.940 and remainder 2.158
(6.40%). This reinforces the dominant bucket while showing process-to-process
variation; it does not explain the earlier fast reference/warmup passes.

## September 30 interpolation comparison

The user approved a small native interpolation change after isolated validation.
A live upstream check still resolved to `c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f`;
its interpolation function matched the local original. The candidate traverses
CHW data channel first and precomputes source indices and double fractions. It
preserves the original four-term double expression and adds no threads.

The mechanically extracted original and candidate matched bitwise in fourteen
edge/production-shape CPU cases and a 192-channel, 256-to-1024 resize containing
201,326,592 output values. Some small resizes were slightly slower; the large
fixture improved from 3.897 to 0.449 seconds under the capped CPU configuration.
Those isolated timings are not network latency.

A same-binary, same-model comparison used the historical four logical CPUs,
two backend threads, below-normal priority and no Job CPU rate cap. After one
warmup per variant, measured passes alternated A/B/B/A/A/B with 15-second pauses.
All eight full mattes matched each other and the previous reference bitwise on
the tested MSVC/CUDA build;
graph/deform/interpolation call counts stayed at 142/20/12.

| Measured inference | Original | Candidate |
| --- | --- | --- |
| Three wall times (seconds) | 39.362, 39.301, 39.739 | 7.281, 6.932, 6.783 |
| Mean wall time (seconds) | 39.467 | 6.999 |
| Mean interpolation time (seconds) | 32.694 | 0.665 |

This is about **5.64 times faster**, or an **82.3% reduction**, for the measured
inference passes on one input. Original/candidate warmups took 16.922/7.347 seconds;
the unusually faster original warmup remains unexplained. These are not complete
generation timings, a cold-start guarantee, or validation across other compilers,
devices and inputs. The candidate measured range is about 7.1% of its mean;
the paired comparison shows a large benefit without claiming identical run times.
Preparation caching remains useful for reuse, but this execution improvement is
the immediate priority because it also benefits uncached inference.

The CPU implementation is shared by the backends, but neither the absolute time
saved nor the overall speedup has been measured on other runtime configurations.
Bitwise equality is established on this MSVC build, not guaranteed for every
compiler. Full-request latency and preparation-cache savings after this change
remain unmeasured; the seven-second inference result is not a measured cache
saving or a guaranteed lower bound. Release-facing claims require full-request
evidence, and distribution belongs in new runtime archives for the next alpha,
with backend validation under the clean-Windows acceptance gate.

The paired process charged 270.143 seconds, including loading and pauses, bringing
the cumulative ledger to 594.408/1,000 before subsequent validation. It exited
cleanly with no owned survivor. Sampled private commit peaked at 5.374 GB and free
VRAM stayed above 8,691 MiB. Whole-machine CPU averaged 24.20%, with a 71.9% peak
and 25 of 271 samples above 40%. The guard's five-consecutive-sample stop did not
trigger. Thus the preferred 20% target and 40% ceiling were not strict whole-system
bounds; these readings include other applications and do not isolate owned CPU.
Earlier CPU/GPU readiness failures launched no model and charged no GPU time.

The tested function was then applied to `src/birefnet.cpp`. An isolated executable
compiled that actual translation unit, without profiling hooks, against the
unchanged existing libraries. Its fresh full matte again matched the reference
bitwise: inference 6.535 seconds and model loading 0.400 seconds. This is a single
verification pass, not another paired benchmark. The process charged 8.049 seconds,
bringing the ledger to 602.457 before the streaming control; it left no survivor.
Its nine CPU samples averaged 22.67% and peaked at 37.5%. The source change is
locally validated, with no installed binary or packaged application replaced.

## September 30 native partition control

The native decoder was run on the retained full 512 fixture with
`TRELLIS_BLOCK_CHUNK_MB=256`, preserving the model, input, normalization and
other controls. Through stages 0–2 this gives the candidate's chunk capacities:
16,384 rows at C=1024, 32,768 at C=512 and 65,536 at C=256. At stage 3 the
native C=128 capacity remains 131,072, versus the candidate's 65,536 cap;
this is not a claim of identical partitions throughout the decoder.

The native 256 MiB result matched the prior streamed candidate bitwise in all
six saved arrays: final coordinates, seven-channel features and four subdivision
masks. Both had 1,416,520 final voxels, compared with 1,416,585 for the default
1,500 MiB baseline. Stage 2 reproduced exactly the same 139 mask-bit differences
from the default (three before row 65,536 and 136 after), producing 339,080
active children versus 339,093. This is stronger than matching the counts alone.
A fresh native process reproduced all six arrays exactly again. The two native
decode times were 5.096 and 5.211 seconds under the one-core/10% Job cap; these
are diagnostic timings, not an uncapped decoder performance comparison.

The baseline's own budget change therefore reproduces the full observed
discrepancy for this fixture; the streamed candidate adds no difference in the
saved outputs relative to that control. The original failure against the default
baseline remains on record. This does not identify the first divergent operation,
prove actual CUDA dispatch, establish visual harmlessness or justify relaxing the
original tolerance. Streaming is parked: no native streaming patch was adopted.
Broader memory/quality validation should follow a demonstrated product need.
Bit-exact comparison remains a diagnostic. Any future quality-and-memory
acceptance criteria must be defined before new runs, with baseline partition
variation considered explicitly; they must not replace a failed criterion after
the fact.

The September 30 session completed four GPU processes, charging 292.304 seconds
and bringing the cumulative total to **616.569/1,000 seconds**. Every ledger entry
was finalized and every guard recorded no owned survivor. New local evidence
used about 172 MB, with 5.65 MB of build output, within the separate 512 MiB/2 GiB
ceilings. Across 296 process-window CPU samples the whole-machine mean was 23.95%
and peak 71.9%; all 25 samples above 40% occurred in the paired BiRefNet run.
Final native verification and both decoder controls stayed below 40% in their
samples. The whole-system resource caveat above remains; no strict 40% guarantee
is inferred from these guards. Model/runtime libraries remained unchanged.

## Diagnostic sequence and remaining work

The original sequence below explains the controls. D, S3, the large synthetic
partition check, full 512 decoder comparison and BiRefNet profiling are now
complete. The full decoder failed its numerical gate against the default budget;
the September 30 control subsequently reproduced its output in the native baseline
at 256 MiB. Streaming is parked rather than expanding validation now.
Actual kernel tracing remains unperformed. The subsequent BiRefNet interpolation
change passed isolated and full-matte checks as recorded above; broader input and
packaged-runtime validation remain before shipping.

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

Across the first two sessions, 35 GPU-process launches charged **324.265 of 1,000
seconds**, including model loading, host work and in-process pauses. This is
process-wall accounting, not kernel-active GPU time. The second session stayed
within its two-hour elapsed window. Jobs ran sequentially; no owned process
remained after the final repeats. About 2.015 GB of local research evidence
remained below the 2 GiB cap. No production source or runtime dependency changed
during those first two sessions; the September 30 native edit is recorded above.

Across 347 sampled readings during second-session model processes, whole-machine
CPU averaged 13.46%. One initial D-control sample reached 48%, followed by 26.8%
and 9.2%; this exceeded the preferred 40% ceiling briefly despite that job's
queried 10% cap. Whole-machine readings include other activity, and the guard's
sustained-load stop did not trigger. BiRefNet's combined run peaked at 28.6%.
These are sampled process-window observations, not continuous session-wide CPU
measurements or a guarantee of a strict whole-system ceiling.

The N=131,073 pilot completed successfully but exceeded an incorrectly sized
per-launch output limit. All expected arrays were complete and independently
checked before its result was retained with this qualification; its process
time remained charged. The campaign-wide output ceiling was not exceeded.
Subsequent launch limits were sized from expected array bytes.

The initial review covered discussion, source inspection and a CPU indexing
check; subsequent GPU and CPU work is recorded in [September 29 results](#september-29-results).
The follow-up established its own 1,000-second ceiling, separate from September
25; keep all charges cumulative across sessions, including the initial 6.194
seconds. Before further execution, establish a fresh elapsed window and verify
GPU availability.
Run one job at a time with deadlines, RAM/VRAM reserves,
limited threads and capped output. Charge failed attempts and profiling runs.
Stop at failed controls rather than expanding the workload.

Exact preparation caching remains a complementary candidate for repeated inputs.
BiRefNet execution work targets first requests as well. Neither replaces broader
1024 coverage, full decoder validation or a native-maintenance scope decision.
