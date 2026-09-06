# Library persistence and metadata updates

This describes the current development working tree, not a new published release.

## Asset bytes and recovery

The desktop Library remains under the app-owned gallery-v1 root. Each version
record keeps immutable storage revisions containing input.bin, model.glb, an
optional thumbnail, and metadata.json. Full writes commit metadata last and retain
a previous revision for recovery. Source and GLB bytes are unchanged by this work.

Renaming a version, changing its favourite state, or changing its asset label now
writes a small immutable snapshot under the loaded revision:

    metadata-updates/<sequence>/metadata.json

A snapshot contains label, favorite, and assetLabel (string or null). Readers use
the newest complete, valid snapshot and skip interrupted/invalid ones. Cleanup
retains the newest verified update and one valid fallback. A full version save
carries the effective metadata into the next full revision. Legacy fixed-layout
records support the same metadata snapshots without moving their blobs.

Both the TypeScript Library and Rust automation/export reader apply this metadata.
The Rust reader retains canonical containment and size checks. Older app versions
can still open the original asset bytes but ignore these metadata snapshots, so
recent names/favourites may appear older after a downgrade. Do not use downgrading
as a metadata migration method.

## Save outcomes

Store writes report whether persistence succeeded. Generation may retain a result
in memory after a failed write so the user can export it, but that is not a durable
save. Emergency export uses retained bytes when a Library version is only in memory.
Derived-version saving and metadata changes require confirmed persistence; failure
must not mark an edit copy clean or report a successful save.

Model edits, derived saves, imports, opening, and deletion are coordinated. Replacing
a dirty edit copy offers save/export, discard, or cancel. The previous edit scene
is retained until the replacement GLB has parsed successfully. Tab changes retain
the current edit copy.

## Regression checks

- Run npm test from app/ for interrupted writes, metadata-only updates, valid
  fallback retention, migration conflicts, failed saves, metadata concurrency,
  settings outcomes, and shared snapshot lifetimes.
- Run cargo test --manifest-path app/src-tauri/Cargo.toml library:: from the repo
  for the app-owned Rust reader and export tests.
- Run node --experimental-websocket scripts/check-ui.mjs from app/ for the optional
  headless Chromium checks. Set TRIASTASIS_TEST_BROWSER to a Chromium executable
  if Chrome is not installed in the default Windows location. The script creates
  only synthetic assets in an isolated profile under ignored target/ui-review
  output and injects test hooks only in its own Vite server.

The browser check covers typed transforms, save/cancel, invalid replacement,
candidate layout, real modal close handlers, and idle/hidden renderer behavior.
Packaged Windows installation, real GPU generation, and portable-mode acceptance
remain separate release checks. Do not test migrations with external scripts
against a user's live Library.


## Deferred desktop model loading

Desktop Library listing reads metadata and preview/source images, and checks that
model files exist without reading their GLB bytes. Listed records explicitly carry
a null GLB. Opening or exporting resolves the saved record through revision recovery
and loads its model on demand. Rename, favourite, and deletion do not load model
bytes. Full saves reject unloaded records. Resolved GLBs are not retained in the
Library cache; the active viewer retains its current model.

This removes bulk GLB reads at startup and during registration refresh. Source
images still load eagerly, and the browser-only IndexedDB fallback keeps its
existing record/blob storage. Parsing metadata and building the UI still run on
the JavaScript main thread; this is deferred loading, not a worker migration.

## App-owned recovery API

An old gallery-v1 tree can be scanned and recovered through the native automation
API using POST /library/recovery/scan and POST /library/recovery/recover. The skill's
triastasis_recover.py helper saves a scan report and submits selected missing IDs
with their source fingerprints. The backend chooses a readable revision, verifies
copied blobs, retains identity/lineage, reports conflicts, and preserves originals.
Duplicate means equal GLB and source bytes; destination metadata remains unchanged.
Recovery does not merge revision histories or overwrite conflicting records. Use a
pilot and verify it in the app before bulk recovery. See the skill API reference
for payloads, batch limits, and error semantics. No live user-data recovery was
performed while implementing this capability; regression tests use synthetic roots.
