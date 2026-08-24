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
