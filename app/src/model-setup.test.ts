import test from "node:test";
import assert from "node:assert/strict";
import { installedBundleIds, needsSetup, shouldShowSetup } from "./model-setup";
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
