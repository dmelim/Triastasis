import test from "node:test";
import assert from "node:assert/strict";
import {
  bundleCanResume,
  bundleNeedsRegistration,
  defaultInstalledBundleId,
  effectiveActiveBundleId,
  installedBundleIds,
  needsSetup,
  nextOnboardingStep,
  previousOnboardingStep,
  shouldShowSetup,
  startBlockedReason,
} from "./model-setup";
import type { ModelsScan } from "./model-catalog";

function scan(overrides: Partial<ModelsScan> = {}): ModelsScan {
  return {
    modelsRoot: "C:/models",
    modelsDir: "C:/models/managed",
    portable: false,
    activeBundle: null,
    managed: [],
    custom: null,
    legacy: null,
    freeBytes: null,
    catalogVersion: 1,
    modelRevision: "test",
    ...overrides,
  };
}

test("setup is required when no usable model bundle exists", () => {
  assert.equal(needsSetup(scan()), true);
});

test("onboarding requires accepted credits before runtime setup", () => {
  assert.equal(nextOnboardingStep("welcome", false, false), "credits");
  assert.equal(nextOnboardingStep("credits", false, false), "credits");
  assert.equal(nextOnboardingStep("credits", true, false), "runtime");
  assert.equal(nextOnboardingStep("runtime", true, false), "runtime");
  assert.equal(nextOnboardingStep("runtime", true, true), "models");
  assert.equal(previousOnboardingStep("models"), "runtime");
  assert.equal(previousOnboardingStep("runtime"), "credits");
});

test("start readiness explains every blocked state", () => {
  assert.equal(startBlockedReason(scan(), false), "Finish runtime setup first.");
  assert.equal(
    startBlockedReason(scan(), true, "Activating Starter..."),
    "Activating Starter...",
  );
  assert.equal(
    startBlockedReason(scan(), true),
    "Download and activate a model bundle first.",
  );

  const ready = scan({
    activeBundle: "trellis2-q4",
    managed: [{
      bundleId: "trellis2-q4",
      quantization: "q4",
      dir: "C:/models/managed/trellis2-q4",
      registered: true,
      sizedFiles: 10,
      totalFiles: 10,
    }],
  });
  assert.equal(startBlockedReason(ready, true), null);
});

test("an active registered bundle opens the normal app", () => {
  const value = scan({
    activeBundle: "trellis2-q8",
    managed: [{
      bundleId: "trellis2-q8",
      quantization: "q8",
      dir: "C:/models/managed/trellis2-q8",
      registered: true,
      sizedFiles: 10,
      totalFiles: 10,
    }],
  });
  assert.equal(needsSetup(value), false);
  assert.deepEqual(installedBundleIds(value), []);
});

test("registered inactive bundles are offered directly", () => {
  const value = scan({
    managed: [
      {
        bundleId: "trellis2-q4",
        quantization: "q4",
        dir: "C:/models/managed/trellis2-q4",
        registered: true,
        sizedFiles: 10,
        totalFiles: 10,
      },
      {
        bundleId: "trellis2-q8",
        quantization: "q8",
        dir: "C:/models/managed/trellis2-q8",
        registered: false,
        sizedFiles: 4,
        totalFiles: 10,
      },
    ],
  });
  assert.deepEqual(installedBundleIds(value), ["trellis2-q4"]);
  assert.equal(needsSetup(value), true);
});

test("the sole installed bundle becomes the initial choice", () => {
  const value = scan({
    managed: [{
      bundleId: "trellis2-q4",
      quantization: "q4",
      dir: "C:/models/managed/trellis2-q4",
      registered: true,
      sizedFiles: 10,
      totalFiles: 10,
    }],
  });
  assert.equal(defaultInstalledBundleId(value, "trellis2-q8"), "trellis2-q4");
});

test("the recommended installed bundle becomes the initial choice", () => {
  const value = scan({
    managed: [
      {
        bundleId: "trellis2-q4",
        quantization: "q4",
        dir: "C:/models/managed/trellis2-q4",
        registered: true,
        sizedFiles: 10,
        totalFiles: 10,
      },
      {
        bundleId: "trellis2-q8",
        quantization: "q8",
        dir: "C:/models/managed/trellis2-q8",
        registered: true,
        sizedFiles: 10,
        totalFiles: 10,
      },
    ],
  });
  assert.equal(defaultInstalledBundleId(value, "trellis2-q8"), "trellis2-q8");
});

