# Runtime and appearance research backlog

Start here when looking for the next research task. This is a list of testable
questions, not a promise of features or a list of confirmed upstream defects.
Record useful outcomes in the [findings index](findings.md), with a short
reference to the detailed report and an explicit adoption status.
See [the pipeline and upstream research](trellis-material-research.md) and
[diagnostic collection](material-diagnostics.md) for context.

Keep private images, asset names, record IDs, absolute user paths, raw logs and
generated outputs in ignored research output. Record reusable conclusions and
synthetic validation in project documentation. Each experiment should preserve
its input hashes, runtime build, exact settings, comparison invariants and limits.

## Current focus

Priority update (2026-09-25): the bounded
[model/runtime campaign](model-runtime-experiments.md) is complete. Preparation
reuse is the strongest
candidate; material-only continuation passed a functional proof. Eight shape
steps needs broader quality coverage. The streamed decoder block failed its
numerical gate, and CUDA graphs remain untested pending a coherent build.
No production defaults changed. The September 13 material-decoder deferral below
remains in effect; its selected-follow-up wording describes that earlier phase.

Priority update (2026-09-13): the decoder investigation is parked with its
findings preserved. Full-pipeline Q4 versus mixed Q4/Q8 time/memory testing,
including target resolutions and smaller GPUs, is deferred to final evaluation.
The user prefers exploring other potential pipeline improvements first. No new
experiment is selected yet; R01 and R03–R11 remain available for prioritization.
The R02 account below records completed work and does not schedule its next run.

**R02 — isolate the material striping** is the only selected follow-up. The first
spatial tracing step is complete: direct and projected material samples were
measured across visible bands on one existing fixed mesh, with the same UVs and
lossless textures. Production sampling defaults remain unchanged.

The 384,086 nearest-surface samples across four orthographic views reproduced
bands before atlas baking. Median populated trilinear weight was 0.270 at final
surface points versus 0.942 after projection to the original surface. Median
projection distance was 1.004 voxels, with a maximum of 1.752; every projected
lookup succeeded within the existing eight-voxel limit. Increasing that limit
cannot improve these measured queries. About 9.6% of direct lookups failed and
used projection; many others succeeded with partial support.

Project-first sampling reduced adjacent colour variation in three inspected
profiles, but residual variation remained before baking. Brightness was not
strongly correlated with support by a simple linear measure; transitions
between direct/projected fallback routes were not the only locations affected.
These observations implicate the surface-to-volume sampling stage, without
isolating a decoder defect or proving that every remaining variation is unwanted.
The measurements are screen-sampled and local, not area-weighted quality scores.

The subsequent corner-level trace is also complete. A fixed interior line was
sampled at 16 subpixel intervals per pixel (609 queries); all direct/projected
values and support sums matched an independent reconstruction from saved voxel
colours to below 1e-8 on the normalized scale. Within one residual band, bright
and dark points had 98.6% and 99.8% support. A single brighter voxel supplied
92.7% of the bright point's normalized weight. The contrast therefore exists in
the saved field even with nearly complete support; missing corners alone do not
explain this residual. No large projection jump appeared along this sampled path.
The source shows irregular material detail without an obvious matching regular
band pattern; this is qualitative inspection, not a registered pixel comparison.

The decoder/layout trace is complete. A capture run reproduced all 2,174,058
saved material coordinates and six-channel values exactly. Independently
reconstructed subdivision order matched all four stages of the pinned reference
convention; final coordinate pairing and scale/clamp/storage matched exactly.
The model configuration has zero final-stage residual blocks, consistent with
the native decoder; no missing stage or channel-order error was found in these checks.

The installed material decoder uses Q4_0 weights in 66 tensors, including its
final output layer. Recomputing the selected final head with higher-precision
accumulation but the SAME dequantized Q4 weights/features left local band contrast
essentially unchanged (0.07370 versus 0.07401). This is not a comparison against
original full-precision weights or a full reference-decoder parity test. A
backend-aware head calculation approached native output within 0.000248 on the
scaled channel range; numerical parity is approximate, not bit-exact.

The decoder-only precision comparison is now complete. The Q4 and Q8 files
match the pinned model catalog; all 66 quantized tensors reproduce exactly from
the same release's F16 weights, and the other 218 tensors are bit-identical.
Two Q4 replays reproduced the original raw output exactly. All replay inputs,
subdivision masks and stage coordinates remained identical across Q4/Q8/F16.

At the previously selected bright/dark pair, code-value luma contrast fell from
0.07370 with Q4 to 0.03008 with Q8 and 0.02586 with F16 (59% and 65% reductions).
Fixed projected surface maps across all four views showed weaker regular
striping with Q8/F16, with some residual pattern. Q8 closely followed F16:
RGB MAE averaged 0.00176 across the 384,086 fixed surface samples, versus
0.05191 for Q4. These are screen-sampled differences, not perceptual or
surface-area-weighted quality scores. The Q4 material decoder configuration is
therefore a demonstrated contributor on this input. Weight rounding and backend
quantized arithmetic change together; their individual effects are not isolated.

