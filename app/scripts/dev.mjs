import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync(".reload", { recursive: true });

// With `--no-dev-server`, Tauri embeds `dist` while compiling the debug shell.
// Build it before Tauri starts so the compiler can never capture an empty
// output directory on the first launch.
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is unavailable; start development with npm run tauri:dev");
}
const initialBuild = spawnSync(process.execPath, [npmExecPath, "run", "build"], {
  stdio: "inherit",
  env: process.env,
});
if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const tauriArgs = [
  "node_modules/@tauri-apps/cli/tauri.js",
  "dev",
  "--no-dev-server",
  "--additional-watch-folders",
  "../.reload",
];

const child = spawn(process.execPath, tauriArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