test("a valid active choice is preserved after initial onboarding", () => {
  const value = scan({
    activeBundle: "trellis2-q4",
    managed: [
      {
        bundleId: "trellis2-q4",
        quantization: "q4",
        dir: "C:/models/managed/trellis2-q4",
        registered: true,
        sizedFiles: 10,
        totalFiles: 10,
      },
      {
        bundleId: "trellis2-q8",
        quantization: "q8",
        dir: "C:/models/managed/trellis2-q8",
        registered: true,
        sizedFiles: 10,
        totalFiles: 10,
      },
    ],
  });
  assert.equal(effectiveActiveBundleId(value), "trellis2-q4");
  assert.equal(defaultInstalledBundleId(value, "trellis2-q8"), null);
  assert.equal(defaultInstalledBundleId(value, "trellis2-q8", true), "trellis2-q8");
});
test("complete managed files without a marker are offered for registration", () => {
  const value = scan({
    managed: [{
      bundleId: "trellis2-q8",
      quantization: "q8",
      dir: "C:/models/managed/trellis2-q8",
      registered: false,
      sizedFiles: 10,
      totalFiles: 10,
    }],
  });

  assert.equal(bundleNeedsRegistration(value, "trellis2-q8"), true);
  assert.equal(bundleNeedsRegistration(value, "trellis2-q4"), false);
  assert.equal(needsSetup(value), true);
});

test("incomplete managed files are not mistaken for a complete bundle", () => {
  const value = scan({
    managed: [{
      bundleId: "trellis2-q8",
      quantization: "q8",
      dir: "C:/models/managed/trellis2-q8",
      registered: false,
      sizedFiles: 9,
      totalFiles: 10,
    }],
  });

  assert.equal(bundleNeedsRegistration(value, "trellis2-q8"), false);
  assert.equal(bundleCanResume(value, "trellis2-q8"), true);
});

test("partial download files are offered for verification and resume", () => {
  assert.equal(bundleCanResume(scan(), "trellis2-q8", ["trellis2-q8"]), true);
  assert.equal(bundleCanResume(scan(), "trellis2-q4", ["trellis2-q8"]), false);
});
test("a complete legacy bundle opens the normal app", () => {
  const value = scan({
    legacy: {
      status: "completeUnverified",
      bundleId: "trellis2-q4",
      matchedFiles: 10,
      totalFiles: 10,
      unrecognizedFiles: 0,
    },
  });
  assert.equal(needsSetup(value), false);
  assert.equal(effectiveActiveBundleId(value), "trellis2-q4");
  assert.equal(defaultInstalledBundleId(value, "trellis2-q8"), null);
});
test("the welcome appears once even when a model is already usable", () => {
  const value = scan({
    legacy: {
      status: "completeUnverified",
      bundleId: "trellis2-q4",
      matchedFiles: 10,
      totalFiles: 10,
      unrecognizedFiles: 0,
    },
  });

  assert.equal(shouldShowSetup(value, false), true);
  assert.equal(shouldShowSetup(value, true), false);
});

test("model recovery reopens setup without repeating onboarding", () => {
  assert.equal(shouldShowSetup(scan(), true), true);
});

test("an available active custom folder opens the normal app", () => {
  const value = scan({
    activeBundle: "custom-local",
    custom: {
      bundleId: "custom-local",
      dir: "C:/models/custom",
      available: true,
      ggufFiles: 10,
      error: null,
    },
  });
  assert.equal(needsSetup(value), false);
});

test("a missing active custom folder reopens setup", () => {
  const value = scan({
    activeBundle: "custom-local",
    custom: {
      bundleId: "custom-local",
      dir: "C:/models/missing",
      available: false,
      ggufFiles: 0,
      error: "folder unavailable",
    },
  });
  assert.equal(needsSetup(value), true);
});
