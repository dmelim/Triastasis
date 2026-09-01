import test from "node:test";
import assert from "node:assert/strict";
import { ensureServerReady } from "./server-startup";

const noDelay = async (): Promise<void> => {};

test("accepts a server that is already ready", async () => {
  let restarts = 0;
  const result = await ensureServerReady({
    health: async () => true,
    restart: async () => { restarts += 1; },
    delay: noDelay,
  });

  assert.deepEqual(result, { ready: true, restarted: false, error: null });
  assert.equal(restarts, 0);
});

test("allows the initial shell launch to become ready", async () => {
  let checks = 0;
  let restarts = 0;
  const result = await ensureServerReady({
    health: async () => ++checks >= 3,
    restart: async () => { restarts += 1; },
    delay: noDelay,
  });

  assert.equal(result.ready, true);
  assert.equal(result.restarted, false);
  assert.equal(restarts, 0);
});

test("restarts once when the initial launch stays offline", async () => {
  let restarted = false;
  const result = await ensureServerReady(
    {
      health: async () => restarted,
      restart: async () => { restarted = true; },
      delay: noDelay,
    },
    { initialChecks: 2, restartedChecks: 2 },
  );

  assert.deepEqual(result, { ready: true, restarted: true, error: null });
});

test("returns an actionable failure when restart cannot recover", async () => {
  const result = await ensureServerReady(
    {
      health: async () => false,
      restart: async () => {},
      delay: noDelay,
    },
    { initialChecks: 1, restartedChecks: 1 },
  );

  assert.equal(result.ready, false);
  assert.equal(result.restarted, true);
  assert.match(result.error || "", /did not become ready/i);
});
