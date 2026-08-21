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

const ROOT = "polyloom/gallery-v1";
const MIGRATION_MARKER = `${ROOT}/indexeddb-migrated`;
const OPTIONS = { baseDir: BaseDirectory.AppLocalData } as const;

interface StoredMetadata extends Omit<VersionRecord, "input" | "glb" | "thumb"> {
  inputType: string;
  glbType: string;
  thumbType: string | null;
  hasThumb: boolean;
}

function recordDirectory(id: string): string {
  const bytes = new TextEncoder().encode(id);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!encoded) throw new Error("Gallery record ID cannot be empty");
  return `${ROOT}/${encoded}`;
}

async function ensureRoot(): Promise<void> {
  await mkdir(ROOT, { ...OPTIONS, recursive: true });
}

export async function loadNativeGallery(): Promise<GenRecord[]> {
  await ensureRoot();
  const entries = await readDir(ROOT, OPTIONS);
  const records: GenRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name) continue;
    const dir = `${ROOT}/${entry.name}`;
    try {
      const metadata = JSON.parse(await readTextFile(`${dir}/metadata.json`, OPTIONS)) as StoredMetadata;
      const [input, glb, thumb] = await Promise.all([
        readFile(`${dir}/input.bin`, OPTIONS),
        readFile(`${dir}/model.glb`, OPTIONS),
        metadata.hasThumb ? readFile(`${dir}/thumb.bin`, OPTIONS) : Promise.resolve(null),
      ]);
      const {
        inputType,
        glbType,
        thumbType,
        hasThumb: _hasThumb,
        ...record
      } = metadata;
      records.push({
        ...record,
        input: new Blob([input], { type: inputType || "application/octet-stream" }),
        glb: new Blob([glb], { type: glbType || "model/gltf-binary" }),
        thumb: thumb ? new Blob([thumb], { type: thumbType || "image/png" }) : null,
      });
    } catch (error) {
      // A record is committed by writing metadata last. Ignore interrupted or
      // corrupt directories so one bad entry cannot hide the whole gallery.
      console.warn(`Skipping unreadable native gallery record ${entry.name}`, error);
    }
  }
  return records;
}

export async function writeNativeRecord(record: VersionRecord): Promise<void> {
  await ensureRoot();
  const dir = recordDirectory(record.id);
  await mkdir(dir, { ...OPTIONS, recursive: true });

  const { input, glb, thumb, ...fields } = record;
  const metadata: StoredMetadata = {
    ...fields,
    inputType: input.type,
    glbType: glb.type,
    thumbType: thumb?.type || null,
    hasThumb: thumb !== null,
  };

  // Metadata is the commit marker. If the process stops during a blob write,
  // the old metadata remains valid and the record is retried on the next save.
  await writeFile(`${dir}/input.bin`, new Uint8Array(await input.arrayBuffer()), OPTIONS);
  await writeFile(`${dir}/model.glb`, new Uint8Array(await glb.arrayBuffer()), OPTIONS);
  if (thumb) {
    await writeFile(`${dir}/thumb.bin`, new Uint8Array(await thumb.arrayBuffer()), OPTIONS);
  } else if (await exists(`${dir}/thumb.bin`, OPTIONS)) {
    await remove(`${dir}/thumb.bin`, OPTIONS);
  }
  await writeTextFile(`${dir}/metadata.json`, JSON.stringify(metadata), OPTIONS);
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
