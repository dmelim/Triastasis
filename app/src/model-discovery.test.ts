import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import type { ModelsScan } from "./model-catalog";
import { localCatalogBundle, modelStorageBytes } from "./model-discovery";
import { effectiveActiveBundleId, defaultInstalledBundleId } from "./model-setup";

function fixture(): ModelsScan {
  return { modelsRoot: "C:/new-empty-downloads", modelsDir: "C:/existing", portable: false,
    activeBundle: "custom-local", managed: [], custom: null, legacy: null, freeBytes: null, catalogVersion: 1, modelRevision: "synthetic",
    local: [
      { bundleId: "q4", dir: "C:/existing", active: true, verified: false, totalBytes: 6400000000 },
      { bundleId: "q8", dir: "C:/existing/installed/rev/q8", active: false, verified: true, totalBytes: 10000000000 },
    ] };
}

test("recognized active Q4 survives a different download root and recommended Q8", () => {
  const scan = fixture();
  scan.managed = [{ bundleId: "q8", quantization: "q8", dir: "C:/new-empty-downloads/installed/q8", registered: true, sizedFiles: 10, totalFiles: 10 }];
  assert.equal(effectiveActiveBundleId(scan), "q4");
  assert.equal(defaultInstalledBundleId(scan, "q8", true), null);
  assert.equal(defaultInstalledBundleId(scan, "q8"), null);
  scan.managed.push({ bundleId: "q4", quantization: "q4", dir: "C:/other-copy", registered: true, sizedFiles: 10, totalFiles: 10 });
  assert.equal(defaultInstalledBundleId(scan, "q8", true), null, "a different managed Q4 copy must not override the selected local directory");
});

test("the selected copy takes precedence over another verified copy of its tier", () => {
  const scan = fixture();
  scan.local!.unshift({ bundleId: "q4", dir: "C:/other", active: false, verified: true, totalBytes: 6400000000 });
  assert.equal(localCatalogBundle(scan, "q4")?.dir, "C:/existing");
});

test("storage includes discovered and genuine custom files, with actual managed byte counts", () => {
  const scan = fixture();
  scan.managed = [{ bundleId: "partial", quantization: "q8", dir: "C:/partial", registered: false, sizedFiles: 1, totalFiles: 10, totalBytes: 10 }];
  scan.custom = { bundleId: "custom-local", dir: "C:/unknown", available: true, ggufFiles: 1, error: null, totalBytes: 7 };
  assert.equal(modelStorageBytes(scan, []), 16400000017);
});

test("storage does not count a remembered Windows directory twice", () => {
  const scan = fixture();
  scan.custom = { bundleId: "custom-local", dir: "\\\\?\\c:\\EXISTING\\", available: true, ggufFiles: 10, error: null, totalBytes: 6400000000 };
  assert.equal(modelStorageBytes(scan, []), 16400000000);
});

async function storageRenderer(scan: ModelsScan, kind = "idle", scanModels = async () => scan) {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/model-settings.ts"), "utf8");
  const start = source.indexOf("export async function renderModelStorage(");
  const body = source.slice(start, source.indexOf("\n}", start) + 2).replace("export ", "");
  const escapeStart = source.indexOf("function escapeHtml(");
  const escaping = source.slice(escapeStart, source.indexOf("\n}", escapeStart) + 2);
  const catalog = [
    { id: "q4", displayName: "Starter", quantization: "q4", fileCount: 10, totalBytes: 6400000000 },
    { id: "q8", displayName: "Recommended", quantization: "q8", fileCount: 10, totalBytes: 10000000000 },
  ];
  const deps = { scanModels, storageRenderRequests: new WeakMap(), modelDownloadSnapshot: () => ({ catalog, progress: null, partial: [] }),
    modelMaintenanceSnapshot: () => ({ kind, bundleId: kind === "idle" ? null : "q4" }), availableBytes: async () => 1e11,
    modelStorageBytes, localCatalogBundle, formatGigabytes: (n: number) => `${(n / 1e9).toFixed(1)} GB`,
    curatedModelTermsHtml: () => "", bindCuratedModelTerms: () => {}, storageMessageHtml: () => "",
    pendingCustomDirectory: null };
  const code = (await transform(escaping + "\n" + body + "\nreturn renderModelStorage;", { loader: "ts", target: "es2022" })).code;
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}

async function storageHtml(scan: ModelsScan, kind = "idle") {
  const render = await storageRenderer(scan, kind);
  const container = { innerHTML: "", querySelectorAll: () => [] };
  await render(container);
  return container.innerHTML;
}

test("settings presents existing tiers without fake custom warnings, removal or redownload", async () => {
  const html = await storageHtml(fixture());
  assert.match(html, /Starter.*Active/s);
  assert.match(html, /Catalog bundle found; verification required/);
  assert.match(html, /Verified catalog files/);
  assert.match(html, /16\.4 GB/);
  assert.match(html, /data-act="verify-local"/);
  assert.match(html, /data-act="use-local" data-id="q8"/);
  assert.doesNotMatch(html, /Unverified custom bundle|Not installed|data-act="remove"|data-act="download"/);
});

test("verification has an accurate busy state and prevents conflicting actions", async () => {
  const html = await storageHtml(fixture(), "verifying");
  assert.match(html, /Verifying Starter/);
  assert.match(html, /button disabled[^>]*data-act="verify-local"/);
});

test("a delayed pre-verification scan cannot overwrite newer verified state", async () => {
  const old = fixture(); const current = fixture(); current.local![0].verified = true;
  let resolve!: (value: ModelsScan) => void;
  const delayed = new Promise<ModelsScan>((done) => { resolve = done; });
  let calls = 0;
  const render = await storageRenderer(current, "idle", () => ++calls === 1 ? delayed : Promise.resolve(current));
  const container = { innerHTML: "", querySelectorAll: () => [] };
  const pending = render(container);
  await render(container);
  const newest = container.innerHTML;
  resolve(old); await pending;
  assert.equal(container.innerHTML, newest);
  assert.doesNotMatch(container.innerHTML, /verification required/);
});
