import assert from "node:assert/strict";
import { test } from "node:test";

import { SWEEP_MAX_CANDIDATES, SWEEP_MIN_CANDIDATES, createSweepSeeds } from "./sweep-seeds";
import { GEN_PARAM_LIMITS } from "./types";

test("seed 0 is a valid first candidate", () => {
  assert.deepEqual(createSweepSeeds(0, 4), [0, 1, 2, 3]);
});

test("a normal sweep produces consecutive seeds", () => {
  assert.deepEqual(createSweepSeeds(42, 3), [42, 43, 44]);
});

test("a sweep may end exactly at the maximum seed", () => {
  const max = GEN_PARAM_LIMITS.seed.max;
  const seeds = createSweepSeeds(max - 1, 2);
  assert.deepEqual(seeds, [max - 1, max]);
});

test("overflow by exactly one candidate is rejected", () => {
  const max = GEN_PARAM_LIMITS.seed.max;
  assert.throws(
    () => createSweepSeeds(max, 2),
    /would exceed the maximum seed/,
  );
});

test("overflow by several candidates is rejected with the highest valid start", () => {
  try {
    createSweepSeeds(GEN_PARAM_LIMITS.seed.max - 2, 8);
    assert.fail("expected rejection");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /starting seed of (\d+) or lower/);
    const stated = Number(message.match(/starting seed of (\d+)/)![1]);
    assert.equal(stated + 7, GEN_PARAM_LIMITS.seed.max);
  }
});

test("negative, fractional, and non-finite seeds are rejected", () => {
  for (const bad of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createSweepSeeds(bad, 4), /Starting seed must be/, `seed ${bad}`);
  }
});

test("seeds above the maximum are rejected", () => {
  assert.throws(() => createSweepSeeds(GEN_PARAM_LIMITS.seed.max + 1, 2), /Starting seed must be/);
});

test("candidate counts outside the supported range are rejected", () => {
  for (const count of [SWEEP_MIN_CANDIDATES - 1, SWEEP_MAX_CANDIDATES + 1, 0, -3, 2.5]) {
    assert.throws(
      () => createSweepSeeds(42, count),
      /A sweep needs between/,
      `count ${count}`,
    );
  }
});
