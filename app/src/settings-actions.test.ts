import assert from "node:assert/strict";
import test from "node:test";
import { notifySettingsAction, runtimeNumbers, saveAndRestart } from "./settings-actions";

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

test("settings action routes success and failures once without success refresh on errors", async () => {
  const notifications: string[] = [];
  const saved = (message: string) => notifications.push(`saved:${message}`);
  const failed = (message: string) => notifications.push(`error:${message}`);
  await notifySettingsAction(() => saveAndRestart(null, async () => {}), saved, failed);
  await notifySettingsAction(() => saveAndRestart(async () => {}, async () => { throw new Error("generation busy"); }), saved, failed);
  await notifySettingsAction(async () => { runtimeNumbers("0", "bad"); return "unreachable"; }, saved, failed);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[0], "saved:Server restart requested");
  assert.equal(notifications[1], "error:Settings saved; restart failed: generation busy");
  assert.match(notifications[2], /^error:/);
});