The fixed-atlas export/PBR check is also complete. A research-only box rebake
reproduced the previous Q4 geometry, normals, UVs, indices and both decoded
textures exactly. Q4/Q8/F16 exports retained the same 139,964 triangles and
1024-square atlas; decoded PNGs matched baked arrays. At the same saved UV pair,
baked base-colour contrast was 0.04846 / 0.01618 / 0.01338 (Q4/Q8/F16), a 66.6%
and 72.4% reduction. Fixed-light PBR and unlit inspection across all four views
showed that the weaker striping survives export. Some softness and residual
variation remain. Surface-area-weighted RGB MAE versus F16 was about 0.05115
for Q4 and 0.00153 for Q8. These measure agreement with F16, not ground truth.

The production-default sampling check is now complete too. With direct-then-
project sampling, baked contrast at the same UV pair was 0.03190 / 0.01348 /
0.01038 for Q4/Q8/F16, reductions of 57.7% and 67.4%. The Q4 control exactly
matched the earlier default-sampling export. Geometry, raw decoder volumes,
executable, encoding and renderer settings matched the project-first study.
Four-view PBR/unlit inspection confirmed weaker striping with Q8/F16. The
benefit therefore does not require project-first sampling on this asset.
All precisions used the same 404,822 direct, 68,607 projected and two shell
sample attempts, with zero missing attempts. These counts include overdraw.

Q8 remains close to F16 with either sampler; some residual variation remains.
One selected bright/dark pair cannot rank sampling methods: the broader profile
and rendered views must also be considered. The second-asset comparison is now
complete, using production sampling and a fixed mesh/atlas within that asset. Broader
asset validation and memory/performance measurements are needed before a
default change. This is not a confirmed upstream defect or evidence that every
remaining stripe has the same cause. See the [precision study](decoder-precision-study.md).

A requested resource-cost check is complete for the saved 512 decoder input.
A Q4 bundle with only its material decoder upgraded to Q8 adds 35.9 MB of model
payload (0.55%). Nine rotated-order decoder replays found similar resident RAM
and overlapping decode times (Q4/Q8 medians 8.314/8.421 seconds). Whole-device
GPU polling showed a modest increase, but background usage prevents an exact
allocation estimate. This does not certify an unchanged minimum GPU/RAM tier:
full-pipeline peaks, 1024 behavior and smaller target GPUs remain untested.
No bundle or hardware recommendation changed. Details are in the precision study;
the second-asset results are recorded below.

The second asset reproduced its previous material volume exactly. Q4 replay
also reproduced the capture's raw decoder output and decoded textures. Across
Q4/Q8/F16, inputs, stage coordinates, geometry, UVs, PNG encoding and lighting
matched. Area-weighted RGB MAE versus F16 was 0.04750 for Q4 and 0.00184 for Q8.
Four-view PBR/unlit inspection showed Q4's purple tint on metal caps largely
absent with Q8/F16; Q8 closely resembled F16. Wood colour also shifted toward
green and some line contrast weakened. The source contains intentional grain,
so this is not proof that all reduced variation is an improvement or that source
fidelity improved overall. No second-asset stripe-reduction percentage is claimed.
This supports Q8 as a candidate across two inputs, without changing defaults.
Deferred to final evaluation: validate full-pipeline time/memory at the intended
resolutions and smaller target GPU/backend before making a bundle or
minimum-requirement decision. This is not the next prioritized experiment.

**Deferred:** further codec experiments (R01), safeguard experiments (R03),
runtime/overhead work (R04), and unresolved items among R05–R11 below. Their evidence and proposed
experiments are preserved here for later; they are not running in parallel.

## Completed first experiments

| ID | Question and evidence | Controlled experiment | Completion criterion |
| --- | --- | --- | --- |
| R01 — Material encoding | Lossy compression changes independent metallic/roughness values; mean base brightness does not describe those errors. | Write PNG and WebP from the **same baked arrays**. Check geometry, normals, UVs and decoded PNG identity. Measure area-weighted surface error and compare identical cameras/lighting. | Quantify codec-only loss separately from visible effect; record size tradeoff before changing defaults. |
| R02 — UV and surface sampling | Striping persists in unlit renders. Successful voxel sampling does not establish that the correct material layer was sampled. | Reuse one decoded volume and final mesh; compare box/xatlas UVs and default/project-first sampling, initially with PNG. | Verify surface identity, report any UV face loss, inspect all views and distinguish UV changes from sampling changes. |
| R03 — Guidance safeguards | Existing ratio clamps activate during ordinary-looking inputs. Finite output alone does not tell us how much they changed the trajectory. | Log raw/applied ratios, whether rescaling was evaluated, and the correction reason. Keep safeguards enabled. | Explain which bounds trigger and at which stages; no claim of visual causation without a later controlled test. |
| R04 — Runtime cost and measurement overhead | Preprocessing is a large stage; mesh preparation has gaps between named timers. Diagnostics and dump I/O also cost time. | Split preprocessing and mesh preparation timers. Repeat the exact same asset with diagnostics off/on in balanced order, without optional large dumps. | Check output identity and record repetitions/variance; do not infer a speed regression from one run. |

