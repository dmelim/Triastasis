import assert from "node:assert/strict";
import { test } from "node:test";

import { GENERATION_PRESETS, matchingGenerationPreset } from "./generation-presets";
import { normalizeGenParams } from "./types";

test("the existing recommended defaults match the medium preset", () => {
  assert.equal(matchingGenerationPreset(normalizeGenParams()), "medium");
});

test("each preset is detected from its production settings", () => {
  for (const preset of ["low", "medium", "high"] as const) {
    const params = normalizeGenParams({
      ...GENERATION_PRESETS[preset].settings,
      seed: 42,
    });
    assert.equal(matchingGenerationPreset(params), preset);
  }
});

test("seed changes do not turn a preset into custom settings", () => {
  const params = normalizeGenParams({
    ...GENERATION_PRESETS.high.settings,
    seed: 987654,
  });
  assert.equal(matchingGenerationPreset(params), "high");
});

test("high uses the stable cascade instead of the experimental 1536 path", () => {
  assert.equal(GENERATION_PRESETS.high.settings.resolution, 1024);
  assert.equal(GENERATION_PRESETS.high.settings.targetFaces, 500000);
  assert.equal(GENERATION_PRESETS.high.settings.atlasSize, 4096);
});

test("an advanced override produces custom settings", () => {
  const params = normalizeGenParams({
    ...GENERATION_PRESETS.medium.settings,
    bgRemoval: "threshold",
    seed: 42,
  });
  assert.equal(matchingGenerationPreset(params), null);
});

test("returning every advanced value to a preset detects it again", () => {
  const custom = normalizeGenParams({
    ...GENERATION_PRESETS.low.settings,
    atlasSize: 2048,
    seed: 42,
  });
  assert.equal(matchingGenerationPreset(custom), null);

  const restored = normalizeGenParams({
    ...GENERATION_PRESETS.low.settings,
    seed: custom.seed,
  });
  assert.equal(matchingGenerationPreset(restored), "low");
});
