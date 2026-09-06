import assert from "node:assert/strict";
import test from "node:test";
import { runtimeNumbers, saveAndRestart } from "./settings-actions";

test("failed saving never restarts; rejected restart reports that settings were saved", async () => {
  let restarts = 0;
  await assert.rejects(saveAndRestart(async () => { throw new Error("disk full"); }, async () => { restarts++; }), /disk full/);
  assert.equal(restarts, 0);
  let saved = false;
  await assert.rejects(saveAndRestart(async () => { saved = true; }, async () => { throw new Error("generation busy"); }), /Settings saved; restart failed: generation busy/);
  assert.equal(saved, true);
  assert.equal(await saveAndRestart(null, async () => { }), "Server restart requested");
});
test("runtime validation rejects partial numbers, empty fields and out-of-range ports", () => {
  for (const port of ["", "80abc", "0", "65536", "1.5"]) assert.throws(() => runtimeNumbers("0", port));
  assert.throws(() => runtimeNumbers("", "8080"));
  assert.deepEqual(runtimeNumbers("-1", "8080"), { gpu: -1, port: 8080 });
});
