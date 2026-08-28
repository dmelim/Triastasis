import assert from "node:assert/strict";
import test from "node:test";
import {
  curatedModelTermsAccepted,
  curatedModelTermsHtml,
  setCuratedModelTermsAccepted,
} from "./model-terms";

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

test("curated downloads stay blocked until the terms are accepted", () => {
  installStorage();
  assert.equal(curatedModelTermsAccepted(), false);
  assert.doesNotMatch(curatedModelTermsHtml(), /data-model-terms-accept checked/);

  setCuratedModelTermsAccepted(true);
  assert.equal(curatedModelTermsAccepted(), true);
  assert.match(curatedModelTermsHtml(), /data-model-terms-accept checked/);
});

test("revoking the acknowledgement blocks curated downloads again", () => {
  installStorage();
  setCuratedModelTermsAccepted(true);
  setCuratedModelTermsAccepted(false);
  assert.equal(curatedModelTermsAccepted(), false);
});

test("unavailable preference storage fails closed", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("storage unavailable");
    },
  });
  assert.equal(curatedModelTermsAccepted(), false);
  assert.doesNotThrow(() => setCuratedModelTermsAccepted(true));
});
