# Material resolution versus texture size

Completed 2026-09-13: six full captures, 38 controlled exports and 114 renders.
Production defaults are unchanged.

The atlas is a modest contributor to softness: 1024 to 2048 preserves finer
boundaries, but also makes existing material stripes more distinct. Increasing
the generated material grid changes appearance much more, with mixed quality:
the rock gains a less green, less regularly banded surface, while the penguin
loses source-image spots and the toolbox shifts colour and remains noisy.
Neither setting is supported as a universal quality upgrade.

## Questions and controls

This study separates two settings that are easily conflated:

- **Material resolution** (`textureResolution`, native `--tex-res`) selects the
  generated material path. A real 1024 material requires 1024 geometry. The
  app already restricts that combination. The 512 mixed path uses the lower
  resolution shape guide, conditioning and texture flow; the 1024 path uses
  their higher resolution equivalents. It is not simply a denser evaluation
  of an identical continuous material field.
- **Atlas size** (`atlasSize`, native `--atlas`) controls the square texture
  images baked from that material. Increasing this setting does not rerun the
  material model or add information to its generated volume.

Atlas tests use five saved 512 captures: crate, toolbox, rock, tree and penguin.
Each is baked at 512, 1024, 2048 and 4096. Material tests use penguin, toolbox
and rock, each generated with 1024 geometry and explicit 512/1024 material
settings, then baked at 1024, 2048 and 4096. Seed 42, original source image,
installed Q4 model bundle and box UV method remain fixed within each pair.

The fixed-mesh research baker preserves positions, indices, normals, UVs and
box-face assignments within each comparison group. Changing only the atlas
header increases raster resolution without repacking UVs. This keeps normalized
UV layout and padding fixed; it is a controlled density experiment rather than
a measurement of every possible freshly packed atlas.

For material pairs, decoded source geometry must match exactly across captures.
Both materials are rendered on one fixed exported mesh. Their common decoded
geometry is used directly as the projection BVH, disabling resolution-dependent
welding and hole filling in replay. This prevents material-grid selection from
changing the projection surface. That diagnostic preparation differs from a
fresh full production export, whose simplifier and cleanup can vary.

Captured material values are converted back into the fixed baker's raw-input
range; the verified float32 round-trip error is limited to 6e-8. All variants
within an atlas group reuse those same values. Lossless PNG avoids a lossy-codec
confound. Decoded textures are checked against the raw baked arrays.

## Measurement interpretation

Surface comparisons use 30,000 deterministic area-distributed samples and
bilinear level-zero texture sampling. Agreement with the largest atlas measures
sampling convergence, not fidelity to the input image or a ground-truth material.
Differences between 512 and 1024 materials measure a changed result; additional
contrast, noise or colour changes do not automatically count as better detail.

Capture timing includes diagnostics, model loads, output and research dumps.
There is one full capture per condition per asset, so totals are exploratory
observations rather than repeatable benchmark claims. Material guide, flow and
decode stages are reported separately. Process RSS and whole-device GPU memory
are sampled at approximately 200 ms; neither proves a hardware minimum.

The box atlas divides its image into a 4-by-3 grid of projection buckets before
padding and aspect-preserving fit. Thus a 1024 atlas does not provide 1024 pixels
across every visible object surface: a bucket is at most 256 by 341 pixels.
Results from this layout do not establish equivalent gains with xatlas packing.

All visual comparisons use fixed cameras and lighting within each group,
1024-pixel renders, PBR front and three-quarter views, and an unlit base-colour
three-quarter view. Geometry differs between the saved 512 atlas study and the
new 1024 material study; comparisons across those two groups are not controlled.

Detailed captures, model/executable/source hashes, commands, timings, sampled
memory, fixed meshes, raw materials, raw atlases, GLBs, validation, images and
the comparison page are kept under ignored
`out/material-research/material-resolution-study/`.

## Material generation cost

All six captures completed with the requested effective material grid and no
nonfinite sampler velocities. Each row is one run, not an average.
The local Windows CUDA run used an NVIDIA GeForce RTX 4070 with 12,282 MiB
reported GPU memory and driver 616.56. Model and executable hashes are retained
in the capture manifest; these results are not portable hardware guarantees.

