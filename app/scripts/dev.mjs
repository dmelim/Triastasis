import net from "node:net";
import { spawn } from "node:child_process";

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(start, attempts = 50) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + attempts}`);
}

const preferred = Number(process.env.TRELLIS_DEV_PORT) || 1420;
const port = await findFreePort(preferred);

console.log(
  port === preferred
    ? `[dev] using port ${port}`
    : `[dev] port ${preferred} busy - using ${port} instead`,
);

const tauriConfig = JSON.stringify({
  build: { devUrl: `http://localhost:${port}` },
});
const tauriArgs = [
  "node_modules/@tauri-apps/cli/tauri.js",
  "dev",
  "--config",
  tauriConfig,
];

const child = spawn(process.execPath, tauriArgs, {
  stdio: "inherit",
  env: { ...process.env, TRELLIS_DEV_PORT: String(port) },
});

child.on("exit", (code) => process.exit(code ?? 0));
