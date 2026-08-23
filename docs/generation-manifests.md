# `.polyloom.json` generation manifests

Every Polyloom generation written to the output folder is accompanied by a
`<name>.polyloom.json` manifest: a self-describing record that allows the
generation to be re-imported, re-linked, or requeued later with its reference
image, settings, and lineage intact. The reconstruction-test harness emits the
same format.

## Schema (version 1)

```jsonc
{
  "schemaVersion": 1,
  "status": "completed",            // completed | interrupted | failed
  "label": "hero.png",
  "sourceImage": "hero_source.png", // relative paths only, see below
  "model": "hero_1024_seed42_job-1.glb",
  "cutout": null,
  "thumbnail": null,
  "log": null,
  "resolution": 1024,
  "seed": 42,
  "bgRemoval": "auto",
  "uv": "xatlas",
  "texture": true,
  "jobId": "job-1",
  "nativeRequestId": "req-0",
  "assetId": "job-1",               // original internal lineage; import
  "versionId": "job-1",             // always remaps these to fresh IDs
  "parentVersionId": null,
  "submittedAtUtc": "2026-08-21T12:00:00Z",
  "startedAtUtc": "2026-08-21T12:00:01Z",
  "finishedAtUtc": null,
  "durationSeconds": null,
  "polyloomVersion": "0.5.4",
  "serverVersion": null,
  "metrics": {
    "dimensions": { "x": 0.61, "y": 0.92, "z": 1.0 },
    "triangles": null,
    "fileSizeBytes": 5221024,
    "thinRatio": 0.61
  },
  "qualityWarning": null,
  "error": null,
  "files": [
    { "role": "sourceImage", "path": "hero_source.png", "sha256": "…" },
    { "role": "glb", "path": "hero_1024_seed42_job-1.glb", "sha256": "…" }
  ]
}
```

Unknown fields are ignored on read; missing optional fields default. A bumped
`schemaVersion` is rejected with a clear error rather than misread — older
files keep working because version 1 remains supported.

## Path rules

- All artifact paths are **relative to the manifest's own directory**.
- Absolute paths, rooted (`/x`, `\x`), drive (`C:`), and `..` components are
  rejected before any file access.
- Backslashes inside a component are normalized to `_`.
- Files that exist must stay **inside the directory after canonicalization**:
  a symlink or junction pointing outside is refused.
- Artifacts above 512 MB and manifests above 1 MB are refused.

## Moving a manifest directory

The whole directory can be moved or copied freely — all references are
relative. Moving only the manifest breaks its links; use the Relink flow in
the import preview instead.

## Import versus Open GLB

- **Import… / dropping a `.polyloom.json`**: validates hashes and formats,
  shows a preview, then creates a fresh asset + version with new internal IDs;
  the manifest's original IDs are preserved as provenance. Failed validation
  never creates a gallery record.
- **Open GLB… / dropping a `.glb`**: renders immediately without touching the
  gallery; a sibling manifest is offered via "Import linked generation".

## Relinking changed or missing files

The preview lists each problem file with a Relink control that copies the
picked replacement into the manifest directory under the recorded name and
recomputes its hash. Relinking **deliberately accepts new content**: it
replaces the recorded hash so future validation passes. That is an explicit
provenance change made through a visible action — silent hash drift still
shows up as `Modified since generation` everywhere else.

## Interrupted-generation recovery

A manifest is written when a job starts (status `interrupted`) so a crash
leaves a resumable record. On startup Polyloom lists interrupted generations;
Requeue re-runs them with the original seed and settings under a fresh request
ID, keeps the original asset/version lineage, waits out any orphaned native
request first (no duplicate GPU work), and updates the same manifest file when
the replacement finishes.

Valid lifecycle transitions:

```text
new → interrupted → completed | failed
interrupted → requeued(new request id) → completed | failed
```

A completed manifest never regresses to interrupted under ordinary viewing,
import, or reuse of a job id.

## Schema compatibility policy

- Version 1 is read indefinitely; additive unknown fields are ignored.
- Any breaking change bumps `schemaVersion`; old files stay readable by their
  matching reader and produce a clear unsupported-version error otherwise.
- The Rust structs (`src/manifest.rs`) and the TypeScript mirror
  (`app/src/types.ts`, `GenerationManifest`) must move together.