The user authorized R01–R04 on 2026-09-12. Their first controlled experiments
are complete on the material-diagnostics research branch. These results support
further isolation, not a change to production defaults or a confirmed upstream defect.

| ID | Result and limits | Next decision or experiment |
| --- | --- | --- |
| R01 | Geometry, normals and UVs were identical; decoded PNG matched the exact baked arrays. Surface-weighted metallic MAE was 0.05850 and roughness MAE 0.01685 on the normalized 0–1 scale. PNG was 43% larger. Fixed-light renders showed a modest difference and retained the overall softness. | Evaluate lossless material-data encoding separately from base-colour encoding across more inputs. Compression is a measurable contributor, not a complete explanation of sharpness. |
| R02 | With identical geometry/UVs, bounded project-first sampling reduced visible bands on several broad facets, but left residual bands. Changing to xatlas alone did not remove them. Every variant had zero failed sampling attempts. Projection increased this replay's bake/save stage from 1.90 to 3.02 seconds. | Trace spatial material samples across remaining bands; separate projection distance, material-volume variation and remesh displacement before changing the default. |
| R03 | Two observed full runs each applied five early sparse-structure lower-bound corrections: raw ratios about 0.135–0.151 became 0.2. The records now retain the evaluated flag, raw/applied values and reason. No upper-bound or nonfinite ratio correction appeared in those runs. | Broaden the input sample before any safeguard experiment. These observations do not establish a visual defect or justify weakening protection. |
| R04 | Balanced off/on/on/off runs took about 70–73 seconds. Two repetitions per condition cannot establish a regression or zero overhead. Named stages covered about 99.3% of the instrumented runs; matte inference alone took 36.33 seconds in one run. Final meshes differed even within each logging condition. | Investigate repeatability (R10) before relying on end-to-end output identity, and profile matte inference (R11). Use additional repetitions for a meaningful overhead estimate. |

Detailed manifests, raw logs, comparisons and fixed-view renders are retained in
ignored local research output. Each result above is a small-sample observation;
the initial hypotheses must not silently become production recommendations.

## Further research opportunities

| ID | Topic | Isolation strategy and maintenance boundary |
| --- | --- | --- |
| R05 | Crisp edges: resolution, remeshing, simplification and smooth normals | Higher default face target rejected after user review of five textured examples: too little visible benefit for the added geometry. Stop adoption testing for that candidate; preserve existing controls. Other geometry hypotheses remain separate, unproven investigations. See [study and decision](geometry-shading-study.md). |
| R06 | Material-volume resolution versus atlas size | Completed: five atlas assets, three material pairs, 38 controlled exports and 114 renders. Larger atlases modestly sharpen boundaries and retain striping; 1024 material helps the rock's appearance but loses penguin markings and shifts toolbox colour. Added material-stage cost is about 26–139 s. Keep defaults and automatic fallback; retain per-asset controls. See [full study](material-resolution-study.md) and F06/F07. |
| R07 | Lighting and material interpretation | Compare the identical GLB under documented environment lighting, clay and unlit base colour. This can live in the viewer; do not compensate for bad data by globally raising exposure. |
| R08 | Reusing preprocessing for repeated inputs | Profile loading, mask inference and crop/normalization first. Cache only with source/model/options/version keys and verify identical conditioning. An exported cutout can be cropped again; it is not automatically an equivalent cache. |
| R09 | Separating quality controls | Test geometry, material resolution, UVs and encoding independently before changing presets. This is chiefly an app decision once backend capabilities and costs are established. |
| R10 | Same-seed postprocessing repeatability | Four identical-input runs produced different final meshes, including off/off and on/on pairs. Two instrumented runs matched upstream counts and 19 pre-bake distribution records, then differed at the recorded simplified mesh. Hash intermediate arrays before/after cleanup and simplification; compare repeated GPU QEM with a controlled CPU baseline. GPU reduction/selection ordering is a candidate, not an established cause. Both current replay and generation builds use GPU QEM when available. |
| R11 | Matte inference cost | New timers isolate mask inference as the largest measured preprocessing cost. Profile internal inference, transfers and model reuse independently; distinguish cold process startup from a resident server. Evaluate the exact-input reuse proposed in R08 only after conditioning identity is verified. |

## Experiment discipline

- Change one factor at a time. A Low-versus-High preset comparison changes too
  many factors to identify a cause.
- Prefer saved intermediate data for downstream studies. Codec pairs must share
  baked arrays; sampling pairs must share geometry and UVs. UV-method comparisons
  need a surface/topology check because vertex indexing differs.
- Report wall time separately from GPU execution time, whole-device memory
  separately from process allocations, and atlas-wide errors separately from
  surface-weighted errors. Include how weights and texture filtering were chosen.
- Preserve unsuccessful variants and negative findings. Do not count a numerical
  correction as a failed run or a zero-missing-sample count as visual validation.
- Experimental native options remain opt-in. Review relevant upstream behavior
  before adopting a new default or taking on permanent model maintenance.
