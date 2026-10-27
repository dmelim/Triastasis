import assert from "node:assert/strict";
import test from "node:test";
import { TextureSession, type CachedTexture } from "./texture-session";
import { nativeWork } from "./native-work";
const option = (seed: number): CachedTexture => ({ seed, key: `field-${seed}`, values: new Float32Array(6), missingSamples: 0 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("stopping waits for the active native result, discards it and skips later seeds", async () => {
  const active = deferred<CachedTexture>(), calls: number[] = [], discarded: string[] = [];
  const session = new TextureSession({ option(seed) { calls.push(seed); return active.promise; },
    async bake() { return new Blob(); }, async discard(value) { discarded.push(value.key); }, changed() {} });
  const generation = session.start([1,2,3]); session.stop();
  assert.equal(session.phase, "stopping"); assert.equal(session.busy, true);
  active.resolve(option(1)); await generation;
  assert.deepEqual(calls, [1]); assert.deepEqual(discarded, ["field-1"]); assert.equal(session.options.length, 0);
});
test("baking during generation uses the selected cached field exactly once", async () => {
  const third = deferred<CachedTexture>(), thirdStarted = deferred<void>(), baked: string[] = [], discarded: string[] = [];
  const session = new TextureSession({ async option(seed) { if (seed === 3) { thirdStarted.resolve(); return third.promise; } return option(seed); },
    async bake(value) { baked.push(value.key); return new Blob(["baked selected field"]); },
    async discard(value) { discarded.push(value.key); }, changed() {} });
  const generation = session.start([1,2,3]); await thirdStarted.promise;
  const bake = session.bakeSelected(), duplicate = session.bakeSelected();
  session.select(1); assert.equal(session.selected, 0, "selection stays bound while baking waits for active work");
  third.resolve(option(3)); await generation; await bake; await duplicate;
  assert.deepEqual(baked, ["field-1"]); assert.deepEqual(discarded, ["field-3"]);
  assert.equal(session.phase, "baked"); assert.equal(await session.baked?.text(), "baked selected field");
});
test("bake failure retains the selected field and retry does not rerun texture generation", async () => {
  let generations = 0, bakes = 0;
  const session = new TextureSession({ async option(seed) { generations++; return option(seed); },
    async bake(value) { bakes++; assert.equal(value.key, "field-2"); if (bakes === 1) throw new Error("xatlas failed"); return new Blob(["retry"]); },
    async discard() {}, changed() {} });
  await session.start([1,2,3]); session.select(1); await session.bakeSelected();
  assert.equal(session.phase, "ready"); assert.match(session.error, /xatlas failed/); assert.equal(session.selected, 1);
  await session.bakeSelected(); assert.equal(generations, 3); assert.equal(bakes, 2); assert.equal(session.phase, "baked");
});
test("closing during a bake waits for completion and does not publish its result", async () => {
  const active = deferred<Blob>(), started = deferred<void>();
  const session = new TextureSession({ async option(seed) { return option(seed); },
    async bake() { started.resolve(); return active.promise; }, async discard() {}, changed() {} });
  await session.start([1]); const bake = session.bakeSelected(); await started.promise;
  let closed = false; const closing = session.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  active.resolve(new Blob(["discarded"])); await bake; await closing;
  assert.equal(session.phase, "closed"); assert.equal(session.baked, null);
});
test("app request ordering skips a cancelled queued texture operation before dispatch", async () => {
  const first = deferred<void>(); let called = false, allowed = true;
  const running = nativeWork(() => first.promise);
  const queued = nativeWork(async () => { called = true; }, () => allowed);
  const rejected = assert.rejects(queued, error => error instanceof DOMException && error.name === "AbortError");
  allowed = false; first.resolve(); await running; await rejected; assert.equal(called, false);
});
test("queued cancellation resolves immediately without waiting for unrelated native work", async () => {
  const first = deferred<void>(), started = deferred<void>(); let called = false;
  const running = nativeWork(() => { started.resolve(); return first.promise; }); await started.promise;
  const cancellation = new AbortController();
  const queued = nativeWork(async () => { called = true; }, () => true, cancellation.signal);
  const rejected = assert.rejects(queued, error => error instanceof DOMException && error.name === "AbortError");
  cancellation.abort(); await rejected; assert.equal(called, false);
  first.resolve(); await running;
});
