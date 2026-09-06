import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Fixture { native: unknown[]; legacy: unknown[]; migrated: boolean; fail: boolean; writes: number }
let serial = 0;
function request(result: unknown) {
  const req: { result: unknown; onsuccess?: () => void } = { result };
  queueMicrotask(() => req.onsuccess?.()); return req;
}
function record(label: string) { return { id: "same", versionId: "same", assetId: "asset", label, name: "input.png", ts: 1, createdAt: 1, params: {}, input: new Blob(["image"]), glb: new Blob(["model"]), thumb: null, operation: "generated", operationParams: {} }; }
async function store(fixture: Fixture): Promise<typeof import("./store")> {
  Object.assign(globalThis, { fixture, indexedDB: { open() { return request({ transaction() { return { objectStore() { return { getAll() { return request(fixture.legacy); } }; } }; } }); } } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const result = await build({
    entryPoints: [path.join(root, "store.ts")], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
      name: "synthetic-storage", setup(builder) {
        builder.onResolve({ filter: /^\.\/(native-gallery|tauri)$/ }, (args) => ({ path: args.path, namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          loader: "js", contents: args.path.endsWith("tauri") ? "export function isTauri(){return true;}" : `export async function loadNativeRecord(id){return globalThis.fixture.native.find(record=>record.id===id);}
export async function loadNativeGallery(){return globalThis.fixture.native;}
export async function nativeMigrationWasCompleted(){return globalThis.fixture.migrated;}
export async function writeNativeRecord(){globalThis.fixture.writes++; if(globalThis.fixture.fail) throw new Error('synthetic write failure');}
export async function updateNativeMetadata(){if(globalThis.fixture.fail) throw new Error('synthetic write failure');}
export function nativeGalleryRecoveryCount(){return 0;}
export async function markNativeMigrationCompleted(){}
export async function clearNativeGallery(){}
export async function deleteNativeRecords(){}` }));
      }
    }]
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text + "\n//" + serial++).toString("base64"));
}

test("a failed derived save rejects, retains the parent, and does not publish an unsaved child", async () => {
  const fixture = { native: [record("parent")], legacy: [], migrated: true, fail: true, writes: 0 };
  const api = await store(fixture);
  const warn = console.warn; console.warn = () => { };
  try {
    await assert.rejects(api.createDerivedVersion("same", { glb: new Blob(["edited"]) }), /Could not save/);
    assert.equal((await api.all()).length, 1);
    assert.equal((await api.get("same"))?.label, "parent");
    fixture.fail = false;
    const child = await api.createDerivedVersion("same", { glb: new Blob(["edited"]) });
    assert.equal(child.parentVersionId, "same");
  } finally { console.warn = warn; }
});
test("generation fallback is explicit and keeps the result available for emergency export", async () => {
  const api = await store({ native: [], legacy: [], migrated: true, fail: true, writes: 0 });
  const warn = console.warn; console.warn = () => { };
  try { assert.equal((await api.put(record("generated"))).persisted, false); assert.equal((await api.all()).length, 1); assert.equal(api.versionNeedsMemoryExport("same"), true); }
  finally { console.warn = warn; }
});
test("resuming migration preserves native edits when the legacy copy has the same ID", async () => {
  const fixture = { native: [record("new native")], legacy: [record("old legacy")], migrated: false, fail: false, writes: 0 };
  const api = await store(fixture);
  assert.equal((await api.all())[0].label, "new native");
  assert.equal(fixture.writes, 0);
});


test("concurrent rename and favourite preserve both updates in the session cache", async () => {
  const api = await store({ native: [record("original")], legacy: [], migrated: true, fail: false, writes: 0 });
  await Promise.all([api.renameVersion("same", "renamed"), api.setVersionFavorite("same", true)]);
  const updated = await api.get("same");
  assert.equal(updated?.label, "renamed");
  assert.equal(updated?.favorite, true);
});
