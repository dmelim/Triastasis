# Triastasis material and appearance research: consolidated report

**Decision record: 2026-09-24, branch `research/trellis-material-diagnostics` at
`787bd16`.** This is the single current summary of what we tried, what the
evidence supports, and what we decided. Earlier study documents remain the
detailed evidence. Their older suggestions for next steps should be read in
light of the decisions below.

## Answer in brief

We found **no production-ready, general fix** for dark materials, softness,
striping, or source-image fidelity. No generation, export or viewer default was
changed. We did establish narrower facts under controlled conditions: Q4
material decoding contributes to one measured stripe pattern; lossy encoding
changes metallic/roughness data; a mixed-codec GLB can preserve that data; and
several plausible changes offer too little or too inconsistent a visible gain
to justify becoming defaults.

“Established” below means a result was reproduced or an invariant checked for
the named inputs and controls. It does **not** mean a technique improves every
asset, matches the source image, works on every backend, or fits minimum
hardware. A difference from converted F16 weights is not a ground-truth
quality score. Visual judgements and exact pixel/array comparisons are kept
separate.

## Scope of the branch record

This report covers the **whole research branch**, from its initial upstream and
pipeline audit through the first native experiments, later geometry and
resolution studies, and the low-resource and follow-up tests on 2026-09-24. The
earlier branch work is recorded in research commits `d9e5344` and
`787bd16`. The older [findings index](findings.md) records F01–F07, while the
[backlog](research-backlog.md) records R01–R11. Neither is a production rollout.

### Source audit and questions it raised

We inspected pinned upstream native and Microsoft reference sources, related
issue/release discussions, and Triastasis's full route from masking and image
conditioning through sparse structure, shape and material flows, decoders, mesh
cleanup, surface sampling, atlas encoding, GLB export and viewer lighting. No
upstream change was merged or cherry-picked. The survey found no confirmed
universal fix for dark or soft materials. The reference's project-first surface
sampling differs from the native direct-first path; R02 tested that difference
and found only partial benefit. The inherited material-resolution fallback to
512 for large decoded volumes was documented and kept. Its original motivating
claim was **source evidence**, not a controlled experiment repeated here.
[Full source and pipeline audit](trellis-material-research.md)

