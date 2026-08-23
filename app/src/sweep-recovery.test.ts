// Regression coverage for manifest-driven job orchestration (Phase 7).
// Bundled by esbuild and executed with node:test — see scripts/run-unit-tests.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeRecoveryPlan,
  planRecoveryQueue,
  queueableCandidates,
  recoveryEligibility,
  requiresTerminalFinalization,
  sortBySweepIndex,
  sourceIdentityFor,
  sourceIssueReason,
  summarizeWarnings,
} from "./sweep-recovery";
import type { GenerationManifest, ManifestIssue } from "./types";
import {
  busyContentFor,
  canCloseModal,
  captureControls,
  classifyImportFailure,
  manifestWriteFailureMessage,
  restoreControls,
} from "./modal-busy";
import { hasDurableGeneratedArtifact } from "./generation-manifest";
import { escapeHtml, hasBlockingCoreIssue, manifestIssueText } from "./manifest-ui";

function manifest(overrides: Partial<GenerationManifest> = {}): GenerationManifest {
  return {
    schemaVersion: 1,
    status: "interrupted",
    label: "candidate",
    sourceImage: "source.png",
    model: "model.glb",
    resolution: 512,
    seed: 42,
    bgRemoval: "auto",
    uv: "xatlas",
    texture: true,
    jobId: "job-1",
    nativeRequestId: "req-1",
    assetId: "asset-1",
    versionId: "version-1",
    parentVersionId: null,
    submittedAtUtc: null,
    startedAtUtc: null,
    finishedAtUtc: null,
    durationSeconds: null,
    polyloomVersion: null,
    serverVersion: null,
    metrics: null,
    qualityWarning: null,
    error: null,
    files: [],
    sweep: null,
    ...overrides,
  };
}

test("completed candidates are never requeued", () => {
  const result = recoveryEligibility(manifest({ status: "completed" }));
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /completed/);
});

test("cancelled candidates are never requeued", () => {
  const result = recoveryEligibility(
    manifest({
      status: "cancelled",
      sweep: { groupId: "g", index: 0, count: 2, seed: 42, state: "cancelled" },
    }),
  );
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /cancelled/);
});

test("failed candidates follow the retryable policy", () => {
  const result = recoveryEligibility(manifest({ status: "failed", error: "boom" }));
  assert.equal(result.eligible, true);
});

test("interrupted candidates are the primary recovery case", () => {
  assert.equal(recoveryEligibility(manifest()).eligible, true);
});

test("candidates without lineage or source reference are ineligible", () => {
  assert.equal(
    recoveryEligibility(manifest({ assetId: undefined, versionId: undefined })).eligible,
    false,
  );
  assert.equal(recoveryEligibility(manifest({ sourceImage: undefined })).eligible, false);
});

test("queueableCandidates filters and preserves sweep index order", () => {
  const ordered = [
    { manifest: manifest({ versionId: "b", sweep: { groupId: "g", index: 1, count: 3, seed: 43, state: "queued" } }) },
    { manifest: manifest({ status: "completed", versionId: "a", sweep: { groupId: "g", index: 0, count: 3, seed: 42, state: "completed" } }) },
    { manifest: manifest({ versionId: "c", sweep: { groupId: "g", index: 2, count: 3, seed: 44, state: "queued" } }) },
  ];
  const queueable = queueableCandidates(ordered);
  // Completed index-0 candidate excluded; remaining restore in original order.
  assert.deepEqual(queueable.map((entry) => entry.manifest.versionId), ["b", "c"]);
});

test("sortBySweepIndex orders by original submission order", () => {
  const entries = [
    { manifest: manifest({ sweep: { groupId: "g", index: 2, count: 3, seed: 44, state: "queued" } }) },
    { manifest: manifest({ sweep: { groupId: "g", index: 0, count: 3, seed: 42, state: "queued" } }) },
    { manifest: manifest({ sweep: { groupId: "g", index: 1, count: 3, seed: 43, state: "queued" } }) },
  ];
  assert.deepEqual(
    sortBySweepIndex(entries).map((e) => e.manifest.sweep?.index),
    [0, 1, 2],
  );
});

test("identical warning messages keep their candidate count", () => {
  const summary = summarizeWarnings([
    "Collapsed into a plane",
    "Collapsed into a plane",
  ]);
  assert.equal(summary, "Collapsed into a plane ×2");
});

test("mixed warning codes are grouped without mislabelling", () => {
  const summary = summarizeWarnings([
    "Collapsed into a plane",
    "Background sheet attached",
    "Background sheet attached",
  ]);
  assert.equal(summary, "Collapsed into a plane; Background sheet attached ×2");
});

test("empty warning lists produce no summary", () => {
  assert.equal(summarizeWarnings([]), null);
});

