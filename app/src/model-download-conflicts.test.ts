import assert from "node:assert/strict";
import test from "node:test";
import { markDownloadStarting, modelDownloadSnapshot, clearDownloadProgress } from "./model-download-state";
import { downloadBundle, setModelsRoot } from "./model-manager";

test("conflicting download and location changes fail without replacing current progress", async () => {
  markDownloadStarting("first");
  await assert.rejects(downloadBundle("second"), /current model download/);
  await assert.rejects(setModelsRoot("C:/synthetic/new-root"), /current model download/);
  assert.equal(modelDownloadSnapshot().progress?.bundleId, "first");
  assert.equal(modelDownloadSnapshot().progress?.state, "preparing");
  clearDownloadProgress("first");
});
