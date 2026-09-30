# BiRefNet interpolation optimization in Triastasis

Research brief • 30 September 2026

A small change to CPU bilinear interpolation substantially reduced background-removal time in Triastasis. In a controlled textured-generation comparison, request time fell from **111.612 to 76.942 seconds**, a **31.1% reduction for this input and configuration**. Background-removal inference accounted for 34.292 of the 34.670 seconds saved. Cutout pixels and saved decoded geometry were identical.

**What was wrong and what changed**

BiRefNet resizes intermediate feature maps during background removal. The native implementation stores these maps in channel-height-width order: each channel occupies a contiguous memory plane. Its original interpolation loop visited rows, then columns, then channels. Moving between channels in the innermost loop therefore jumped an entire plane in memory for every output value.

The fix in `src/birefnet.cpp`, function `interp`, makes the channel loop outermost. It processes adjacent output columns within one channel and precomputes the source row/column indices and fractional weights shared by all channels. This improves memory locality and avoids repeated coordinate calculations. The experiments did not separately measure the contribution of each change or hardware cache-miss rates.

```text
Before: output row → output column → channel
After:  channel → output row → output column
        with source coordinates and weights precomputed
```

The four-term double-precision interpolation expression, final float conversion and `align_corners=True` behavior remain unchanged. The fix adds small coordinate lookup arrays, no threads and no dependencies. Model weights, sampling steps, resolution and quality settings were unchanged. The source change is recorded in commit `6727c801ccfdd62b1c7f4956e49b394dd0399d9a`.

**How it was tested**

Validation proceeded from the function to the complete native request, on Windows with an MSVC/CUDA build and an RTX 4070.

1. **Isolated interpolation:** original and optimized implementations matched bitwise in 14 edge/production-shape CPU cases and a large 192-channel resize to 1024 × 1024, containing 201,326,592 output values.
2. **BiRefNet inference:** one warmup per variant followed by six alternating measured passes. All eight full mattes matched bitwise. Graph, deformable-convolution and interpolation call counts stayed at 142, 20 and 12.
3. **Controlled geometry requests:** four fresh server processes in original–optimized–optimized–original order. Both executables used the same retained core library, models, input and settings. Actual loaded DLL paths and hashes were checked.
4. **Controlled textured requests:** one fresh process per variant, with texture execution verified in native diagnostics. Settings were seed 42, resolution 512, BiRefNet, box UV, target 150,000 faces, atlas 1024 and remesh band 1.

The full requests ran sequentially at below-normal priority, with two logical CPUs on different physical cores and two backend threads. The earlier inference-only experiment used four logical CPUs and two backend threads; its timings are a separate comparison. Resource guards checked memory, GPU readiness, deadlines and cleanup. Twenty-eight CPU-only parser checks preceded inference; diagnostics then verified what actually executed.

**Measured results**

| Measurement | Original | Optimized | Scope |
| --- | ---: | ---: | --- |
| Interpolation time | 32.694 s | 0.665 s | Mean of three profiled inference passes per variant |
| Full BiRefNet inference | 39.467 s | 6.999 s | Same inference-only experiment |
| Geometry-only request, first occurrence | 50.084 s | 38.217 s | Four-run alternating control |
| Geometry-only request, second occurrence | 67.664 s | 39.061 s | Same control |
| Textured request | 111.612 s | 76.942 s | One matched pair |
| BiRefNet inference inside textured request | 40.519 s | 6.227 s | Same textured pair |

These measurements are nested or come from separate experiments; the rows must not be added together. In the textured pair, **98.9% of the request-time saving appeared in BiRefNet inference**, while later stage timings closely matched. The improved test harness provided attribution; it was not another production optimization.

**Output correctness**

All six controlled requests produced identical exported RGBA cutout pixels and saved decoded-mesh bytes. The four geometry-only GLBs also had identical geometry payloads; whole-file differences came from generation timestamps. The cutout comparison is distinct from the earlier full-matte comparison and does not itself test raw floating-point masks.

Final textured meshes were not bit-identical. A separate same-input, same-binary replay demonstrated that the existing GPU simplifier can vary between runs. That establishes a testing limitation, but does not prove the exact cause of this pair's final differences. Four matching CPU-rendered views showed no obvious new missing parts. Bidirectional surface sampling found a 95th-percentile separation of about 0.026% of the object's bounding-box diagonal. This supports a close match for this asset, not universal quality equivalence.

**What can be claimed**

The optimization removed a substantial native execution bottleneck without reducing model settings, and preserved the tested intermediate outputs. The original geometry-request timings varied considerably, mostly inside BiRefNet; the cause remains unresolved. Therefore, 31.1% is an observed paired result, not a guaranteed speedup across images or machines. The earlier installed-app comparison had multiple confounding differences and is not evidence for this percentage.

The CPU function is shared across backends, but other runtimes, compilers and devices still need validation. Bitwise equality is established for the tested build. Broader image coverage and packaged-app acceptance should precede release claims. The small, isolated change is suitable for consideration as an upstream contribution.

Evidence: the [September 30 interpolation comparison](runtime-execution-research-direction.md#september-30-interpolation-comparison) and the source commit above document the isolated change. This brief records the subsequent controlled full-request results; raw captures and diagnostic logs remain private. Research discussion credit: **Astra high and Opus 5.5 medium**. Sequential test execution and report preparation were assisted by Sol medium, with coordinating review.
