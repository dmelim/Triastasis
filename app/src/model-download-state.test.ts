import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDownloadProgress,
  failedDownloadProgress,
  markDownloadStarting,
  modelDownloadSnapshot,
  startingDownloadProgress,
} from "./model-download-state";

test("starting progress gives immediate determinate bundle feedback", () => {
  const progress = startingDownloadProgress("trellis2-q8", 9_997_159_776);

  assert.equal(progress.bundleId, "trellis2-q8");
  assert.equal(progress.state, "preparing");
  assert.equal(progress.totalBytesDone, 0);
  assert.equal(progress.totalBytesTotal, 9_997_159_776);
  assert.equal(progress.error, null);
});

test("failed progress preserves completed bytes and exposes the reason", () => {
  const active = {
    ...startingDownloadProgress("trellis2-q8", 9_997_159_776),
    state: "downloading" as const,
    fileName: "birefnet.gguf",
    fileBytesDone: 882_749_024,
    fileBytesTotal: 882_749_024,
    totalBytesDone: 882_749_024,
    bytesPerSecond: 75_000_000,
    etaSeconds: 120,
  };

  const failed = failedDownloadProgress(active, "checksum verification failed");

  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "checksum verification failed");
  assert.equal(failed.totalBytesDone, active.totalBytesDone);
  assert.equal(failed.bytesPerSecond, 0);
  assert.equal(failed.etaSeconds, null);
});

test("stopping a failed download clears only that bundle's progress", () => {
  markDownloadStarting("trellis2-q8");
  clearDownloadProgress("trellis2-q4");
  assert.equal(modelDownloadSnapshot().progress?.bundleId, "trellis2-q8");

  clearDownloadProgress("trellis2-q8");
  assert.equal(modelDownloadSnapshot().progress, null);
});
