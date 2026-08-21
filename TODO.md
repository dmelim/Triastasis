# Polyloom TODO

## Desktop validation

- [ ] In a packaged app, smoke-test Inter readability, asset/version label tooltips, custom-select keyboard and screen-reader behavior, and the outward-offset job-card minimize control.
- [ ] Exercise durable recovery by restarting with one queued job and one running job; confirm original order, source/model URLs, explicit unrecoverable failures, and no duplicate GPU execution.

## Native progress

- [ ] Package a GPU server from the current C++ sources and run the 512/1024 geometry/textured/cascade matrix, checking monotonic stages, stage-local ETA, exactly 100% on success, and preserved progress on failure. The current sources compile with MSVC, but the installed runtime predates `/progress` and correctly exercises only the UI fallback.

## Reconstruction quality test set

- [ ] Repeat selected anomalous cases through the CLI backend to preserve the conditioned cutout and native log. The server-backed seed-42 matrix already completed 10/10 and preserved sources, GLBs, dimensions, timings, and exact parameters.
- [ ] Compare healthy models, fully collapsed planes, and hybrid failures with attached background sheets using depth ratio and vertex concentration measurements.
- [ ] Use the results to identify the model's specific weak inputs and establish a reliable threshold for the planned `background-plane-attached` quality warning.
