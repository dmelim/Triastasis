import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MANIFEST_SCHEMA_VERSION,
  manifestRecordedParams,
  manifestStoresAdvancedSettings,
} from "./generation-manifest";
import { DEFAULT_PARAMS, GenParamsValidationError, normalizeGenParams } from "./types";
import type { GenerationManifest } from "./types";

function baseManifest(overrides: Partial<GenerationManifest> = {}): GenerationManifest {
  return {
    schemaVersion: 2,
    status: "interrupted",
    label: "Test",
    resolution: 1024,
    seed: 42,
    bgRemoval: "auto",
    uv: "xatlas",
    texture: true,
    ...overrides,
  };
}

test("schema 2 manifests record every advanced parameter", () => {
  const manifest = baseManifest({
    targetFaces: 250_000,
    atlasSize: 1_024,
    textureResolution: 512,
    remeshBand: 3,
    textureEncoding: "webp",
  });
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(manifestStoresAdvancedSettings(manifest), true);
  assert.deepEqual(normalizeGenParams(manifestRecordedParams(manifest)), {
    resolution: 1024,
    seed: 42,
    bgRemoval: "auto",
    uv: "xatlas",
    texture: true,
    targetFaces: 250_000,
    atlasSize: 1_024,
    textureResolution: 512,
    remeshBand: 3,
    textureEncoding: "webp",
  });
});

test("schema 1 manifests recover with documented advanced defaults", () => {
  const manifest = baseManifest();
  assert.equal(manifestStoresAdvancedSettings(manifest), false);
  const recovered = normalizeGenParams(manifestRecordedParams(manifest));
  // Recorded settings survive; only the unstored advanced fields default.
  assert.equal(recovered.seed, 42);
  assert.equal(recovered.targetFaces, DEFAULT_PARAMS.targetFaces);
  assert.equal(recovered.atlasSize, "auto");
  assert.equal(recovered.textureResolution, "auto");
  assert.equal(recovered.remeshBand, "auto");
  assert.equal(recovered.textureEncoding, "auto");
});

test("an invalid stored advanced value is rejected, not replaced", () => {
  const manifest = baseManifest({ targetFaces: 999 });
  assert.throws(() => normalizeGenParams(manifestRecordedParams(manifest)), (error) => {
    assert.ok(error instanceof GenParamsValidationError);
    assert.equal(error.field, "targetFaces");
    return true;
  });
});

test("recorded parameters survive a JSON round-trip like the Rust writer produces", () => {
  const manifest = baseManifest({
    targetFaces: "auto",
    atlasSize: "auto",
    textureResolution: "auto",
    remeshBand: "auto",
    textureEncoding: "png",
  });
  const revived = JSON.parse(JSON.stringify(manifest)) as GenerationManifest;
  assert.deepEqual(normalizeGenParams(manifestRecordedParams(revived)), normalizeGenParams({
    resolution: 1024,
    seed: 42,
    bgRemoval: "auto",
    uv: "xatlas",
    texture: true,
    textureEncoding: "png",
  }));
});
