# Triastasis In-App Model Installation Plan

Status: revised after design review; Phase 1 in progress

Created: 2026-08-25

Scope: move model-weight installation out of the installers and into a verified, resumable, in-app download manager.

Review outcomes incorporated: portable-mode policy, `modelsRoot`/`activeBundle` configuration split, separate runtime release manifest, lazy legacy verification, bounded checksum retries, modular frontend ownership, background downloads decoupled from activation gating, no mandatory native capability endpoint, no premature free-space dependency.

## 1. Product decisions

### Model choices

| UI name | Bundle ID | Quantization | Approximate download | Default role |
|---|---|---|---|---|
| Starter | `trellis2-q4` | q4 | 5.9 GB | Lowest storage requirement |
| Recommended | `trellis2-q8` | q8 | 9.6 GB | Default recommendation |
| Full precision | `trellis2-f16` | f16 | 16.5 GB | Highest precision |

All three bundles contain the complete set of ten model files and support every
available generation resolution. Two files (`birefnet.gguf`, `ss_dec.gguf`) are
identical across variants; this is recorded in the catalog and may be exploited
later for cross-bundle reuse (explicit non-goal for the first release).

### Recommendation versus selection

Hardware detection recommends a bundle but never silently selects or starts one.
The first-launch screen detects backend, GPU, VRAM, and storage, marks one
bundle "Recommended for this system", explains uncertainty, allows any selection,
and warns when a selection is unlikely to run reliably. This reuses the existing
hardware detection (`hardware.rs`), `hardware-profile.ts` recommendation
mapping, and the existing allow-above-recommendation preference. Generation
resolution recommendations remain separate from bundle selection.

### Terminology

Primary names: Starter, Recommended, Full precision. Q4/Q8/F16 appear as
supporting technical detail. Avoid "Maximum quality" until output comparisons
prove a consistent visible difference (Phase 6).

## 2. User experience

### First launch without models

The shell opens normally; the server is not repeatedly started with missing
models. Detection reports available backends, GPU name, VRAM, free space on the
selected drive, existing compatible model files, and resumable partial
downloads. The user picks a bundle and location, starts the download explicitly,
and enters the Generate screen only after the bundle is verified and activated.
Generate clearly explains that a model bundle is required until then. This hooks
into the existing setup-state polling (`#setup-banner`) rather than replacing it.

### Download screen

Shows selected bundle, total size, destination, available space, overall
progress, current file, byte counts, speed, ETA, verification state, pause,
resume, and cancel. Status sequence: Preparing, Downloading, Paused, Resuming,
Verifying, Ready, Failed. Ten separate GGUF tasks stay behind a technical
details disclosure.

### Interrupted download

On restart the app detects the partial installation, verifies completed files,
continues incomplete ones without restarting the bundle, explains what was
found, and offers Resume and Discard. Discard removes only files owned by that
incomplete installation.

## 3. Catalogs and manifests

Two separate bundled manifests, never mixed:

1. **Model catalog** - pins the upstream Hugging Face revision, lists every
   bundle with per-file size and SHA-256, download URLs referencing the pinned
   revision, supported application versions, and license/attribution references.
   Current pin: `ilintar/trellis2-gguf` revision
   `a57397bd3d351599d9729fc144b3f87c3f87d65b`.
2. **Runtime release manifest** - pins trellis-server runtime releases per
   backend/OS with expected sizes and SHA-256 hashes. Owned by the
   installer-simplification phase or a parallel release-hardening task; not part
   of the model catalog.

Changing either pin requires an application update reviewed by the project.
A file counts as installed only when it exists, matches the catalog size,
matches the catalog SHA-256, and belongs to the expected bundle revision.
File names alone are never sufficient.

## 4. On-disk structure

```text
<models-root>/
  downloads/
    <bundle-id>/
      *.partial
      download-state.json
  installed/
    <model-revision>/
      q4/*.gguf + installation.json
      q8/*.gguf + installation.json
      f16/*.gguf + installation.json
```

`installation.json` is written last (temp file, flush, atomic rename) and acts
as the commit marker. It records bundle ID, model revision, catalog version,
timestamp, file hashes, and the installing application version.

### Configuration split

Configuration distinguishes the managed root from the effective server
directory while staying backward-compatible:

```text
modelsRoot     D:\Triastasis\Models
modelsDir      D:\Triastasis\Models\installed\<revision>\q8
activeBundle   trellis2-q8
```

`modelsDir` remains the effective `--models` argument. Existing configurations
containing only `modelsDir` remain valid and are treated as a legacy root until
a managed bundle is activated there.

## 5. Native download manager

Lives in the Rust/Tauri layer for reliable filesystem access, streaming
downloads, native pause/cancel, SHA-256 verification, atomic operations,
survival across UI reloads, and reduced path exposure to the renderer.

