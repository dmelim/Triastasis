import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PARAMS } from "./types";

// Exercise the actual manifest writer with synthetic in-memory filesystem calls.
test("long source names retain distinct candidate and group manifest identities", async () => {
  const writes: Array<{dir: string; manifest: { model: string }; name: string}> = [];
  Object.assign(globalThis, { manifestFixture: { writes } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const result = await build({ entryPoints: [path.join(root, "generation-manifest.ts")], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "filesystem", setup(builder) {
    builder.onResolve({ filter: /^\.\/tauri$/ }, () => ({ path: "tauri", namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ loader: "js", contents: `
      export const isTauri=()=>true;
      export const saveToOutputDir=async(name)=>'C:/synthetic/'+name;
      export const writeGenerationManifest=async(dir,manifest,name)=>globalThis.manifestFixture.writes.push({dir,manifest,name});
      export const removeOutputFile=async()=>{};
      export const readGenerationManifest=async()=>{};` }));
  }}] });
  const api = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
  for (const groupId of ["sameprefix-group-one", "sameprefix-group-two"]) {
    const contexts = await api.prepareSweepManifests({base: "a".repeat(80), groupId, labelBase: "long name", params: DEFAULT_PARAMS, seeds: [0, 1, 2], sourceBlob: new Blob(["source"], {type:"image/png"})});
    assert.equal(contexts.length, 3);
  }
  assert.equal(writes.length, 6);
  assert.equal(new Set(writes.map(write => write.name)).size, 6);
  assert.equal(new Set(writes.map(write => write.manifest.model)).size, 6);
});