test("pre-persisted sweep candidates REQUIRE terminal finalization", () => {
  // Regression: the previous condition skipped this exact combination, so a
  // successful sweep candidate's manifest was never marked completed.
  assert.equal(
    requiresTerminalFinalization({ manifestContext: null, resume: null, candidateManifest: {} }),
    true,
  );
});

test("all three manifest paths require finalization", () => {
  assert.equal(
    requiresTerminalFinalization({ manifestContext: {}, resume: null, candidateManifest: null }),
    true,
  );
  assert.equal(
    requiresTerminalFinalization({ manifestContext: null, resume: {}, candidateManifest: null }),
    true,
  );
  assert.equal(
    requiresTerminalFinalization({ manifestContext: {}, resume: {}, candidateManifest: {} }),
    true,
  );
});

test("jobs without manifests need no finalization", () => {
  assert.equal(
    requiresTerminalFinalization({ manifestContext: null, resume: null, candidateManifest: null }),
    false,
  );
});

// ---- recovery preflight (issues-aware) ----

function issue(kind: string, role = "sourceImage"): ManifestIssue {
  return { kind, role, path: "source.png", detail: kind };
}

test("a missing source image excludes a candidate with the exact reason", () => {
  const result = recoveryEligibility(manifest(), [issue("missing")]);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /missing/);
});

test("a hash-mismatched source image excludes a candidate", () => {
  const result = recoveryEligibility(manifest(), [issue("hashMismatch")]);
  assert.equal(result.eligible, false);
  assert.match(result.reason ?? "", /hashMismatch/);
});

test("an unsafe source path excludes a candidate", () => {
  const result = recoveryEligibility(manifest(), [issue("unsafePath")]);
  assert.equal(result.eligible, false);
});

test("sourceIssueReason ignores non-source roles", () => {
  assert.equal(sourceIssueReason([issue("missing", "glb")]), null);
});

test("planRecoveryQueue preserves sweep index order and skips excluded candidates", () => {
  const candidates = [
    { path: "c2", manifest: manifest({ versionId: "v2", sweep: { groupId: "g", index: 2, count: 3, seed: 44, state: "queued" } }) },
    { path: "c0", manifest: manifest({ versionId: "v0", sweep: { groupId: "g", index: 0, count: 3, seed: 42, state: "queued" } }), issues: [issue("missing")] },
    { path: "c1", manifest: manifest({ versionId: "v1", sweep: { groupId: "g", index: 1, count: 3, seed: 43, state: "queued" } }) },
  ];
  const plan = planRecoveryQueue(candidates);
  // c0 is excluded (missing source); c1 and c2 queue in index order.
  assert.deepEqual(plan.map((p) => p.candidate.path), ["c1", "c2"]);
  assert.ok(plan.every((p) => p.sourceKey.includes("source.png")));
});

test("completed and cancelled candidates never enter the plan", () => {
  const candidates = [
    { path: "done", manifest: manifest({ status: "completed", sweep: { groupId: "g", index: 0, count: 3, seed: 42, state: "completed" } }) },
    { path: "cancelled", manifest: manifest({ status: "cancelled", sweep: { groupId: "g", index: 1, count: 3, seed: 43, state: "cancelled" } }) },
    { path: "run", manifest: manifest({ versionId: "v3", sweep: { groupId: "g", index: 2, count: 3, seed: 44, state: "running" } }) },
  ];
  assert.deepEqual(planRecoveryQueue(candidates).map((p) => p.candidate.path), ["run"]);
});

test("failed candidates remain retryable in the plan", () => {
  const plan = planRecoveryQueue([
    { path: "f", manifest: manifest({ status: "failed", error: "boom" }) },
  ]);
  assert.equal(plan.length, 1);
});

test("normalized source identities separate same-named files in different dirs", () => {
  const a = sourceIdentityFor("C:/galaxy/run-a/model.polyloom.json", "source.png");
  const b = sourceIdentityFor("C:/galaxy/run-b/MODEL.POLYLOOM.JSON", "SOURCE.PNG");
  assert.notEqual(a, b);
  // Case-insensitive within the same directory.
  assert.equal(
    sourceIdentityFor("C:/x/a.polyloom.json", "Source.png"),
    sourceIdentityFor("C:/x/b.polyloom.json", "source.PNG"),
  );
});

// ---- import transaction classification ----

test("pre-persistence failures are retryable; post-persistence are not", () => {
  assert.equal(classifyImportFailure(false), "retryable");
  assert.equal(classifyImportFailure(true), "post-persistence");
});

// ---- GLB-save-before-completion ordering contract ----

test("completion requires a saved artifact on desktop but not in browser mode", () => {
  assert.equal(hasDurableGeneratedArtifact(true, null), false);
  assert.equal(hasDurableGeneratedArtifact(true, "out/model.glb"), true);
  assert.equal(hasDurableGeneratedArtifact(false, null), true);
});

// ---- modal busy-state controller ----

interface StubControl {
  innerHTML: string;
  disabled: boolean;
  style: { minWidth: string };
}

