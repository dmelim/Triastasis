# Reconstruction quality test set

A controlled 10-case matrix for measuring how the TRELLIS.2 pipeline degrades
as one input factor at a time moves away from the `01-baseline` reference
(three-quarter view, clean background, even lighting, full silhouette).

## Contents

- `inputs/` — the ten reference images (one controlled factor per case).
- `manifest.json` — case list, per-case factor descriptions, and the fixed
  generation settings + seed every case runs with.
- `results/` — small committed metric snapshots from completed matrix runs.
- `runs/` — harness output (one directory per run, created on demand).

## Running the matrix

Against a resident trellis-server:

```bash
python tools/reconstruction_run.py --server http://127.0.0.1:8080 \
    --run-dir assets/reconstruction-test-set/runs/baseline-seed42
```

Or against trellis-cli directly (also preserves the bg-removal cutout and raw
native logs per case):

```bash
python tools/reconstruction_run.py --cli ./build/trellis-cli --models ./models --gpu 0
```

Useful flags: `--only 06-busy-background,09-cel-shaded`, `--seed N`,
`--force` (re-run completed cases). The runner is resumable: completed cases
(marked by `result.json`) are skipped on re-invocation, and failures are
recorded as first-class results so one broken case never blocks the matrix.

## Preserved artifacts per case

| File | Contents |
|---|---|
| `input.png` | Copy of the original input image |
| `model.glb` | Generated model |
| `result.json` | Parameters, seed, request id, duration, dimensions, thin ratio, status/error |
| `native-log.txt`, `cutout.png` | CLI mode only: raw pipeline log and conditioned cutout |

The first server-backed seed-42 matrix completed 10/10 cases on 2026-08-21.
Its compact metrics are recorded in `results/2026-08-21-server-seed42.json`;
the large raw GLBs remain local under the ignored `runs/` directory.

## Analysis workflow (GPU run required)

1. Run the baseline to validate the harness end-to-end.
2. Run all nine variants with identical settings; keep every result,
   including failures.
3. Repeat only anomalous cases with additional fixed seeds (`--seed`).
4. Classify each output: healthy / fully collapsed / background plane
   attached / hybrid failure / other failure.
5. Feed the classified set into the detector work: compare depth ratio,
   bounding dimensions, and vertex concentration near dominant planes to pick
   a conservative `background-plane-attached` threshold.
