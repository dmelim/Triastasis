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

## Filesystem copy and ACL safety

Treat Windows ACLs and other filesystem security metadata as part of any copy,
move, restore, or migration involving paths outside the repository workspace,
especially `%LOCALAPPDATA%`, other application-data directories, packaged-app
storage, and backups. Codex's sandboxed or brokered execution context can cause
destination objects to inherit capability ACLs that the consuming application
cannot use, even when file contents and SHA-256 hashes remain correct.

- Prefer an application-native import or a normal user process outside the Codex
  sandbox for runtime-data migration. Do not bulk-copy application data through
  the Codex sandbox without first proving that the destination ACLs are correct.
- Resolve and report the exact source, destination, copy-versus-move behavior,
  execution context, and whether security descriptors will be inherited or
  preserved before changing data.
- Preserve an untouched backup and capture the original SDDL for every target
  whose ACL may change.
- Test one record first. Compare content hashes and ACLs, then verify that the
  consuming application can enumerate and read it before expanding the scope.
- Never change a parent ACL that contains inheritable rules, or run recursive ACL
  normalization, without separate explicit approval. Windows may propagate a
  parent ACL change into child objects even when the command targets only the
  parent.
- If an ACL result differs from the plan, stop immediately. Restore only from the
  saved ACL snapshot, revalidate content hashes, and leave the backup untouched.
