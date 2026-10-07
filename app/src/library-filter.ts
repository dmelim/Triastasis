export type LibraryFilter = "all" | "favorites" | "multiple";
export type LibrarySort = "newest" | "oldest" | "name";

export interface LibrarySearchEntry {
  name: string;
  searchText: string;
  favorite: boolean;
  versionCount: number;
  createdAt: number;
  /** Project identity (see projectKey), or null when unassigned. */
  projectKey?: string | null;
  /** Keys of every project on any version; matches the filter alongside projectKey. */
  projectKeys?: string[];
}

export const PROJECT_FILTER_ALL = "all";
export const PROJECT_FILTER_NONE = "none";
/** Project options are prefixed so a project can never collide with the reserved values. */
export const PROJECT_FILTER_PREFIX = "project:";

export interface LibraryQuery {
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  /** PROJECT_FILTER_ALL, PROJECT_FILTER_NONE, or a project key. */
  project?: string;
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
      const project = options.project ?? PROJECT_FILTER_ALL;
      const keys = new Set([...(entry.projectKeys ?? []), ...(entry.projectKey ? [entry.projectKey] : [])]);
      if (project === PROJECT_FILTER_NONE && keys.size > 0) return false;
      if (project.startsWith(PROJECT_FILTER_PREFIX) && !keys.has(project.slice(PROJECT_FILTER_PREFIX.length))) return false;
      return !query || entry.searchText.toLocaleLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (options.sort === "name") return a.name.localeCompare(b.name);
      return options.sort === "oldest" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    });
}
