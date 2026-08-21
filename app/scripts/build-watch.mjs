import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const reloadDirectory = resolve(".reload");
const reloadSignal = resolve(reloadDirectory, "frontend.trigger");
await mkdir(reloadDirectory, { recursive: true });
// Preserve the known-good initial build while the Tauri compiler reads it.
// Watch rebuilds update files in place instead of briefly removing index.html.
const watcher = await build({
  build: {
    emptyOutDir: false,
    watch: { exclude: [".reload/**"] },
  },
});

if (Array.isArray(watcher) || typeof watcher.on !== "function") {
  throw new Error("Vite did not return a build watcher");
}

let initialBuildComplete = false;
let signalWrite = Promise.resolve();
watcher.on("event", (event) => {
  if (event.code === "ERROR") {
    console.error(event.error);
    return;
  }
  if (event.code !== "END") return;
  // `build({ watch })` performs one build immediately. `dev.mjs` already
  // created those assets before Tauri started, so only later rebuilds need to
  // signal Tauri to re-embed the frontend.
  if (!initialBuildComplete) {
    initialBuildComplete = true;
    return;
  }
  signalWrite = signalWrite
    .then(() => writeFile(reloadSignal, `${Date.now()}\n`, "utf8"))
    .catch((error) => console.error("Could not signal Tauri frontend reload", error));
});
