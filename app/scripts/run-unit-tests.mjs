// Runs the TypeScript unit tests (node:test) by bundling with esbuild, which
// is already available as a Vite dependency. Usage: npm test
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const outDir = path.join(appRoot, ".test-out");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const testFiles = readdirSync(path.join(appRoot, "src")).filter((name) => name.endsWith(".test.ts"));
if (testFiles.length === 0) {
  console.error("no *.test.ts files found");
  process.exit(1);
}

let failed = false;
for (const file of testFiles) {
  const outfile = path.join(outDir, file.replace(/\.ts$/, ".mjs"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(appRoot, "node_modules", "esbuild", "bin", "esbuild"),
      path.join(appRoot, "src", file),
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--outfile=${outfile}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    failed = true;
    continue;
  }
  const run = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  if (run.status !== 0) failed = true;
}

rmSync(outDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
