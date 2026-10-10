import assert from "node:assert/strict";
import test from "node:test";
import { runtimeDownloadError, runtimeNotice, runtimePresentation, runtimeProgressFraction, runtimeProgressLabel } from "./runtime-presentation";
import type { RuntimeStatus } from "./runtime-manager";
const current: RuntimeStatus = { installed: true, managed: true, version: "0.0.4", versionState: "current", releaseUrl: "https://github.com/dmelim/Triastasis/releases/tag/triastasis-v0.0.4", targetVersion: "0.0.4", updateAvailable: false, pendingVersion: null, pendingPath: null, backend: "cuda", path: "runtime/trellis-server.exe", portable: false, recommendedBackend: "cuda", recommendation: "" };

test("current and newer runtimes never offer replacement or a startup update notice", () => {
  for (const value of [current, { ...current, version: "0.0.5", versionState: "newer" as const }, { ...current, version: "0.0.5", versionState: "newer" as const, pendingVersion: "0.0.4" }]) {
    const presentation = runtimePresentation(value);
    assert.equal(presentation.downloadLabel, null);
    assert.equal(presentation.notice, null);
  }
});
test("known older managed runtime offers matching download and preserves models", () => {
  const presentation = runtimePresentation({ ...current, version: "0.0.3", versionState: "older", updateAvailable: true });
  assert.match(presentation.description, /older than Triastasis 0.0.4/);
  assert.equal(presentation.downloadLabel, "Download runtime 0.0.4");
  assert.match(presentation.nextStep, /model storage stays in place/);
  assert.match(presentation.notice!, /Settings > Runtime/);
});
test("unknown custom runtime provides release guidance without claiming it is older", () => {
  const presentation = runtimePresentation({ ...current, managed: false, version: null, versionState: "unknown" });
  assert.match(presentation.description, /could not be confirmed/);
  assert.doesNotMatch(presentation.notice!, /is older/);
  assert.match(presentation.notice!, /custom runtime has no version receipt/);
  assert.match(presentation.nextStep, /trellis-cuda-windows-x64.zip/);
  assert.match(presentation.nextStep, /custom binary path/);
  assert.equal(presentation.downloadLabel, null);
  assert.equal(presentation.showRelease, true);
});
test("custom runtime with a known backend can switch to the verified release", () => {
  const presentation = runtimePresentation({ ...current, managed: false, version: null, versionState: "unknown", updateAvailable: true });
  assert.equal(presentation.downloadLabel, "Switch to verified runtime 0.0.4");
  assert.match(presentation.description, /no version receipt/);
  assert.match(presentation.nextStep, /custom build stays on disk/);
  assert.match(presentation.notice!, /custom runtime has no version receipt/);
});
test("custom receipt is reported metadata rather than executable verification", () => {
  const presentation = runtimePresentation({ ...current, managed: false, version: "0.0.3", versionState: "older" });
  assert.match(presentation.description, /receipt reports version/);
  assert.equal(presentation.downloadLabel, null);
});
test("pending verified update requires deliberate quit and reopen", () => {
  const presentation = runtimePresentation({ ...current, version: "0.0.3", versionState: "older", pendingVersion: "0.0.4" });
  assert.match(presentation.description, /downloaded and verified/);
  assert.match(presentation.nextStep, /quit Triastasis from the system tray/);
  assert.equal(presentation.downloadLabel, null);
});
test("runtime progress reports size and percent, and steps without a size", () => {
  const downloading = { phase: "download" as const, downloaded: 312_000_000, total: 728_588_398 };
  assert.equal(runtimeProgressLabel(downloading), "Downloading runtime... 312 of 729 MB (42%)");
  assert.equal(runtimeProgressFraction({ ...downloading, total: 0 }), null);
  assert.equal(runtimeProgressLabel({ ...downloading, total: 0 }), "Downloading runtime... 312 MB");
  assert.equal(runtimeProgressFraction({ phase: "verify", downloaded: 0, total: 0 }), null);
  assert.match(runtimeProgressLabel({ phase: "extract", downloaded: 0, total: 0 }), /Unpacking/);
});
test("unpublished release assets give a concrete next action", () => {
  assert.match(runtimeDownloadError(new Error("download failed with HTTP 404"), "0.0.4"), /Open the matching release/);
  assert.equal(runtimeDownloadError(new Error("connection timeout"), "0.0.4"), "connection timeout");
});

test("notice changes from older to pending and disappears after activation, including dismissed older notice", () => {
  const older: RuntimeStatus = { ...current, version: "0.0.3", versionState: "older", updateAvailable: true };
  const oldNotice = runtimeNotice(older, null);
  assert.equal(runtimeNotice(older, oldNotice), null);
  const pending = { ...older, pendingVersion: "0.0.4", pendingPath: "runtime.pending" };
  const pendingNotice = runtimeNotice(pending, oldNotice);
  assert.match(pendingNotice!, /0.0.4 is ready/);
  assert.doesNotMatch(pendingNotice!, /is older/);
  assert.match(runtimePresentation(pending).nextStep, /Restart server only restarts the active runtime/);
  assert.equal(runtimeNotice(pending, pendingNotice), null);
  assert.equal(runtimeNotice(current, pendingNotice), null);
});