function stub(html: string, disabled = false): StubControl {
  return { innerHTML: html, disabled, style: { minWidth: "" } };
}

test("busy snapshot restores originally-disabled controls", () => {
  const close = stub("Close");            // enabled before busy
  const relink = stub("Relink…", true);   // already disabled before busy
  const elements = [close, relink];
  const states = captureControls(elements);

  close.disabled = true;
  close.innerHTML = "spinner";
  relink.innerHTML = "spinner";
  restoreControls(elements, states);

  assert.equal(close.disabled, false);
  assert.equal(close.innerHTML, "Close");
  assert.equal(relink.disabled, true); // must NOT have been blanket-enabled
  assert.equal(relink.innerHTML, "Relink…");
});

test("busy content swap preserves button width and swaps content", () => {
  const button = stub("Import into Assets");
  const { html, minWidth } = busyContentFor(173.4);
  button.innerHTML = html;
  button.style.minWidth = minWidth;
  assert.equal(button.style.minWidth, "174px");
  assert.match(button.innerHTML, /spinner/);
});

test("user closing is blocked exactly while busy", () => {
  assert.equal(canCloseModal(false), true);
  assert.equal(canCloseModal(true), false);
});

// ---- untrusted manifest rendering ----

test("manifest HTML escaping neutralizes tags, quotes, and ampersands", () => {
  const malicious = `<img src=x onerror="alert('x')"> & done`;
  const escaped = escapeHtml(malicious);
  assert.equal(
    escaped,
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; done",
  );
  assert.doesNotMatch(escaped, /<img|onerror="/);
});

test("manifest issue text remains plain and is escaped at the HTML boundary", () => {
  const text = manifestIssueText({ kind: "missing", path: "</div><script>x</script>" });
  assert.match(text, /Missing file/);
  assert.equal(
    escapeHtml(text),
    "Missing file: &lt;/div&gt;&lt;script&gt;x&lt;/script&gt;",
  );
});

test("every native core issue blocks import actions, including unsafe paths", () => {
  for (const kind of ["missing", "hashMismatch", "invalidFormat", "unsafePath"]) {
    assert.equal(hasBlockingCoreIssue([issue(kind)]), true, kind);
  }
  assert.equal(hasBlockingCoreIssue([issue("missing", "log")]), false);
});

// ---- production recovery orchestration ----

test("recovery preflight failure names the candidate and queues zero jobs", async () => {
  const candidates = [
    {
      path: "C:/run/c0.polyloom.json",
      manifest: manifest({
        label: "first",
        versionId: "v0",
        sweep: { groupId: "g", index: 0, count: 2, seed: 42, state: "queued" },
      }),
    },
    {
      path: "C:/other/c1.polyloom.json",
      manifest: manifest({
        label: "second",
        seed: 43,
        versionId: "v1",
        sweep: { groupId: "g", index: 1, count: 2, seed: 43, state: "queued" },
      }),
    },
  ];
  const queued: string[] = [];
  await assert.rejects(
    executeRecoveryPlan(
      planRecoveryQueue(candidates),
      async (candidate) => {
        if (candidate.path.includes("c1")) throw new Error("hash verification failed");
        return candidate.path;
      },
      (candidate) => queued.push(candidate.path),
    ),
    /Candidate 2 "second".*seed 43.*c1\.polyloom\.json.*hash verification failed/,
  );
  assert.deepEqual(queued, []);
});

test("recovery reads a shared source once and enqueues in sweep order", async () => {
  const candidates = [
    {
      path: "C:/run/c1.polyloom.json",
      manifest: manifest({
        versionId: "v1",
        sweep: { groupId: "g", index: 1, count: 2, seed: 43, state: "queued" },
      }),
    },
    {
      path: "C:/run/c0.polyloom.json",
      manifest: manifest({
        versionId: "v0",
        sweep: { groupId: "g", index: 0, count: 2, seed: 42, state: "queued" },
      }),
    },
  ];
  let reads = 0;
  const queued: number[] = [];
  const count = await executeRecoveryPlan(
    planRecoveryQueue(candidates),
    async () => {
      reads += 1;
      return "shared-source";
    },
    (candidate) => queued.push(candidate.manifest.sweep!.index),
  );
  assert.equal(count, 2);
  assert.equal(reads, 1);
  assert.deepEqual(queued, [0, 1]);
});

// ---- outcome-accurate finalization messages ----

test("manifest finalization warnings only claim Assets persistence when true", () => {
  assert.match(manifestWriteFailureMessage("asset-persisted", "disk full"), /saved to Assets/);
  assert.doesNotMatch(
    manifestWriteFailureMessage("generation-failed", "disk full"),
    /saved to Assets/,
  );
  assert.doesNotMatch(
    manifestWriteFailureMessage("generation-cancelled", "disk full"),
    /saved to Assets/,
  );
});
