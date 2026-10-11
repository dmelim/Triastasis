import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadProgressHtml } from "./download-progress-view";
import { renderModelDownloadProgress } from "./model-setup";
import { startingDownloadProgress } from "./model-download-state";
import { runtimeProgressViewState } from "./runtime-progress-view";

test("model progress uses its actual bundle fraction, without inline width styles", () => {
  const html = renderModelDownloadProgress({ ...startingDownloadProgress("test", 1000), state: "downloading", totalBytesDone: 30, fileName: "test.gguf" });
  assert.match(html, /<progress[^>]*value="0.03"/);
  assert.match(html, /data-download-summary>3%/);
  assert.doesNotMatch(html, /style=/);
});

test("runtime and model downloads share the same progress markup", () => {
  const runtime = runtimeProgressViewState({ phase: "download", downloaded: 33, total: 100 });
  const html = downloadProgressHtml(runtime, "Runtime download progress");
  assert.match(html, /class="model-progress"/);
  assert.match(html, /<progress[^>]*value="0.33"/);
  assert.match(html, /data-download-summary>33%/);
});

test("zero, completed, unknown and verification progress remain distinct", () => {
  const render = (fraction: number | null) => downloadProgressHtml({ fraction, summary: "", detail: "" }, "Download");
  assert.match(render(0), /value="0"/);
  assert.match(render(1.2), /value="1"/);
  assert.doesNotMatch(render(null), / value=/);
  assert.doesNotMatch(render(NaN), / value=/);
  assert.doesNotMatch(downloadProgressHtml(runtimeProgressViewState({ phase: "verify", downloaded: 100, total: 100 }), "Download"), / value=/);
  const unpacking = runtimeProgressViewState({ phase: "extract", downloaded: 0, total: 0 });
  assert.equal(unpacking.fraction, null);
  assert.match(unpacking.summary, /Unpacking/);
  assert.doesNotMatch(renderModelDownloadProgress({ ...startingDownloadProgress("test", 100), state: "verifying", totalBytesDone: 100 }), / value=/);
});

test("download filenames are escaped and runtime speed and remaining time use real byte counts", () => {
  assert.doesNotMatch(downloadProgressHtml({ fraction: 0, summary: "<script>", detail: '<img src="x">' }, "Download"), /<script>|<img/);
  const state = runtimeProgressViewState({ phase: "download", downloaded: 250_000_000, total: 1_000_000_000 }, 10_000_000);
  assert.equal(state.summary, "25%, 10.0 MB/s, 1m 15s remaining");
  assert.equal(state.detail, "250 MB of 1,000 MB");
});

test("runtime subscribes before starting and cleans up after success and failure", async () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/runtime-progress-view.ts");
  const bundle = await build({ entryPoints: [source], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
    name: "synthetic-runtime-events",
    setup(api) {
      api.onResolve({ filter: /^\.\/runtime-manager$/ }, () => ({ path: "runtime-manager", namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export function onRuntimeProgress(handler){ return globalThis.progressFixture.subscribe(handler); }", loader: "js" }));
    },
  }] });
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as typeof import("./runtime-progress-view");
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const bar = { value: -1, removeAttribute() { this.value = -1; } };
  const summary = { textContent: "" };
  const detail = { textContent: "" };
  let removed = 0;
  const root = { querySelector(selector: string) { return selector === "progress" ? bar : selector === "[data-download-summary]" ? summary : detail; }, remove() { removed++; } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ innerHTML: "", firstElementChild: root }) } });
  const container = { append() {} } as unknown as HTMLElement;
  let handler!: (payload: { phase: "download"; downloaded: number; total: number }) => void;
  let ready!: () => void;
  let stopped = 0;
  const fixture = { subscribe(callback: typeof handler) { handler = callback; return new Promise<() => void>((resolve) => { ready = () => resolve(() => { stopped++; }); }); } };
  Object.assign(globalThis, { progressFixture: fixture });
  try {
    for (const fail of [false, true]) {
      let started = false;
      const action = runtime.withRuntimeProgress(container, async () => {
        started = true;
        handler({ phase: "download", downloaded: 3, total: 100 });
        assert.equal(bar.value, 0.03, "the first event reaches the displayed bar");
        if (fail) throw new Error("synthetic network failure");
        return "installed";
      });
      assert.equal(started, false);
      ready();
      if (fail) await assert.rejects(action, /synthetic network failure/);
      else assert.equal(await action, "installed");
    }
    assert.equal(stopped, 2);
    assert.equal(removed, 2);
    Object.assign(fixture, { subscribe: () => Promise.reject(new Error("synthetic listener failure")) });
    let started = false;
    await assert.rejects(runtime.withRuntimeProgress(container, async () => { started = true; }), /synthetic listener failure/);
    assert.equal(started, false, "do not begin a download when its progress listener failed");
    assert.equal(removed, 3);
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "progressFixture");
  }
});
