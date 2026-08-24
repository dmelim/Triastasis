export type LibraryFilter = "all" | "favorites" | "multiple";
export type LibrarySort = "newest" | "oldest" | "name";

export interface LibrarySearchEntry {
  name: string;
  searchText: string;
  favorite: boolean;
  versionCount: number;
  createdAt: number;
}

export interface LibraryQuery {
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
}

export function filterLibraryEntries<T extends LibrarySearchEntry>(
  entries: T[],
  options: LibraryQuery,
): T[] {
  const query = options.query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => {
      if (options.filter === "favorites" && !entry.favorite) return false;
      if (options.filter === "multiple" && entry.versionCount <= 1) return false;
      return !query || entry.searchText.toLocaleLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (options.sort === "name") return a.name.localeCompare(b.name);
      return options.sort === "oldest" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    });
}
