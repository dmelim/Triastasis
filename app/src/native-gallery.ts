import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { GenRecord, VersionRecord } from "./types";
import { createTransactionalGallery, type GalleryFs } from "./gallery-storage";

const ROOT = "polyloom/gallery-v1";
const MIGRATION_MARKER = `${ROOT}/indexeddb-migrated`;
const OPTIONS = { baseDir: BaseDirectory.AppLocalData } as const;

function recordDirectory(id: string): string {
  const bytes = new TextEncoder().encode(id);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!encoded) throw new Error("Gallery record ID cannot be empty");
  return `${ROOT}/${encoded}`;
}

async function ensureRoot(): Promise<void> {
  await mkdir(ROOT, { ...OPTIONS, recursive: true });
}

/** Adapter from Tauri's plugin-fs to the injectable gallery filesystem. */
const tauriFs: GalleryFs = {
  async mkdir(path, recursive) {
    await mkdir(path, { ...OPTIONS, recursive });
  },
  writeFile(path, data) {
    return writeFile(path, data, OPTIONS);
  },
  writeTextFile(path, text) {
    return writeTextFile(path, text, OPTIONS);
  },
  readFile(path) {
    return readFile(path, OPTIONS);
  },
  readTextFile(path) {
    return readTextFile(path, OPTIONS);
  },
  exists(path) {
    return exists(path, OPTIONS);
  },
  remove(path, recursive) {
    return remove(path, { ...OPTIONS, recursive });
  },
  async listDirectories(path) {
    try {
      const entries = await readDir(path, OPTIONS);
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
  for (const id of ids) {
    const dir = recordDirectory(id);
    if (await exists(dir, OPTIONS)) await remove(dir, { ...OPTIONS, recursive: true });
  }
}

export async function clearNativeGallery(): Promise<void> {
  await ensureRoot();
  const entries = await readDir(ROOT, OPTIONS);
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue;
    await remove(`${ROOT}/${entry.name}`, { ...OPTIONS, recursive: true });
  }
}

export function nativeMigrationWasCompleted(): Promise<boolean> {
  return exists(MIGRATION_MARKER, OPTIONS);
}

export async function markNativeMigrationCompleted(): Promise<void> {
  await ensureRoot();
  await writeTextFile(MIGRATION_MARKER, "IndexedDB gallery migrated to app-local storage.\n", OPTIONS);
}
