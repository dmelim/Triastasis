import assert from "node:assert/strict";
import test from "node:test";
import { inspectGenerationData, readBinaryContainer, unpackGenerationPackage } from "./generation-data";
import { containerFixture, generationFixture } from "./generation-data-fixture.test-helper";

test("native container profile round-trips with verified payloads and model binding", async () => {
  const { data, glb } = await generationFixture();
  const parsed = await inspectGenerationData(data);
  assert.equal(parsed.reference.bytes, data.size);
  const packageBlob = await containerFixture("TRGPK001", "triastasis-generation-package", { "model.glb": glb, "generation.trg": data });
  const result = await unpackGenerationPackage(packageBlob);
  assert.equal(result.generationDataRef?.sha256, parsed.reference.sha256);
  assert.equal(await result.glb.text(), await glb.text());
});
test("bad entry bounds, unknown schemas and duplicate names are rejected", async () => {
  for (const mutate of [
    (m: Record<string, any>) => { m.files[0].offset = Number.MAX_SAFE_INTEGER; },
    (m: Record<string, any>) => { m.schema = "unknown"; },
    (m: Record<string, any>) => { m.files[1].name = m.files[0].name; },
  ]) {
    const blob = await containerFixture("TRGPK001", "triastasis-generation-package", { "model.glb": new Blob(["model"]), "generation.trg": new Blob(["data"]) }, {}, mutate);
    await assert.rejects(readBinaryContainer(blob, "TRGPK001", "triastasis-generation-package", ["model.glb", "generation.trg"]));
  }
});
test("corrupt generation data and mismatched source preserve the independently verified GLB", async () => {
  const { data, glb } = await generationFixture();
  for (const body of [new Blob(["invalid"]), data]) {
    const blob = await containerFixture("TRGPK001", "triastasis-generation-package", { "model.glb": new Blob(["other model"]), "generation.trg": body });
    const result = await unpackGenerationPackage(blob);
    assert.equal(await result.glb.text(), "other model");
    assert.ok(result.generationDataError); assert.equal(result.generationDataRef, undefined);
  }
  const unsupported = await containerFixture("TRGPK001", "triastasis-generation-package", { "model.glb": glb }, { generation_data_error: { code: "unsupported_capture_profile" } });
  assert.equal((await unpackGenerationPackage(unsupported)).generationDataError, "unsupported_capture_profile");
});
