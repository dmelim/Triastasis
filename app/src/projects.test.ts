import assert from "node:assert/strict";
import test from "node:test";
import { assetProject, collectProjects, parseProject, projectKey } from "./projects";

test("parseProject trims names and falls back to the default icon", () => {
  assert.deepEqual(parseProject({ name: "  Moon Base ", icon: "gem" }), { name: "Moon Base", icon: "gem" });
  assert.deepEqual(parseProject({ name: "X", icon: "../evil" }), { name: "X", icon: "folder" });
});

test("parseProject rejects malformed values", () => {
  for (const value of [null, undefined, "x", 3, {}, { name: 4 }, { name: "   " }]) assert.equal(parseProject(value), null);
});

test("assetProject uses the first version that carries a project", () => {
  const records = [{ operationParams: {} }, { operationParams: { project: { name: "A", icon: "flag" } } }];
  assert.deepEqual(assetProject(records), { name: "A", icon: "flag" });
  assert.equal(assetProject([{ operationParams: {} }]), null);
});

test("collectProjects de-duplicates case-insensitively and sorts by name", () => {
  const list = collectProjects([{ name: "beta", icon: "flag" }, null, { name: "Alpha", icon: "gem" }, { name: "BETA", icon: "heart" }]);
  assert.deepEqual(list.map((p) => p.name), ["Alpha", "beta"]);
  assert.equal(projectKey({ name: " Beta ", icon: "x" }), "beta");
});

test("an interrupted rename can be retried and finishes every version", async () => {
  const { projectEditTargets, writeProjectToVersions } = await import("./projects");
  const old = { name: "Old", icon: "flag" };
  const next = { name: "New", icon: "gem" };
  const versions = ["a1", "a2", "b1"].map((id) => ({ id, operationParams: { project: old } as Record<string, unknown> }));
  let failAt: string | null = "a2";
  const write = async (version: (typeof versions)[number], project: typeof next | null): Promise<void> => {
    if (version.id === failAt) throw new Error("disk full");
    version.operationParams = project ? { project } : {};
  };
  const first = await writeProjectToVersions(projectEditTargets(versions, old), next, write);
  assert.equal(first.saved, 1);
  assert.ok(first.error);
  assert.deepEqual(versions.map((v) => (v.operationParams.project as { name: string }).name), ["New", "Old", "Old"]);
  failAt = null;
  const retry = await writeProjectToVersions(projectEditTargets(versions, old), next, write);
  assert.equal(retry.saved, 2);
  assert.equal(retry.error, null);
  assert.deepEqual(versions.map((v) => (v.operationParams.project as { name: string }).name), ["New", "New", "New"]);
});

test("project discovery sees every version, so a half-finished rename stays recoverable", async () => {
  const { projectsInRecords, projectEditTargets, writeProjectToVersions } = await import("./projects");
  const old = { name: "Old", icon: "flag" };
  const next = { name: "New", icon: "gem" };
  const versions = ["a1", "a2", "b1"].map((id) => ({ id, operationParams: { project: old } as Record<string, unknown> }));
  let failAt: string | null = "a2";
  const write = async (version: (typeof versions)[number], project: typeof next | null): Promise<void> => {
    if (version.id === failAt) throw new Error("disk full");
    version.operationParams = project ? { project } : {};
  };
  await writeProjectToVersions(projectEditTargets(versions, old), next, write);
  assert.deepEqual(projectsInRecords(versions).map((p) => p.name), ["New", "Old"]);
  failAt = null;
  await writeProjectToVersions(projectEditTargets(versions, old), next, write);
  assert.deepEqual(projectsInRecords(versions).map((p) => p.name), ["New"]);
});