| Asset | Material | Guide + flow + decode (s) | Full capture (s) | Material voxels | Peak process RSS (GB) | Peak whole-device GPU (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Penguin | 512 | 9.22 | 153.75 | 649,250 | 4.76 | 7,997 |
| Penguin | 1024 | 35.06 | 194.92 | 3,130,867 | 4.81 | 8,389 |
| Toolbox | 512 | 12.35 | 248.01 | 1,047,519 | 8.15 | 9,392 |
| Toolbox | 1024 | 54.91 | 289.93 | 5,127,929 | 8.25 | 9,374 |
| Rock | 512 | 29.36 | 576.95 | 2,174,058 | 15.60 | 11,619 |
| Rock | 1024 | 168.00 | 726.56 | 9,976,961 | 15.81 | 11,572 |

The material stages cost 3.8x, 4.4x and 5.7x as much respectively, adding
25.84, 42.56 and 138.64 seconds. Full-run differences include other stages,
diagnostic I/O and run variation, so they should not be attributed entirely
to material inference. Peak memory covers the whole run and can be dominated
by geometry work; the similar peaks do not establish unchanged GPU requirements.

The rock has more than nine million decoded geometry voxels, where the current
automatic selection uses 512 material. Explicit 1024 succeeded on this machine.
This single success does not justify removing that automatic fallback.

## Texture storage cost

These exports contain two RGBA textures. Their decoded base-level storage is
2, 8, 32 and 128 MiB for atlas sizes 512, 1024, 2048 and 4096 respectively.
Mipmaps, geometry, temporary uploads and renderer overhead are additional.
Thus 1024 to 2048 quadruples texture storage; 1024 to 4096 multiplies it by 16.
PNG file sizes are measured separately because compression depends on content.

## Atlas-only results

All five saved materials have effective resolution 512. Values in the next
table are complete lossless GLB sizes in decimal MB, including fixed geometry.

| Asset | Atlas 512 | Atlas 1024 | Atlas 2048 | Atlas 4096 |
| --- | ---: | ---: | ---: | ---: |
| Crate | 5.42 | 7.79 | 19.07 | 53.87 |
| Toolbox | 6.19 | 8.32 | 15.85 | 37.37 |
| Rock | 5.56 | 7.23 | 13.80 | 33.40 |
| Tree | 6.01 | 7.66 | 13.69 | 30.61 |
| Penguin | 5.17 | 6.32 | 10.41 | 21.52 |

The measured fixed-box bake stages (seconds, excluding mesh preparation and
PNG encoding) were:

| Asset | Atlas 512 | Atlas 1024 | Atlas 2048 | Atlas 4096 |
| --- | ---: | ---: | ---: | ---: |
| Crate | 0.74 | 1.33 | 3.03 | 7.08 |
| Toolbox | 0.39 | 0.81 | 2.01 | 5.59 |
| Rock | 0.55 | 0.88 | 1.81 | 4.56 |
| Tree | 0.39 | 0.66 | 1.44 | 3.69 |
| Penguin | 0.18 | 0.35 | 0.81 | 2.36 |

At 1024 versus the 4096 reference, surface RGB MAE ranges from 0.01282 to
0.02610 on a normalized 0–1 scale; at 2048 it ranges from 0.00617 to 0.01223.
Moving from 1024 to 2048 reduces this discrepancy by 48–53% on each asset.
That confirms a real sampling-density effect, not a 48–53% quality improvement.
The 4096 reference contains the same underlying material errors.

Visual review used matching front, three-quarter and unlit views, with common
crops for close inspection:

| Asset | Visible result | Interpretation |
| --- | --- | --- |
| Crate | Finer diamond borders and wood streaks; soft corner plates and mottled colour remain. 2048 and 4096 are close at the reviewed display scale. | A modest texture-boundary gain; missing source detail is not recovered. |
| Toolbox | Less coarse wear and edge transitions, especially 512 to 1024. Fine regular lines remain visible across panels and metal at larger sizes. | Higher density preserves existing detail and defects together. |
| Rock | Coarse wavy patterns at 512 resolve into finer regular striping. The triangular opening and silhouette do not change. | Cleaner sampling does not remove the material artifact or repair geometry. |
| Tree | Large mottled patches become finer banded texture; foliage colour and broad shape remain the same. | No convincing recovery of useful foliage detail. |
| Penguin | Spots and white/black boundaries become less blurred, mostly from 512 to 1024. Gains beyond 2048 are small at this scale. | Useful preservation of markings, with diminishing visible returns. |

No atlas-only bake had missing sampling attempts. The visible bands persist in
unlit base colour, so they cannot be explained solely by light placement or
normal shading. This experiment does not isolate their precise upstream cause.

## Material-grid results

Each pair has byte-identical decoded source geometry; all six variants within
an asset also have identical exported positions, indices, UVs and normals.
The following observations compare materials at the same 2048 atlas and were
checked against the 1024/4096 atlas overview.

| Asset | What 1024 material changes | Quality judgement |
| --- | --- | --- |
| Penguin | Sharper eyes and cleaner broad face/chest boundaries, but many belly spots fade or disappear. The belly becomes warmer and more mottled. | Mixed: the user identified a meaningful improvement in eye definition, alongside worse preservation of body markings. |
| Toolbox | More saturated blue, stronger green accents and brighter/pinker metal. The wrench reads more clearly in front view, but fine banding and speckling remain. | More contrast and different colour, without a consistent crispness or source-fidelity win. |
| Rock | Less green colour, less dominant regular banding, stronger separation between grey facets. Fine speckling and some bands remain; the mesh opening persists. | The most promising asset-specific improvement, with residual artifacts and the largest time cost. |

These changes persist in unlit base colour. They arise upstream of the final
atlas rasterization and cannot be reproduced simply by making the 512
material's atlas larger. They do not establish that resolution alone caused
every change: guide, conditioning and flow model also change with this setting.

At atlas 2048, the RGB difference between material settings is 0.11336 for
penguin, 0.10989 for toolbox and 0.05635 for rock. This is a difference metric,
not a score of improvement. Complete GLB sizes at that atlas are respectively
10.58/10.57, 13.92/16.84 and 15.06/15.01 MB for 512/1024 material. A denser
generated material does not inherently require a larger final texture image.

### Sampling coverage

At atlas 1024, the 512-material pairs missed 0.604% (penguin), 5.265%
(toolbox) and 1.898% (rock) of raster sample attempts. The 1024-material pairs
missed zero. Similar percentages hold at larger atlases. These counters include
overdraw and are not percentages of visible surface area or final empty pixels;
the baker fills atlas gaps afterward.

The original full capture exports show the same 512 miss counts (1,452,
28,056 and 9,057 respectively), corroborating that this is not introduced by
disabling cleanup in the fixed replay. The 1024 fixed bakes resolve roughly
87–94% of attempts by snapping to a nearby material voxel. Successful sampling
therefore does not prove exact spatial correspondence or clean appearance.
Higher coverage is a useful finding, but the penguin demonstrates that it can
coexist with worse preservation of source markings.

## Decision and limits

Final user review: the overall difference is modest. The sharper penguin eyes
are a real local improvement, but do not make the whole asset dramatically
better. Results are saved and this investigation is paused; no default change
was selected.

- Keep defaults and the automatic material fallback unchanged. This study does
  not support a blanket move to 1024 material or 4096 textures.
- Retain 2048 atlas as a reasonable manual option for close views of box-UV
  assets when the modest boundary improvement warrants four times the decoded
  texture storage of 1024. It is not a cure for the original softness.
- Treat 1024 material as an asset-specific option: promising for this rock,
  mixed for the toolbox, and harmful to several penguin markings. Its measured
  extra material-stage work ranges from about 26 seconds to 139 seconds.
- The useful conclusion is that generated appearance and material-to-surface
  sampling matter more here than simply increasing atlas pixels. A precise
  defect diagnosis would require a separate study; none is asserted here.

This is a controlled local Q4/box-UV study with one seed per material pair,
three material inputs and five atlas inputs. It does not establish outcomes
for xatlas, other model precisions, other backends, arbitrary seeds or low-end
hardware. No frame-rate, game-engine load-time or mipmap benchmark was run;
decoded texture storage and export timings describe only part of downstream
cost. Full-pipeline mixed Q4/Q8 evaluation remains parked for the final phase.

## Reproduction and artifacts

The ignored study directory contains `design.json`, `captures.json`,
`capture-summary.json`, `bakes.json`, `analysis.json`, `render-report.json`,
scripts, logs, source hashes, fixed arrays and all exports. `index.html` is the
interactive comparison, with atlas controls, lit/unlit views and GLB downloads.
`review/` contains common-crop contact sheets. All 38 GLBs passed exact
geometry/UV/normal identity within their groups and decoded-PNG/raw-array
identity. All 114 renders completed with identical camera and lighting controls
within each group. The six capture processes and four postprocessing stages
completed successfully.