Per file: check verified final file; check partial file; validate resume
metadata; request the remaining byte range; stream into the partial file;
persist progress periodically; flush; validate size; validate SHA-256; atomic
rename to final name. After all files pass: write the commit marker atomically.

Resume only when the remote confirms the same object (ETag, Last-Modified,
expected size, pinned revision). If the server ignores Range and returns the
complete file, truncate before writing - never append.

### Bounded retries

At most three automatic attempts per file with backoff. After the cap: stop
retrying, preserve resumable state where possible, record diagnostic metadata
(hash mismatch details, headers, byte counts) and ask the user to retry.
Corrupted multi-gigabyte files are **not** quarantined whole by default;
diagnostic metadata is retained instead.

### Concurrency

One model-management mutation per models directory at a time, enforced by a
directory lock (second executable instance, slow shutdowns, future CLI tools,
two installations sharing a directory).

## 6. Disk-space handling

Required space = remaining download bytes + temporary verification overhead +
safety margin, measured against actual free space on the selected volume.
UI shows download size, available space, and location.

Bundle switching downloads and verifies the new bundle before offering removal
of the previous one; destructive removal requires explicit confirmation and
enough temporary space for both bundles. On disk-full: pause, preserve valid
partial data, report the shortfall, allow freeing space or changing location
without discarding progress.

Free-space detection uses platform APIs directly (Windows `GetDiskFreeSpaceExW`,
POSIX `statvfs`) unless Phase 1 assessment shows a maintained cross-platform
crate is preferable. No dependency is committed before checking release age and
maintenance status.

## 7. Model directory management

Portable mode defaults to `<exe>/models`; download state lives next to the
portable installation; external directories require explicit selection; there
is never a silent fallback to AppData in portable mode.

Before accepting any directory: create/access check, temp-file write test,
free-space query, reject regular files, reject incomplete application
installations, recognize existing model data.

Settings provide Model storage: current directory, installed bundles, space
used, active bundle, change location, verify files, remove inactive bundles.
A move stops job admission, waits for queue idle, copies across volumes,
verifies copies, activates the target, restarts the server, and deletes the
source only after successful activation and explicit confirmation. Configuration
is not updated until the target passes verification.

## 8. Existing installation migration

Launch-time discovery compares configured model files against every catalog
bundle: complete recognized q4/q8/f16, incomplete recognized, unknown files, or
none.

Adoption is lazy: names and sizes are checked immediately; SHA-256 hashing runs
once in the background and the result is stored. A previously working legacy
installation remains usable during hashing, labelled "Verifying existing
models"; it is registered as a managed verified bundle only after hashing
finishes. Hashing runs once during adoption, never on every launch.

Incomplete legacy directories offer download-missing, choose-another-location,
or remove-incomplete-files. Unknown or modified files are left untouched; the
user chooses another directory, a managed subdirectory, or rechecks after
correcting them.

## 9. Downloading, installing, activating, removing

These four states are distinct. A user may download Q8 while generating with
Q4. Queue-idle gating applies **only** to activation, directory movement, and
active-bundle removal - never to ordinary background downloads.

Activation sequence: prevent new job admission, confirm queue idle, stop the
server, update active bundle configuration, start the server pointed at the
verified leaf directory, confirm health, re-enable admission. For the first
version, activation correctness is proven by manager-side hash verification,
the exact `--models` argument, successful `/health`, and the recorded active
bundle - no richer native endpoint required. A later observability improvement
may add a diagnostic endpoint reporting the resolved model directory and server
version, but it is not a blocker.

If startup fails: restore previous bundle configuration, restart on the
previous bundle, keep the new bundle installed but inactive, show the error.

## 10. Settings experience

Model quality section listing the three bundles with state (installed+active /
not installed / downloading), Verify for active, Use-this-bundle and Remove for
inactive, progress with Pause and Cancel for downloads. Technical file details
behind a disclosure.

## 11. Installer changes

Installers ship the application, native runtime, and required libraries - no
model weights. Documentation states the app is a small initial download with a
6.5–16.5 GB first-launch choice. Old installer behavior remains available for at
least one transition release.

## 12. Offline and advanced installation

Documented manual placement: scan a directory, verify against the catalog,
register, activate. Manual registration uses the same checksum verification as
an in-app download.

## 13. Update policy

No redownload on restart or Settings visits. Downloads happen only for new
bundles, missing files, corruption recovery, or explicit revision updates.
Update prompts show current/new revision, size, reusable files, compatibility
notes, and require an explicit action. No silent tracking of upstream latest.

## 14. Error handling

