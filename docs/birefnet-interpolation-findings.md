# Faster background removal and generation

Updated 3 October 2026. Findings from the optimized development build, ahead of release-package validation.

Triastasis now has a focused native optimization for BiRefNet background removal:
image resizing processes memory in a more efficient order. It adds no threads or
dependencies and does not lower generation settings.

Two kinds of evidence support the change. Controlled tests isolated the fix and
preserved the tested intermediate outputs exactly. A subsequent 12-input desktop
comparison found every request faster, with **29.1% less total request time** and
no obvious new major visual regressions in matched previews. That second result
measures the compared builds as a whole, not the interpolation change alone.

## What changed

BiRefNet repeatedly resizes intermediate feature maps stored in channel-height-width
order. Previously, the innermost loop jumped between channels, crossing an entire
image plane on every iteration. The updated loop processes adjacent pixels within
one channel and precomputes the shared source coordinates and interpolation weights.

The four-term double-precision calculation, final float conversion and
`align_corners` behavior are unchanged. Model weights, sampling steps and resolution
were not changed by this fix. The implementation is in
[`interp` in birefnet.cpp](../src/birefnet.cpp), introduced by commit
`6727c801ccfdd62b1c7f4956e49b394dd0399d9a`.

## Controlled validation: isolating the fix

On the tested Windows MSVC/CUDA build with an RTX 4070:

- Original and optimized interpolation matched bitwise across 14 CPU fixtures and
  a large 192-channel resize to 1024 × 1024, over 201 million output values.
- All eight full BiRefNet mattes matched bitwise in alternating original/optimized
  runs, including warmups. An actual-native-source build also matched.
- Six controlled full requests preserved exported RGBA cutout pixels and saved
  decoded geometry exactly. Four geometry-only requests used fresh processes in
  original–optimized–optimized–original order, with loaded library identities checked.

| Controlled measurement | Original | Optimized |
| --- | ---: | ---: |
| Interpolation, mean of three profiled passes | 32.694 s | 0.665 s |
| Full BiRefNet inference, same experiment | 39.467 s | 6.999 s |
| Complete textured request, one matched pair | 111.612 s | 76.942 s |
| BiRefNet inference within that textured pair | 40.519 s | 6.227 s |

The complete textured request took **31.1% less time**. BiRefNet accounted for
34.292 of the 34.670 seconds saved, providing strong attribution for that pair.
These measurements are nested or from separate experiments and must not be added.
Original geometry-only timings varied substantially, so this is not a universal
speedup estimate. The detailed [controlled evidence](archive/runtime-research/runtime-execution-research-direction.md#september-30-interpolation-comparison)
retains the earlier measurements and qualifications.

Bitwise intermediate equality is established for the tested compiler/build.
Final textured meshes need a different comparison: a same-input, same-binary replay
also showed variation in the existing GPU simplifier. This does not establish the
cause of every final-mesh difference.

## Desktop comparison: the same 12 inputs

We then ran 12 identical source files through the installed old app and the optimized
development build. Four were existing stylized images; eight were synthetic probes
covering thin shapes, a patterned background, unusual dimensions, small images and
partial transparency. This was not a photographic hair or clutter benchmark.

Both suites requested seed 42, resolution 512, BiRefNet, textures enabled, box UVs,
150,000 target faces and a 1024 atlas. The app accepted the same settings. Requests
ran sequentially with pauses of at least 30 seconds, two logical CPU cores on different
physical cores, and below-normal native-process priority.

| Result | Old build | Optimized build |
| --- | ---: | ---: |
| Successful generations and exports | 12/12 | 12/12 |
| Total request wall time | 19m 7s | 13m 33s |
| Median request wall time | 84.7 s | 60.5 s |
| Peak sampled native CPU, share of whole machine | 16.39% | 16.51% |
| Lowest available system RAM | 13.46 GiB | 10.18 GiB |
| Lowest available GPU memory | 3.56 GiB | 2.78 GiB |
| Maximum sampled GPU temperature | 68°C | 71°C |

Total request time fell from 1,146.881 to 812.731 seconds: **334.151 seconds saved,
or 29.1% less time**. Every input was faster; individual reductions ranged from
8.0% to 53.9%. These are one-run-per-input observations, not repeatability estimates.
Native CPU usage stayed approximately the same. GPU utilization was not capped or
shown to have the same average. Available memory includes other applications and
cannot establish that the optimized runtime itself consumed more memory.

The app builds and GGML libraries differed, and background activity was not identical.
Consequently, the 29.1% total reduction cannot be attributed solely to BiRefNet.
The controlled comparison above supplies the stronger causal evidence.

## Output quality

All 24 old/new exports imported successfully. Each pair was inspected from four
shared cameras with the same lighting and bounds, using CPU-only renders. No obvious
new missing major part, collapse or material loss appeared at 256-pixel preview
resolution. Bidirectional surface sampling also found close geometry: the largest
per-case 95th-percentile distance was 0.0327% of the shared bounding-box diagonal.
That sampled statistic is not a worst-case guarantee or a texture-equivalence test.

Existing reconstruction failures remained in both builds: a flat ring, a slab in
place of the intended foreground object, and a tiny-image result with detached
geometry. Only the flat ring raised an app warning. **Twelve successful exports do
not mean twelve good reconstructions.** This optimization improves execution time,
not the model's ability to interpret difficult inputs.

CPU settings were restored after every run. The Library gained all 12 new outputs,
ended with zero warnings, and the queue was empty. Raw inputs, exports, logs and
private test plans remain outside tracked documentation.

## Release scope and remaining limits

The result supports shipping the small interpolation improvement after package
acceptance. It does not yet establish a cross-platform or universal speedup:

- The desktop suite covered one Windows CUDA system at 512 generation resolution.
- Other supported backends, compilers and 1024-generation behavior remain unvalidated
  by this suite. The CPU change is shared, but whole-request benefits can differ.
- The optimized app/runtime were development artifacts, not the final release bundle.
  Clean Windows installation and packaged-runtime acceptance remain required.
- The improvement does not include preparation caching, fewer sampling steps,
  streamed decoding or changed quality defaults. Those remain separate research.

For release notes: **“Improved BiRefNet background-removal efficiency without reducing
model settings. In a 12-input Windows CUDA comparison, the updated development build
completed every request faster and used 29% less total request time, with no obvious
new major visual regressions. Results vary by hardware and input.”**

Research discussion credit: **Astra high and Opus 5.5 medium**. Sequential experiment
execution and report preparation were assisted by **Sol medium**, with coordinating
review. Historical evidence is retained in the [runtime research archive](archive/runtime-research/README.md).
