# Trellis Studio

Desktop app (Tauri v2) for local image→3D generation with
[trellis.cpp](../). It wraps the resident `trellis-server`, drives the
image→3D pipeline, and previews the result in an interactive
`<model-viewer>` (three.js) viewer with a locally-persisted gallery.

For end users: see [`docs/getting-started.md`](../docs/getting-started.md) — you
don't need this directory unless you're developing the app.

## Architecture

```
src/            web UI (Vite + TypeScript, framework-free)
  api.ts        POST /generate, GET /health against trellis-server
  viewer.ts     <model-viewer> wrapper (vendored in public/vendor)
  store.ts      gallery API + one-time legacy IndexedDB migration
  native-gallery.ts  Tauri app-local gallery (input + GLB + thumbnail blobs)
  config.ts     resolves server host/port/models (Tauri command or localStorage)
  settings.ts   models dir / gpu / port panel
  main.ts       wires the generate flow, gallery, status polling
src-tauri/      Rust shell
  src/server.rs     spawns & supervises `trellis-server`, forwards stdout as
                    `server-log` events, kills it on explicit app exit
  src/tray.rs       keeps the server + serial automation API resident while the
                    window is hidden; exposes live status and lifecycle actions
  src/automation.rs loopback-only queued API with stable job IDs and job assets
  src/config.rs     reads/writes <config_dir>/trellis-studio/config.json
  src/main.rs       Tauri builder + commands (get_config/save_config/restart_server)
```

The app is **backend-agnostic and small**: it does *not* bundle the server or the
16.5 GB of weights. The `install/` scripts place those in a per-user data dir and
write `config.json`; the app reads it, launches the server, and connects. The same
web UI also runs in a plain browser against a manually-started server.

Closing the desktop window hides it to the system tray so the native server and
automation API remain available to the Trellis skill. Reopen it from the tray;
the tray status shows live queue activity. Restart and Quit are guarded while a
generation is running or queued. A second launch reuses the existing instance
and focuses its window.

## Develop

```bash
npm install
npm run tauri:dev      # desktop app with stable-origin automatic reload
# or, browser-only UI (point it at a running trellis-server via Settings):
npm run dev
```

Desktop development serves embedded files on the stable `tauri.localhost`
origin. The launcher completes an initial frontend build before Tauri compiles;
Vite then rebuilds into `dist` on source changes and Tauri's file watcher
restarts the window. That origin can access and migrate galleries created by
older versions. Gallery data then lives under Tauri's app-local data directory,
outside the webview origin; the old IndexedDB remains untouched as a rollback
copy.

Requires Node 20+, a Rust toolchain, and the Tauri v2 Linux deps
(`libwebkit2gtk-4.1-dev` etc. — see `.github/workflows/release.yml`).

## Build

```bash
npm run tauri build    # produces .deb + .AppImage (Linux) / NSIS setup .exe (Windows)
```

CI (`.github/workflows/release.yml`, `studio` job) publishes these to each release
as `trellis-studio-linux-x86_64.AppImage`, `trellis-studio-linux-amd64.deb`, and
`trellis-studio-windows-x64-setup.exe`, which the installers fetch by name.