Every failure maps to a specific recovery action: network loss preserves
progress with Resume; restart recovers partials; disk-full pauses with shortfall;
permission errors offer another location; checksum mismatch retries up to the
bounded cap then asks; remote-changed files are rejected against the pinned
manifest; activation failure rolls back; disconnected drives explain themselves;
unrecognized files stay untouched; cancellation removes only that download's
partials. Logs carry technical detail; user messages stay plain.

## 15. Verification strategy

Rust unit tests: catalog parsing/validation, unknown versions, duplicate paths,
unsafe relative paths, size calculation, existing-file recognition, hash
verification, partial-state parsing, range handling, ignored Range responses,
cancellation, disk-full, commit markers, activation rollback, directory locking.

UI tests: first launch, recommendations, each bundle choice, location change,
pause/resume, restart recovery, verification progress, errors, switching,
active-bundle removal prevention, pluralization/accessibility.

Integration tests: local HTTP server with slow/range/dropped/mismatched/
wrong-length/no-Range/etag-changing/error responses.

Manual scenarios: clean NVIDIA/Vulkan/CPU installs, second internal drive,
removable drive, kill during each phase, restart during verification, disk
full, read-only destination, legacy adoption Q4/Q8/F16, Q4→Q8 switch, failed
activation rollback, inactive removal, generation at 512/1024/1536 per bundle.

## 16. Delivery phases

- **Phase 1 - catalog and detection**: catalog format, pinned revision with
  recorded sizes and SHA-256 values, bundle scanning, legacy recognition,
  free-space detection, modelsRoot/activeBundle config evolution.
  Outcome: accurate explanation of installed vs missing.
- **Phase 2 - native download engine**: streaming, partial persistence,
  pause/resume/cancel/verification, locking, progress events.
- **Phase 3 - first-launch setup**: setup state, hardware recommendations,
  bundle/location selection, progress and recovery, server start after
  activation only.
- **Phase 4 - settings management**: bundle list, additional downloads,
  safe switching, verify/remove, directory move.
- **Phase 5 - installer simplification**: slim installers, documentation,
  preserved advanced/offline path, upgrade testing.
- **Phase 6 - quality validation**: Q4/Q8/F16 benchmarks, recommendation
  validation, interruption/storage-failure scenarios.

Frontend ownership: first-run setup and model management live in dedicated
modules (`model-catalog.ts`, `model-manager.ts`, `model-setup.ts`,
`model-settings.ts`, `model-download-state.ts`), following existing conventions;
they must not grow `main.ts`.

## 17. Explicit non-goals for the first release

No 512-only bundle, community repositories, background auto-updates, P2P,
network model directories, content-addressed deduplication, automatic deletion
of old bundles, silent migration, per-file selection. Reconsider after the basic
manager proves reliable.

Minimum complete scope: three full bundles, first-launch selection, hardware
and storage recommendation, configurable storage, verified resumable downloads,
restart recovery, existing-weight adoption, safe switching, Settings management,
slim installers, explicit pinned updates.

## 18. Implementation status and validation record

Automated validation (2026-08-25):

- Rust: `cargo test` - 72 passed, 0 failed; `cargo clippy` clean.
- Frontend: `tsc --noEmit` + vite build clean; unit tests 8/8.

Implemented:

- Phase 1: pinned catalog (`app/src-tauri/catalog/model-catalog.json`,
  revision `a57397bd…` with per-file SHA-256), catalog validation, managed +
  legacy scanning, free-space via platform APIs, modelsRoot/activeBundle config
  evolution (`models.rs`, `config.rs`).
- Phase 2: streaming resumable downloads with pause/cancel, bounded retries,
  ETag-validated resume, truncate-on-ignored-Range, atomic commits, directory
  lock, progress events, activation with queue-idle gating and rollback,
  inactive-bundle removal, partial-download recovery commands (`downloader.rs`).
- Phases 3–4: frontend modules `model-catalog.ts`, `model-download-state.ts`,
  `model-manager.ts`, `model-setup.ts` (first-launch setup section),
  `model-settings.ts` (Settings → Storage model management).
- Phase 5: installers download no weights by default; legacy behavior behind
  `-IncludeModels` / `--include-models`; docs updated.

Remaining manual scenarios (require real GPU + bandwidth; see §15): clean
NVIDIA/Vulkan/CPU installs, second/removable drive storage, kill during each
download phase, restart during verification, disk full, read-only destination,
legacy adoption for all three quanta, Q4→Q8 switch, failed-activation rollback,
inactive removal, generation at 512/1024/1536 per bundle, Q4/Q8/F16 output
benchmarks to validate the recommendation tiers and "Full precision" naming.

Deferred by design: background lazy hashing of legacy installs is invoked via
the explicit verify/adopt actions; a fully automatic background pass can be
added when first-launch telemetry justifies it.
