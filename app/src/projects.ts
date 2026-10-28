/** A user-defined Library project: a name plus one icon from the built-in set. */
export interface LibraryProject {
  name: string;
  icon: string;
}

export const PROJECT_ICONS = [
  "folder", "cube", "star", "heart", "flag", "bookmark",
  "zap", "flame", "leaf", "gem", "target", "home",
] as const;

export const DEFAULT_PROJECT_ICON = "folder";
export const MAX_PROJECT_NAME_LENGTH = 40;

export function isProjectIcon(value: unknown): value is string {
  return typeof value === "string" && (PROJECT_ICONS as readonly string[]).includes(value);
}

/** Identity of a project: names are unique case-insensitively. */
export function projectKey(project: LibraryProject): string {
  return project.name.trim().toLocaleLowerCase();
}

/** Validates untrusted stored data; unknown icons fall back to the default. */
export function parseProject(value: unknown): LibraryProject | null {
  if (!value || typeof value !== "object") return null;
  const { name, icon } = value as Record<string, unknown>;
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
  if (!trimmed) return null;
  return { name: trimmed, icon: isProjectIcon(icon) ? icon : DEFAULT_PROJECT_ICON };
}

/** The project of an asset: the first version that carries one. */
export function assetProject(records: { operationParams: Record<string, unknown> }[]): LibraryProject | null {
  for (const record of records) {
    const project = parseProject(record.operationParams.project);
    if (project) return project;
  }
  return null;
}

/** Distinct projects across assets, sorted by name. */
export function collectProjects(projects: (LibraryProject | null)[]): LibraryProject[] {
  const byKey = new Map<string, LibraryProject>();
  for (const project of projects) if (project && !byKey.has(projectKey(project))) byKey.set(projectKey(project), project);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Versions whose own stored project matches `from`. Matching per version, not per asset, keeps an interrupted rename resumable. */
export function projectEditTargets<T extends { operationParams: Record<string, unknown> }>(records: T[], from: LibraryProject): T[] {
  const key = projectKey(from);
  return records.filter((record) => {
    const project = parseProject(record.operationParams.project);
    return project !== null && projectKey(project) === key;
  });
}

/** Writes sequentially and stops at the first failure, reporting how many versions were saved. */
export async function writeProjectToVersions<T>(
  versions: T[],
  project: LibraryProject | null,
  write: (version: T, project: LibraryProject | null) => Promise<unknown>,
): Promise<{ saved: number; error: unknown }> {
  let saved = 0;
  try {
    for (const version of versions) {
      await write(version, project);
      saved += 1;
    }
    return { saved, error: null };
  } catch (error) {
    return { saved, error: error ?? new Error("Could not update project") };
  }
}

/** Every distinct project stored on any version, so a half-finished rename never hides a project. */
export function projectsInRecords(records: { operationParams: Record<string, unknown> }[]): LibraryProject[] {
  return collectProjects(records.map((record) => parseProject(record.operationParams.project)));
}
