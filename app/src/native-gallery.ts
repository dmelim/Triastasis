import type { GenRecord, VersionRecord } from "./types";
import { createTransactionalGallery, type GalleryFs } from "./gallery-storage";

const ROOT = "triastasis/gallery-v1";
const MIGRATION_MARKER = `${ROOT}/indexeddb-migrated`;

type FsPlugin = typeof import("@tauri-apps/plugin-fs");

let fsPluginPromise: Promise<FsPlugin> | undefined;

function loadFsPlugin(): Promise<FsPlugin> {
  fsPluginPromise ??= import("@tauri-apps/plugin-fs");
  return fsPluginPromise;
}

function appLocalOptions(fs: FsPlugin) {
  return { baseDir: fs.BaseDirectory.AppLocalData } as const;
}

function recordDirectory(id: string): string {
  const bytes = new TextEncoder().encode(id);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!encoded) throw new Error("Gallery record ID cannot be empty");
  return `${ROOT}/${encoded}`;
}

async function ensureRoot(): Promise<void> {
  const fs = await loadFsPlugin();
  await fs.mkdir(ROOT, { ...appLocalOptions(fs), recursive: true });
}

/** Adapter from Tauri's plugin-fs to the injectable gallery filesystem. */
const tauriFs: GalleryFs = {
  async mkdir(path, recursive) {
    const fs = await loadFsPlugin();
    await fs.mkdir(path, { ...appLocalOptions(fs), recursive });
  },
  async writeFile(path, data) {
    const fs = await loadFsPlugin();
    await fs.writeFile(path, data, appLocalOptions(fs));
  },
  async writeTextFile(path, text) {
    const fs = await loadFsPlugin();
    await fs.writeTextFile(path, text, appLocalOptions(fs));
  },
  async readFile(path) {
    const fs = await loadFsPlugin();
    return fs.readFile(path, appLocalOptions(fs));
  },
  async readTextFile(path) {
    const fs = await loadFsPlugin();
    return fs.readTextFile(path, appLocalOptions(fs));
  },
  async exists(path) {
    const fs = await loadFsPlugin();
    return fs.exists(path, appLocalOptions(fs));
  },
  async remove(path, recursive) {
    const fs = await loadFsPlugin();
    await fs.remove(path, { ...appLocalOptions(fs), recursive });
  },
  async listDirectories(path) {
    const fs = await loadFsPlugin();
    try {
      const entries = await fs.readDir(path, appLocalOptions(fs));
      return entries.filter((entry) => entry.isDirectory && entry.name).map((entry) => entry.name!);
    } catch {
      return [];
    }
  },
};

const store = createTransactionalGallery(tauriFs, ROOT);

export async function loadNativeGallery(): Promise<GenRecord[]> {
  await ensureRoot();
  const entries = await tauriFs.listDirectories(ROOT);
  const records: GenRecord[] = [];

  for (const name of entries) {
    try {
      // A record is committed through revision metadata (or its legacy
      // metadata.json); unreadable records are skipped so one bad entry
      // cannot hide the whole gallery.
      const record = await store.loadRecord(name);
      if (record) records.push(record);
    } catch (error) {
      console.warn(`Skipping unreadable native gallery record ${name}`, error);
    }
  }
  return records;
}

export async function writeNativeRecord(record: VersionRecord): Promise<void> {
  await ensureRoot();
  await store.writeRecord(encodedIdOf(record.id), record);
}

function encodedIdOf(id: string): string {
  return recordDirectory(id).slice(ROOT.length + 1);
}

export async function deleteNativeRecords(ids: string[]): Promise<void> {
  const fs = await loadFsPlugin();
  const options = appLocalOptions(fs);
  for (const id of ids) {
    const dir = recordDirectory(id);
    if (await fs.exists(dir, options)) await fs.remove(dir, { ...options, recursive: true });
  }
}

export async function clearNativeGallery(): Promise<void> {
  await ensureRoot();
  const fs = await loadFsPlugin();
  const options = appLocalOptions(fs);
  const entries = await fs.readDir(ROOT, options);
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue;
    await fs.remove(`${ROOT}/${entry.name}`, { ...options, recursive: true });
  }
}

export async function nativeMigrationWasCompleted(): Promise<boolean> {
  const fs = await loadFsPlugin();
  return fs.exists(MIGRATION_MARKER, appLocalOptions(fs));
}

export async function markNativeMigrationCompleted(): Promise<void> {
  await ensureRoot();
  const fs = await loadFsPlugin();
  await fs.writeTextFile(
    MIGRATION_MARKER,
    "IndexedDB gallery migrated to app-local storage.\n",
    appLocalOptions(fs),
  );
}