For the later small tests, we also consulted the
[glTF material specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)
and [WebP extension](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_texture_webp/README.md)
for separate image roles; Three.js
[RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html),
[PMREM](https://threejs.org/docs/pages/PMREMGenerator.html) and
[anisotropy](https://threejs.org/docs/pages/Texture.html#anisotropy) APIs for
viewer-only trials; and [xatlas packing options](https://raw.githubusercontent.com/jpcy/xatlas/master/source/xatlas/xatlas.h)
for the seam hypothesis. These were implementation leads, not evidence that
any change improves Triastasis assets. The controlled results appear below.

### Research apparatus added on this branch

- **Opt-in local diagnostics:** Native CLI/server and post-replay runs can save
  unique, durable JSONL records for effective settings, model/backend types,
  masks, stage timings, sampler corrections, resolution decisions, decoded and
  baked distributions, sampling routes, mesh/UV outcomes and texture-encoding
  error. The desktop launcher supplies a durable diagnostics directory. The
  offline Python summarizer checks gaps and incomplete runs. Records and raw
  captures stay local; diagnostics do not assign a fidelity score.
- **Controlled native replays:** `post-replay` can compare codecs from one bake,
  UV/sampling methods on one final mesh, and fixed-layout rebakes using a
  selected decoder output. Probe mode records spatial material samples without
  remeshing or export. Decoder capture and `trellis-tex-decode-replay` allow
  fixed-input precision checks without rerunning stochastic generation.
- **Independent checks:** Python comparison/probe/trace tools verify geometry
  identity, surface-weighted texture error, coordinate order, voxel-corner
  interpolation and selected decoder-head calculations. Synthetic and native
  tests cover logging, parser behavior, replay contracts and comparison tools.
  [Diagnostic and replay guide](material-diagnostics.md)

These are research capabilities in the native branch, not user-facing fixes.
Generation values, sampler and export defaults, the HTTP protocol and viewer
lighting were not changed. The later browser tests used temporary harnesses and
did not add a production export or viewer feature.

### Experiment coverage and open work

| Research question | Status in this branch |
| --- | --- |
| R01 encoding; R02 UV and surface sampling | Controlled same-bake and same-mesh tests completed; spatial probes and corner reconstruction followed R02. Both produced bounded findings, with no default change. |
| R03 numerical safeguards; R04 timing and diagnostic overhead | Instrumented and observed in small run sets. Correction events and timing shares were measured; visual causation and a precise overhead estimate were not established. |
| R05 geometry, normals and face count | Clay and textured comparisons completed; higher default face count rejected after five-example user review. Other geometry causes remain unproven. |
| R06 atlas size versus generated material resolution | Five fixed atlas inputs and three material-resolution pairs completed, with 38 exports and 114 renders. Keep defaults and fallback; retain asset-specific controls. |
| R07 lighting interpretation | Additive environment test, then a balanced synthetic and real-asset test completed. The tested recipes did not earn a viewer change. |
| R08 preprocessing reuse | **Untested as a cache or optimization.** Timers exposed matte cost; exact conditioning identity and cache keys still need proof. |
| R09 separate quality controls | Factors were separated in research replays. A redesigned app preset/control scheme was **not** implemented or validated. |
| R10 same-seed repeatability | Four full runs exposed differing final meshes. The first divergent array and cause remain **unidentified**. |
| R11 matte-inference cost | One run isolated a 36.33 s matte stage. Internal cost, cold versus resident behavior and an optimization remain **untested**. |
| F01–F07 decision candidates | All seven are reflected in the table below: Q8 precision and cost; lossless material data; project-first sampling; face count; atlas size; material grid. Candidate status does not mean adoption. |
| S1–S4 low-resource sets | Mixed codec, additive environment, anisotropy and conditional mipmap/seam screens completed one at a time with resource checks. Balanced lighting and app-export follow-ups then tested the two unresolved integration questions. See [later test methods](#later-low-resource-tests). |

The table marks an idea **untested** when we only identified or instrumented it.
It prevents a source-code observation, a small pilot or a proposed experiment
from being mistaken for an implemented solution.

## What we tested and learned

| Investigation | Controlled result | Current decision and limit |
| --- | --- | --- |
| **Q4/Q8/F16 material decoder** | Fixed latents, masks, coordinates, geometry and lossless export isolated decoder precision. Q8 reduced a selected raw stripe contrast by **59.2%** relative to Q4 on the first input; F16 reduced it by **64.9%**. With production sampling, the fixed baked contrast fell **57.7%** with Q8. Q8 closely followed converted F16 on two inputs. | **Candidate, deferred.** This is strong evidence that the Q4 decoder configuration contributes to that pattern. Q8 also changes colours: it reduced a purple metal tint on the second input but shifted wood greener and weakened some lines. We have not shown higher overall source fidelity or a universal sharpness fix. [Precision study](decoder-precision-study.md) |
| **Q8 bundle cost** | Replacing only the material decoder adds **35.9 MB (0.55%)** of model payload. Decoder-only timings overlapped, with Q4/Q8 medians of **8.314/8.421 s** in the isolated replays. | **Full-pipeline validation remains parked until final evaluation**, as previously requested. Payload bytes and isolated timings cannot establish peak RAM/VRAM, warm/cold generation time, or suitability for smaller GPUs and other backends. [Resource check](decoder-precision-study.md#mixed-bundle-resource-check) |
| **Decoder layout and numeric diagnosis** | Saved material coordinates and values were reproduced exactly; checked subdivision order, final pairing, scaling and storage matched. Recalculating one output head with higher-precision accumulation but the same dequantized Q4 weights left local contrast essentially unchanged (**0.07370 vs 0.07401**). | The tested layout and head-accumulation explanations are not promising fixes. This does not prove full reference-model parity or isolate weight rounding from backend quantized arithmetic. [Backlog trace](research-backlog.md) |
| **Surface sampling and UVs** | Bands were present before atlas baking and in unlit views. Project-first sampling reduced some profiles but left residual bands and raised one bake/save stage from **1.90 to 3.02 s**. Switching UV layout alone did not remove them. All measured projected queries already fit the existing search radius. | **No sampler or UV default change.** Missing/partial voxel support contributes in some places, yet one residual bright/dark pair retained **98.6%/99.8%** support. Increasing projection radius cannot help the measured queries, and one sampled pair cannot rank whole-asset quality. [Backlog R02](research-backlog.md), [diagnostics](material-diagnostics.md) |
| **PNG versus WebP material encoding** | On one same-bake pair, PNG decoded exactly to the baked arrays. WebP introduced surface-weighted metallic MAE **0.05850** and roughness MAE **0.01685** on normalized channels. The all-PNG GLB was **43% larger**. | Lossy encoding demonstrably changes material values, but visible differences were modest and softness remained. A numerical material-data error is not automatically a perceptual defect. [Backlog R01](research-backlog.md#completed-first-experiments) |
| **Mixed WebP base colour plus PNG material data** | Offline repacking of two same-bake exports retained byte-identical WebP base payloads, byte-identical PNG material payloads and unchanged geometry. The mixed GLBs were **15.9–19.8% larger than all-WebP** and about **16% smaller than all-PNG**. Fixed software-rendered views showed a modest change on one asset and little on the other. | **Possible scoped export option if exact material values matter to a real use case; no default change.** This preserves data, not demonstrated source fidelity. Native generation currently chooses one codec for both images, so a product option crosses the exporter/bridge maintenance boundary. [Later test methods](#later-low-resource-tests) |
| **Actual app export of a mixed GLB** | The unmodified `exportGlb` function preserved the pilot’s geometry, normals, UVs, indices, transforms, material factors and **all decoded metallic/roughness pixels**. It kept WebP/PNG roles but re-encoded the base WebP, changing its payload and decoded pixels; sampled base RGB MAE was **0.00728/0.00516/0.00802**. | The current app export path is **not an exact mixed-codec passthrough**. The first input failed the encoded-base preservation gate, so a second input was not run. An exact route would need payload copying or another explicitly scoped design; the offline repack has not been integrated. [Later test methods](#later-low-resource-tests) |
| **Normals, simplification and higher face targets** | Fixed-topology normal variants changed shading; flat normals sharpened some panels but exposed facets elsewhere. Higher face targets improved clay shading, yet five textured examples showed little useful difference in user review. One tested GLB grew about **89%**, while baking rose from about **1.4 to 2.0–2.1 s**. | **Reject a higher default face target.** Retain manual controls. No general normal replacement was selected; clay improvement does not guarantee a textured benefit. [Geometry study](geometry-shading-study.md) |
| **Atlas size** | On five fixed Q4/box-UV assets, larger atlases preserved finer boundaries but also existing bands. The 1024-to-2048 change reduced discrepancy against 4096 by **48–53%**, which measures convergence, not quality. Two decoded RGBA textures use **8/32/128 MiB** at 1024/2048/4096, before mipmaps. | **Keep defaults.** 2048 remains a manual close-view choice. There is no evidence for a blanket 4096 atlas or another size sweep. [Resolution study](material-resolution-study.md#atlas-only-results) |
| **Generated material resolution** | Actual 1024 material changed appearance substantially: one rough-surface input improved, while other colours shifted and several markings were lost on a different input. Three pairs had fewer missing sample attempts, with about **26–139 s** more material-stage work in the recorded runs. | **Asset-specific control, not a universal increase.** The setting also changes conditioning and flow path, so this was not a pure grid-density intervention. Zero missing attempts does not prove correct correspondence or visual fidelity. Keep automatic fallback. [Resolution study](material-resolution-study.md#material-grid-results) |
| **Viewer lighting** | Adding a `RoomEnvironment` to unchanged lights made a synthetic metal sphere readable but raised neutral-card linearized display luminance **56.6%** even at the lowest first-study intensity. A later balanced setup held the card median fixed and cut synthetic near-black metal from **80.0% to 47.3%**. Frozen settings improved real metal by only **2.6–12.3%** across four views, below the preregistered **20%** gate. The user saw an obvious synthetic difference but little practical difference on the saved models. | **Park this viewer change.** The additive recipe failed calibration; the balanced recipe passed synthetic controls but failed the real-asset benefit gate. Neither supports a new preset or default. Another lighting hypothesis needs a concrete real-model complaint. [Later test methods](#later-low-resource-tests) |
| **Anisotropy and mipmap seams** | Anisotropy 4 changed a synthetic checker but yielded little consistent benefit on one real pilot. Its exploratory gradient metric was **not** the planned edge-width measure, and GPU cost was not tested. A separate near/far xatlas screen found no localized seam that worsened with mipmaps and improved without them; disabling mipmaps mostly increased sharpness and noise. | **Anisotropy: low-priority, inconclusive beyond this pilot. Seam repair: not triggered.** Do not add a filtering control, generic dilation or a mipmap change from these screens. Reopen only with a specific oblique-detail complaint or reproducible UV-boundary seam. [Later test methods](#later-low-resource-tests) |
| **Safeguards, timing and repeatability** | Two observed runs each applied five early sparse-structure lower-bound corrections; no visual cause was demonstrated. Balanced diagnostics off/on runs took about **70–73 s**, with differing final meshes even within the same logging condition. Two instrumented runs agreed through upstream counts and **19 pre-bake distribution records**, then differed at the recorded simplified mesh. Matte inference took **36.33 s** in one run. | **No safeguard, cache or speed change.** The repeatability cause is not isolated; similar counts are weaker than array identity. Profile preprocessing before optimizing it, and localize the first mesh divergence before using final-GLB equality as an end-to-end test. [Backlog R03/R04/R10/R11](research-backlog.md) |

## Later low-resource tests

The 2026-09-24 tests used existing GLBs and static views, one asset and one
WebGL context at a time. Before viewer work, three GPU checks found about
3,264–3,270 MiB free and 48–58% utilization, below the planned 4,096 MiB free
and under-20% use gate. Later utilization still exceeded the gate. We therefore
used Chrome SwiftShader at 512 × 512, device pixel ratio 1, with the installed
Three.js loader, app light values, ACES and sRGB settings. This supports fixed
static comparisons, not desktop GPU appearance or frame-cost claims. Browser
pointer lock was disabled. Available RAM checkpoints were 13.6–17.9 GiB, and
new output for S1–S4 was about 14.6 MB against a 1 GiB cap. The peak process
working set was not continuously measured. No inference, native build or model
download was run. Private input hashes, variants, settings, captures and
machine-readable results remain in ignored `out/material-research/`.

- **S1, mixed texture encoding:** An offline repack copied the encoded WebP
  base image from each all-WebP GLB and the PNG metallic/roughness image from its
  same-bake all-PNG pair. Geometry, normals, UVs, indices and material factors
  matched. Both mixed GLBs had exactly the source image payloads and zero
  surface-sampled material error against PNG. Their sizes were 6,952,908 and
  6,081,240 bytes, versus 5,804,996 and 5,245,512 for all-WebP and 8,299,464
  and 7,229,928 for all-PNG. They loaded in the research viewer. Fixed PBR
  screenshot differences versus all-WebP averaged 0.476 and 0.029 RGB code
  values per pixel. These views support a modest, asset-dependent appearance
  change, while exact material data preservation is the stronger result.
- **S2, additive environment:** With existing lights fixed, a 128-size
  prefiltered `RoomEnvironment` at intensities 0.25, 0.5 and 1.0 changed the
  synthetic neutral card's linearized display-luminance median by +56.6%,
  +99.4% and +151.6%. The preregistered neutral limit was +10%, so the test
  stopped before viewing generated assets with that recipe.
- **S3, anisotropy:** The software renderer exposed maximum anisotropy 16.
  A synthetic checker confirmed that 1 versus 4 changed texture filtering.
  On one real 1024-atlas pilot, fixed front/grazing views changed by 0.029/0.197
  mean RGB code values. Three grazing regions' mean gradients changed +1.82%,
  +0.40% and -0.11%. These exploratory gradients were not the planned 10–90%
  edge-width metric. Little useful detail was apparent, so no second asset or
  orbit timing was run; real GPU cost remains unknown.
- **S4, conditional mipmap seam:** One xatlas GLB was viewed near and at 1.6
  times smaller scale with and without mip selection. No localized UV-boundary
  seam met the entry condition of worsening with distance and improving without
  mipmaps. The planned 25% seam-deviation measurement and repair were therefore
  not run. No-mip viewing mainly added sharpness and noise.

Two follow-ups were then specified with fixed controls and stop rules. The
balanced-lighting test adjusted one common multiplier on the existing lights
while keeping exposure fixed. The first passing environment intensity was
0.0625 with light multiplier 0.86328125. The neutral-card median remained
0.270280 in both conditions; synthetic metal near-black coverage fell from
80.0% to 47.3%, with clipping falling from 0.520% to 0.493%. This balance was
frozen before four camera views of a generated metal asset. Its near-black
coverage improved only 2.6–12.3%, below the preregistered 20% gate in every
view. A second asset's dark markings remained visible on inspection. All eight
unlit control pairs were pixel-identical. The test supports no lighting change.

The export follow-up called the unmodified `exportGlb` implementation from
`app/src/export-glb.ts` on a pristine loaded mixed-codec GLB, then reparsed and
rerendered the result. Geometry, transforms, factors and decoded material pixels
were preserved on the first input. The encoded WebP base changed from 322,008
to 328,780 bytes; its surface-sampled RGB MAE was 0.00728/0.00516/0.00802.
The encoded PNG bytes also changed despite decoded material-pixel identity.
The complete GLB shrank from 6,952,908 to 6,801,232 bytes. The payload gate
failed, so the second input was not run. This test identifies the existing app
exporter's preservation limit; it does not validate every consumer or the full
desktop interaction.

The follow-up produced 54 lossless captures, four contact sheets and eight
additional diagnostic masks. Its successful capture/export run took about 10 s;
process-tree samples peaked at about 848 MiB against a 1.5 GiB cap, with about
10 MB of private output against a 250 MiB cap. Free disk stayed above 169 GB.
Whole-device VRAM readings could not attribute allocation to the test. Early
setup errors were kept separate from the valid run; there was no resource stop.
Neither follow-up changed production source or defaults.

## Evidence limits and decisions to preserve

- **No production improvement is proven.** The Q8 result is the strongest
  controlled appearance candidate, but its colour tradeoffs and full-generation
  resources are unresolved. The mixed codec has the strongest exact
  data-preservation result, but visible benefit is modest and the current app
  export path changes base pixels.
- **Do not repeat these default-change tests** without a new defect or decision:
  higher face targets, blanket 4096 atlases, universal 1024 material, sampler
  radius increases, additive environment lighting, safeguard weakening and
  generic seam repair have not earned a default change.
- **Later tests used Chrome SwiftShader at 512 square** because the GPU-use gate
  was not met. Static before/after comparisons were controlled; they do not
  establish native desktop GPU appearance, frame cost or minimum hardware.
  The balanced-lighting/export follow-up monitored its browser process tree
  at about **848 MiB** peak sampled RSS and produced about **10 MB** of private
  output. Its setup failures occurred before the valid run and were retained
  separately. No model inference or native build was used in these later tests.
- **No upstream universal fix was verified.** The issue survey and reference
  comparisons are useful context, not evidence that a single setting repairs
  all dark or soft exports. [Pipeline research](trellis-material-research.md)

## When to revisit

1. **Final Q8 evaluation, when the deferred phase begins.** Test whole-pipeline
   generation at intended resolutions on target and smaller hardware/backends.
   Hold downstream settings fixed; measure peak process RAM and GPU memory,
   warm/cold time and the colour tradeoff. Only then consider a bundle/default
   decision. The decoder-only result is insufficient for minimum requirements.
2. **Exact material-data export, if a user workflow needs it.** Specify the
   consumer and whether decoded metallic/roughness identity or encoded base
   payload identity matters. The current app exporter meets the former on one
   pilot and fails the latter. Prototype the smallest compatible path and test
   actual import/export before changing native or bridge code.
3. **Repeatability, if more end-to-end timing or output comparisons are needed.**
   Hash actual arrays around cleanup and simplification on a saved input to
   locate the first divergence. The existing counts/distributions do not
   identify a cause. Keep GPU QEM ordering as a hypothesis, not a diagnosis.
4. **Viewer lighting or filtering, only for a concrete real-asset defect.**
   Preregister a region and a meaningful benefit threshold on the problem
   asset, then verify on the native viewer/GPU before proposing a control.

Private captures, models, logs, source hashes, masks and comparison pages remain
in ignored `out/material-research/`. The committed studies linked above, this
report and the ignored local evidence retain the controls and negative results.
This report records research and decisions; it does not authorize a production
feature, commit, tag or release.
