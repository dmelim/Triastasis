# Triastasis Agent Notes

## Product focus and maintenance boundary

Triastasis's primary maintained product surface is the desktop application: its
frontend, 3D viewer, generation controls, editing workflows, usability, and the
clear communication of what the underlying model can and cannot do.

Treat the following areas as upstream-aligned infrastructure rather than places
for speculative Triastasis development:

- The native inference and mesh pipeline under `src/` and `include/`.
- The resident `trellis-server` protocol and command-line pipeline.
- The thin connection between the web app, Tauri shell, and native server,
  especially `app/src/api.ts`, `app/src/config.ts`, `app/src/tauri.ts`, and the
  server/configuration modules under `app/src-tauri/src/`.

Preserve those layers when possible and adopt relevant upstream fixes for them.
Do not refactor model internals or expand the bridge merely to make unrelated UI
work cleaner. If a product feature needs a capability the existing protocol does
not expose, first document the missing capability and prefer the smallest,
backward-compatible API or adapter change needed to surface it.

Frontend and viewer work may freely consume existing backend capabilities. When
exploring a requested feature, distinguish among:

- What can be implemented entirely in the app or viewer.
- What already exists in the native backend but is not exposed to the app.
- What would require a new backend capability or ongoing native maintenance.

The third category should be called out explicitly before implementation so the
user can decide whether its maintenance cost fits Triastasis's scope.

## Optional upstream synchronization reminder

Triastasis is a standalone derivative of `pwilkin/trellis.cpp`. The complete source
needed by the application lives in this repository; the upstream repository is
not a runtime dependency.

The Git remotes should be:

- `origin`: `https://github.com/dmelim/Triastasis.git`
- `upstream`: `https://github.com/pwilkin/trellis.cpp.git`

Do not fetch, merge, rebase, cherry-pick, commit, or push upstream changes as a
routine part of unrelated work. When the user asks for an upstream update, or an
upstream change is directly relevant to the task, use a dedicated integration
branch and review the update before adopting it:

```bash
git fetch upstream
git switch -c sync/upstream-<version-or-date>
git merge upstream/main
```

For isolated fixes, prefer reviewing and cherry-picking the specific upstream
commit instead of merging unrelated changes. After either approach, resolve
conflicts without discarding Triastasis changes and validate the backend, desktop
integration, generation workflow, and packaging before merging into `main`.

Record the upstream commit or release integrated by the sync. Security fixes and
critical backend corrections should be prioritized; unrelated upstream UI work
may be left out.

## Alpha release process

Use a hybrid release process for the first public alpha. Build and verify the
Tauri application locally, while GitHub Actions builds the backend-specific
native runtimes on clean Windows runners. Do not add broader release automation
unless a concrete failure makes it necessary.

- Keep the application version aligned in `app/package.json`,
  `app/package-lock.json`, `app/src-tauri/Cargo.toml`,
  `app/src-tauri/Cargo.lock`, and `app/src-tauri/tauri.conf.json`.
- Keep installer defaults, documentation, the GitHub release tag, and the
  version-derived runtime download URL aligned. For `0.0.1-alpha.1`, the tag is
  `triastasis-v0.0.1-alpha.1`.
- Before publishing, build the frontend, Rust application, NSIS installer, and
  portable ZIP locally from the intended release commit. Use an isolated Cargo
  target directory when validating a clean package build, and stage local test
  artifacts only under ignored build output such as
  `app/src-tauri/target/local-release/`.
- Generate a SHA-256 sidecar for every installer, portable package, and runtime
  archive. A sidecar contains the lowercase digest followed by two spaces and
  the exact artifact filename.
- Use `.github/workflows/release.yml` for the Vulkan, CUDA, CUDA 12
  compatibility, and experimental ROCm runtime archives. The workflow may also
  rebuild the desktop packages; that redundant clean build is desirable.
- Publish the version tag as a quiet GitHub prerelease and verify that the NSIS
  installer, portable ZIP, required runtime archives, and all checksum files are
  present. ROCm is experimental and is not a release blocker; Vulkan, CUDA, and
  CUDA 12 compatibility are required.
- Treat a clean Windows installation as the acceptance gate. Test installation,
  GPU recommendation, runtime and model download, restart persistence,
  generation, GLB export, portable mode when practical, and uninstall.
- Do not silently replace binaries after publication. Document minor alpha
  limitations, and use the next alpha version for a blocking shipped defect.
- Do not create or push commits, tags, or releases unless the user explicitly
  asks for those operations.

## Windows application-data migrations

Codex runs in a packaged Windows context. Writes to `%LOCALAPPDATA%` can be
redirected into Codex's package `LocalCache` even when commands report the
requested application path. Counts and hashes checked from the same context can
therefore validate the redirected copy instead of the real destination.

- Do not migrate another application's runtime data through a Codex-managed
  process. Use the application's import flow or a normal user-launched Explorer
  or terminal.
- Before reporting success, compare the final canonical paths of the destination
  root and one copied file, then verify the result in the consuming application.
- If a broad Tauri scope fails while an exact record scope works, compare
  canonical paths before changing scopes or ACLs. An exact scope can accidentally
  match a virtualized path. Keep production capabilities symbolic and general.
- Preserve an untouched backup, copy rather than move, stop on overwrite prompts,
  and verify a pilot plus hashes before expanding the copy.
- Treat ACL changes as a separate, explicitly approved repair. Snapshot original
  SDDL first and never use a generic recursive reset for this diagnosis.
- Keep gallery data, real record IDs, user paths, ACL audits, diagnostics, logs,
  and exports out of Git and release resources. Use synthetic test fixtures.
