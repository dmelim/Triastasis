import { GEN_PARAM_LIMITS } from "./types";

export const SWEEP_MIN_CANDIDATES = 2;
export const SWEEP_MAX_CANDIDATES = 8;

/**
 * Validates the sweep boundaries and returns the complete candidate seed
 * list. Seed 0 is a valid starting seed; the whole sweep must stay within
 * the shared seed range so no candidate can fail validation after the sweep
 * has started.
 */
export function createSweepSeeds(firstSeed: number, count: number): number[] {
  if (
    typeof firstSeed !== "number" ||
    !Number.isSafeInteger(firstSeed) ||
    firstSeed < GEN_PARAM_LIMITS.seed.min ||
    firstSeed > GEN_PARAM_LIMITS.seed.max
  ) {
    throw new Error(
      `Starting seed must be an integer between ${GEN_PARAM_LIMITS.seed.min} and ${GEN_PARAM_LIMITS.seed.max}`,
    );
  }
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < SWEEP_MIN_CANDIDATES ||
    count > SWEEP_MAX_CANDIDATES
  ) {
    throw new Error(
      `A sweep needs between ${SWEEP_MIN_CANDIDATES} and ${SWEEP_MAX_CANDIDATES} candidates`,
    );
  }
  if (firstSeed + count - 1 > GEN_PARAM_LIMITS.seed.max) {
    throw new Error(
      `This sweep would exceed the maximum seed. Choose a starting seed of ` +
        `${GEN_PARAM_LIMITS.seed.max - count + 1} or lower for ${count} candidates.`,
    );
  }
  return Array.from({ length: count }, (_, index) => firstSeed + index);
}
