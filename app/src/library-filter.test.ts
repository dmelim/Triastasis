import assert from "node:assert/strict";
import test from "node:test";
import { filterLibraryEntries, type LibrarySearchEntry } from "./library-filter";

interface Entry extends LibrarySearchEntry {
  id: string;
}

const entries: Entry[] = [
  { id: "robot", name: "Robot", searchText: "Robot seed 42 generated", favorite: true, versionCount: 4, createdAt: 30 },
  { id: "orb", name: "Orb", searchText: "Orb imported", favorite: false, versionCount: 1, createdAt: 10 },
  { id: "ship", name: "Airship", searchText: "Airship edited", favorite: false, versionCount: 2, createdAt: 20 },
];

test("search matches asset and version metadata without case sensitivity", () => {
  const result = filterLibraryEntries(entries, { query: "SEED 42", filter: "all", sort: "newest" });
  assert.deepEqual(result.map((entry) => entry.id), ["robot"]);
});

test("favorites and multiple-version filters are independent", () => {
  const favorites = filterLibraryEntries(entries, { query: "", filter: "favorites", sort: "newest" });
  const multiple = filterLibraryEntries(entries, { query: "", filter: "multiple", sort: "newest" });
  assert.deepEqual(favorites.map((entry) => entry.id), ["robot"]);
  assert.deepEqual(multiple.map((entry) => entry.id), ["robot", "ship"]);
});

test("sort supports newest, oldest, and alphabetical order", () => {
  assert.deepEqual(
    filterLibraryEntries(entries, { query: "", filter: "all", sort: "newest" }).map((entry) => entry.id),
    ["robot", "ship", "orb"],
  );
  assert.deepEqual(
    filterLibraryEntries(entries, { query: "", filter: "all", sort: "oldest" }).map((entry) => entry.id),
    ["orb", "ship", "robot"],
  );
  assert.deepEqual(
    filterLibraryEntries(entries, { query: "", filter: "all", sort: "name" }).map((entry) => entry.id),
    ["ship", "orb", "robot"],
  );
});

test("project filter selects one project, unassigned assets, or everything", () => {
  const projected: Entry[] = [
    { ...entries[0], projectKey: "alpha" },
    { ...entries[1], projectKey: "beta" },
    { ...entries[2], projectKey: null },
  ];
  const run = (project: string) => filterLibraryEntries(projected, { query: "", filter: "all", sort: "newest", project }).map((entry) => entry.id);
  assert.deepEqual(run("all"), ["robot", "ship", "orb"]);
  assert.deepEqual(run("project:alpha"), ["robot"]);
  assert.deepEqual(run("none"), ["ship"]);
});

test("projects named like reserved filter values do not collide", () => {
  const projected: Entry[] = [
    { ...entries[0], projectKey: "all" },
    { ...entries[1], projectKey: "none" },
    { ...entries[2], projectKey: null },
  ];
  const run = (project: string) => filterLibraryEntries(projected, { query: "", filter: "all", sort: "newest", project }).map((entry) => entry.id);
  assert.deepEqual(run("project:all"), ["robot"]);
  assert.deepEqual(run("project:none"), ["orb"]);
  assert.deepEqual(run("none"), ["ship"]);
});

test("searching a project name finds its assets through searchText", () => {
  const tagged = entries.map((entry) => ({ ...entry, searchText: `${entry.searchText} ${entry.id === "orb" ? "Moon Base" : ""}` }));
  assert.deepEqual(filterLibraryEntries(tagged, { query: "moon base", filter: "all", sort: "newest" }).map((entry) => entry.id), ["orb"]);
});

test("an asset matches every project present on any of its versions", () => {
  const mixed: Entry[] = [{ ...entries[0], projectKey: "new", projectKeys: ["new", "old"] }, { ...entries[1], projectKey: null, projectKeys: [] }];
  const run = (project: string) => filterLibraryEntries(mixed, { query: "", filter: "all", sort: "newest", project }).map((entry) => entry.id);
  assert.deepEqual(run("project:old"), ["robot"]);
  assert.deepEqual(run("project:new"), ["robot"]);
  assert.deepEqual(run("none"), ["orb"]);
});
