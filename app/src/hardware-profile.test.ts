import assert from "node:assert/strict";
import test from "node:test";
import { recommendedMaxResolution, resolutionAllowed } from "./hardware-profile";

test("recommends 512 below 8 GB of VRAM", () => {
  assert.equal(recommendedMaxResolution(6144), 512);
  assert.equal(recommendedMaxResolution(null, -1), 512);
});

test("recommends 1024 from 8 GB through 15 GB and for unknown hardware", () => {
  assert.equal(recommendedMaxResolution(8192), 1024);
  assert.equal(recommendedMaxResolution(12288), 1024);
  assert.equal(recommendedMaxResolution(null), 1024);
});

test("recommends 1536 at 16 GB or more", () => {
  assert.equal(recommendedMaxResolution(16384), 1536);
  assert.equal(recommendedMaxResolution(24576), 1536);
});

test("the settings override permits resolutions above the recommendation", () => {
  const profile = {
    backend: "cuda",
    gpuIndex: 0,
    gpuName: "Test GPU",
    vramMb: 12288,
    recommendedMaxResolution: 1024 as const,
  };
  assert.equal(resolutionAllowed(1536, profile, false), false);
  assert.equal(resolutionAllowed(1536, profile, true), true);
});
