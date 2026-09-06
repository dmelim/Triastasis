import assert from "node:assert/strict";
import test from "node:test";
import { OperationQueue } from "./operation-queue";
import { SharedResources } from "./editing/shared-resources";
import { EditHistory } from "./editing/history";

test("save finishes before subsequent edits and model replacement; rejected work does not stall the queue", async () => {
  const queue = new OperationQueue();
  const events: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const save = queue.run(async () => { events.push("save-start"); await wait; events.push("save-durable"); });
  const edit = queue.run(async () => { events.push("edit"); throw new Error("invalid edit"); });
  const rejected = assert.rejects(edit, /invalid edit/);
  const open = queue.run(async () => { events.push("open"); });
  await Promise.resolve();
  assert.deepEqual(events, ["save-start"]);
  assert.equal(queue.busy, true);
  release();
  await Promise.all([save, rejected, open]);
  assert.deepEqual(events, ["save-start", "save-durable", "edit", "open"]);
  assert.equal(queue.busy, false);
});

test("shared geometry survives undo branching and is released only after its last snapshot", () => {
  let disposed = 0;
  const geometry = { dispose() { disposed++; } };
  const pool = new SharedResources<typeof geometry>();
  const history = new EditHistory({ geometry: pool.retain(geometry), material: 0 }, {
    maxEntries: 2, disposeSnapshot: (state) => pool.release(state.geometry),
  });
  for (let i = 1;i <= 3;i++) history.execute({ label: "material", apply: () => ({ geometry: pool.retain(geometry), material: i }) });
  assert.equal(disposed, 0);
  history.markClean();
  history.undo();
  history.execute({ label: "branch", apply: () => ({ geometry: pool.retain(geometry), material: 9 }) });
  assert.equal(history.dirty, true);
  assert.equal(disposed, 0);
  history.dispose(true);
  assert.equal(disposed, 1);
});
