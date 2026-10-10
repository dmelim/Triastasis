import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerationSeed, GenParamsValidationError } from "./types";

test("the seed input preserves zero and both integer boundaries", () => {
  for (const [input, expected] of [["0", 0], ["42", 42], ["4294967295", 4294967295], [" 43 ", 43], ["1e2", 100]] as const) {
    assert.equal(parseGenerationSeed(input), expected);
  }
});

test("fractional, missing, malformed and out-of-range seeds fail before generation", () => {
  for (const input of ["0.5", "42.9", "-0.5", "", " ", "42junk", "NaN", "Infinity", "-1", "4294967296"]) {
    assert.throws(() => parseGenerationSeed(input), (error: unknown) => error instanceof GenParamsValidationError && error.field === "seed", input);
  }
});

test("seed errors use readable wording", () => {
  assert.throws(() => parseGenerationSeed(" "), { message: "Enter a seed from 0 to 4294967295." });
  assert.throws(() => parseGenerationSeed("0.5"), { message: "Seed must be a whole number from 0 to 4294967295." });
  assert.throws(() => parseGenerationSeed("4294967296"), { message: "Seed must be a whole number from 0 to 4294967295." });
});
