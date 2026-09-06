// Transactional, revision-based storage for native gallery records.
//
// The legacy layout kept one mutable copy of each record (input.bin,
// model.glb, thumb.bin, metadata.json) and overwrote it in place, so a crash
// mid-update could leave valid metadata pointing at half-written blobs — or a
// deleted thumbnail could make the record disappear entirely.
//
// This module stores immutable revisions under `<record>/revisions/<n>/` and
// commits them by writing metadata last. Loading always returns either the
// previous complete revision or the new complete revision — never a mixed
// record. The filesystem is injected so interruption behavior is unit
// testable.

import type { GenRecord, VersionRecord } from "./types";

/** The subset of filesystem operations gallery storage needs. */
export interface GalleryFs {
  mkdir(path: string, recursive: boolean): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  remove(path: string, recursive: boolean): Promise<void>;
  /** Names of directories directly inside `path` (empty when absent). */
  listDirectories(path: string): Promise<string[]>;
}

export interface StoredMetadata extends Omit<VersionRecord, "input" | "glb" | "thumb"> {
  inputType: string;
  glbType: string;
  thumbType: string | null;
  hasThumb: boolean;
  /** Commit-order marker written into every revision's metadata. */
  revision?: number;
}

export interface GalleryMetadataPatch { label?: string; favorite?: boolean; assetLabel?: string }
interface MetadataOverlay { label: string; favorite: boolean; assetLabel: string | null }

function validOverlay(value: unknown): value is MetadataOverlay {
  if (!value || typeof value !== "object") return false;
  const v = value as MetadataOverlay;
  return typeof v.label === "string" && typeof v.favorite === "boolean" && (v.assetLabel === null || typeof v.assetLabel === "string");
}
async function overlayDirectories(fs: GalleryFs, dir: string): Promise<string[]> {
  if (!(await fs.exists(dir))) return [];
  return (await fs.listDirectories(dir)).filter((name) => /^[1-9][0-9]*$/.test(name) && Number.isSafeInteger(Number(name))).sort((a, b) => Number(b) - Number(a));
}
async function readMetadata(fs: GalleryFs, dir: string): Promise<StoredMetadata> {
  const metadata = JSON.parse(await fs.readTextFile(dir + "/metadata.json")) as StoredMetadata;
  for (const name of await overlayDirectories(fs, dir + "/metadata-updates")) {
    try {
      const patch: unknown = JSON.parse(await fs.readTextFile(dir + "/metadata-updates/" + name + "/metadata.json"));
      if (!validOverlay(patch)) continue;
      metadata.label = patch.label;
      metadata.favorite = patch.favorite;
      if (patch.assetLabel !== null) metadata.operationParams = { ...metadata.operationParams, assetLabel: patch.assetLabel };
      return metadata;
    } catch { /* an interrupted metadata update leaves the previous one usable */ }
  }
  return metadata;
}

function recordDir(root: string, encodedId: string): string {
  return `${root}/${encodedId}`;
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function buildMetadata(
  record: VersionRecord,
  revision: number,
): Promise<{ metadata: StoredMetadata; input: Uint8Array; glb: Uint8Array; thumb: Uint8Array | null }> {
  const { input, glb, thumb, ...fields } = record;
  if (!glb) throw new Error("Cannot save a Library entry without loading its model");
  return {
    metadata: {
      ...fields,
      inputType: input.type,
      glbType: glb.type,
      thumbType: thumb?.type || null,
      hasThumb: thumb !== null,
      revision,
    },
    input: await toBytes(input),
    glb: await toBytes(glb),
    thumb: thumb ? await toBytes(thumb) : null,
  };
}

async function committedRevisions(
  fs: GalleryFs,
  dir: string,
): Promise<Array<{ name: string; number: number }>> {
  let names: string[] = [];
  try {
    names = await fs.listDirectories(`${dir}/revisions`);
  } catch {
    return [];
  }
  const committed: Array<{ name: string; number: number }> = [];
  for (const name of names) {
    const number = Number(name);
    if (!Number.isInteger(number) || number < 0) continue;
    if (await fs.exists(`${dir}/revisions/${name}/metadata.json`)) {
      committed.push({ name, number });
    }
  }
  committed.sort((a, b) => b.number - a.number); // newest first
  return committed;
}

async function requireModelFile(fs: GalleryFs, dir: string): Promise<null> {
  if (!(await fs.exists(dir + "/model.glb"))) throw new Error("Saved model file is missing");
  return null;
}

async function loadFromRevision(
  fs: GalleryFs,
  dir: string,
  name: string,
  metadataOnly = false,
): Promise<GenRecord> {
  const rdir = `${dir}/revisions/${name}`;
  const metadata = await readMetadata(fs, rdir);
  const [input, glb, thumb] = await Promise.all([
    fs.readFile(`${rdir}/input.bin`),
    metadataOnly ? requireModelFile(fs, rdir) : fs.readFile(`${rdir}/model.glb`),
    metadata.hasThumb ? fs.readFile(`${rdir}/thumb.bin`).catch(() => null) : Promise.resolve(null),
  ]);
  const { inputType, glbType, thumbType, hasThumb: _hasThumb, revision: _revision, ...record } =
    metadata;
  return {
    ...record,
    input: new Blob([new Uint8Array(input)], { type: inputType || "application/octet-stream" }),
    glb: glb ? new Blob([new Uint8Array(glb)], { type: glbType || "model/gltf-binary" }) : null,
    thumb: thumb ? new Blob([new Uint8Array(thumb)], { type: thumbType || "image/png" }) : null,
  };
}

async function loadLegacy(fs: GalleryFs, dir: string, metadataOnly = false): Promise<GenRecord> {
  const metadata = await readMetadata(fs, dir);
  const [input, glb, thumb] = await Promise.all([
    fs.readFile(`${dir}/input.bin`),
    metadataOnly ? requireModelFile(fs, dir) : fs.readFile(`${dir}/model.glb`),
    metadata.hasThumb ? fs.readFile(`${dir}/thumb.bin`).catch(() => null) : Promise.resolve(null),
  ]);
  const { inputType, glbType, thumbType, hasThumb: _hasThumb, ...record } = metadata;
  return {
    ...record,
    input: new Blob([new Uint8Array(input)], { type: inputType || "application/octet-stream" }),
    glb: glb ? new Blob([new Uint8Array(glb)], { type: glbType || "model/gltf-binary" }) : null,
    thumb: thumb ? new Blob([new Uint8Array(thumb)], { type: thumbType || "image/png" }) : null,
  };
}

/**
 * Loads one gallery record: newest committed revision first, falling back to
 * older revisions and finally to the legacy fixed-file layout. Returns null
 * only when nothing readable exists.
 */
export async function loadGalleryRecord(
  fs: GalleryFs,
  root: string,
  encodedId: string,
  loaded?: (dir: string) => void,
  metadataOnly = false,
): Promise<GenRecord | null> {
  const dir = recordDir(root, encodedId);
  for (const rev of await committedRevisions(fs, dir)) {
    try {
      const record = await loadFromRevision(fs, dir, rev.name, metadataOnly);
      loaded?.(`${dir}/revisions/${rev.name}`);
      return record;
    } catch (error) {
      console.warn(`Revision ${rev.name} of ${encodedId} is unreadable; trying older`, error);
    }
  }
  try {
    const record = await loadLegacy(fs, dir, metadataOnly);
    loaded?.(dir);
    return record;
  } catch (error) {
    console.warn(`Library record ${encodedId} could not be loaded`, error);
    return null;
  }
}

/** Best-effort removal that never throws. */
async function removeQuietly(fs: GalleryFs, path: string, recursive = true): Promise<void> {
  try {
    if (await fs.exists(path)) await fs.remove(path, recursive);
  } catch {
    // cleanup must never fail the commit
  }
}

/**
 * After a successful commit: drop incomplete revisions and keep at most the
 * current plus one previous committed revision. Legacy fixed files are left
 alone here; they are removed only after the fresh revision verified below.
 */
async function cleanupRevisions(fs: GalleryFs, dir: string, current: number): Promise<void> {
  try {
    const names = await fs.listDirectories(`${dir}/revisions`);
    const numbered: Array<{ name: string; number: number }> = [];
    for (const name of names) {
      const number = Number(name);
      if (!Number.isInteger(number) || number < 0) continue;
      const complete = await fs.exists(`${dir}/revisions/${name}/metadata.json`);
      if (!complete) {
        // An interrupted write: its directory is unusable by definition.
        await removeQuietly(fs, `${dir}/revisions/${name}`);
        continue;
      }
      numbered.push({ name, number });
    }
    numbered.sort((a, b) => b.number - a.number);
    let kept = 0;
    for (const rev of numbered) {
      const isCurrent = rev.number === current;
      kept = isCurrent ? 1 : kept + 1;
      if (!isCurrent && kept > 2) {
        await removeQuietly(fs, `${dir}/revisions/${rev.name}`);
      }
    }
  } catch {
    // cleanup failure must not fail the successful write
  }
}

async function writeOnce(
  fs: GalleryFs,
  root: string,
  encodedId: string,
  record: VersionRecord,
): Promise<string> {
  const dir = recordDir(root, encodedId);
  await fs.mkdir(`${dir}/revisions`, true);

  const existing = await committedRevisions(fs, dir);
  const revision = existing.length ? existing[0].number + 1 : 1;
  const rdir = `${dir}/revisions/${revision}`;
  await fs.mkdir(rdir, true);

  const { metadata, input, glb, thumb } = await buildMetadata(record, revision);
  // Order matters: blobs first, metadata last as the commit marker.
  await fs.writeFile(`${rdir}/input.bin`, input);
  await fs.writeFile(`${rdir}/model.glb`, glb);
  if (thumb) {
    // A removed thumbnail simply stays absent from this revision; the
    // previous revision keeps its own copy until cleanup.
    await fs.writeFile(`${rdir}/thumb.bin`, thumb);
  }
  await fs.writeTextFile(`${rdir}/metadata.json`, JSON.stringify(metadata));

  // Verify the just-committed revision reads back before trusting it.
  const verified = await loadFromRevision(fs, dir, String(revision));
  if (!verified.glb?.size) throw new Error("committed revision failed verification");

  await cleanupRevisions(fs, dir, revision);

  // Only now that a committed revision has been read back successfully may
  // the legacy fixed-file copies be retired (best-effort).
  await removeQuietly(fs, `${dir}/metadata.json`, false);
  await removeQuietly(fs, `${dir}/input.bin`, false);
  await removeQuietly(fs, `${dir}/model.glb`, false);
  await removeQuietly(fs, `${dir}/thumb.bin`, false);
  return rdir;
}

/**
 * Creates transactional gallery storage over `root`. Writes are serialized
 * per record ID so two saves cannot race on the next revision number.
 */
export function createTransactionalGallery(fs: GalleryFs, root: string) {
  const locks = new Map<string, Promise<unknown>>();
  const loadedDirs = new Map<string, string>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(
      key,
      next.catch(() => undefined),
    );
    const settled = locks.get(key);
    void next.finally(() => { if (locks.get(key) === settled) locks.delete(key); }).catch(() => undefined);
    return next;
  }

  return {
    async updateMetadata(encodedId: string, patch: GalleryMetadataPatch): Promise<void> {
      await withLock(encodedId, async () => {
        if (!loadedDirs.has(encodedId)) {
          const record = await loadGalleryRecord(fs, root, encodedId, (dir) => loadedDirs.set(encodedId, dir), true);
          if (!record) throw new Error("Cannot update an unreadable Library record");
        }
        const dir = loadedDirs.get(encodedId)!;
        const current = await readMetadata(fs, dir);
        const updates = dir + "/metadata-updates";
        const names = await overlayDirectories(fs, updates);
        const next = Number(names[0] ?? 0) + 1;
        if (!Number.isSafeInteger(next)) throw new Error("Metadata revision limit reached");
        const destination = updates + "/" + next;
        await fs.mkdir(destination, true);
        const overlay: MetadataOverlay = {
          label: patch.label ?? current.label ?? current.name ?? "Untitled model",
          favorite: patch.favorite ?? current.favorite === true,
          assetLabel: patch.assetLabel ?? (typeof current.operationParams?.assetLabel === "string" ? current.operationParams.assetLabel : null),
        };
        if (!validOverlay(overlay)) throw new Error("Invalid Library metadata update");
        const serialized = JSON.stringify(overlay);
        await fs.writeTextFile(destination + "/metadata.json", serialized);
        if (await fs.readTextFile(destination + "/metadata.json") !== serialized) throw new Error("Metadata verification failed");
        // Retain the last verified update and one fallback; originals stay untouched.
        let keptFallback = false;
        for (const old of names) {
          let valid = false;
          try { valid = validOverlay(JSON.parse(await fs.readTextFile(updates + "/" + old + "/metadata.json"))); } catch { /* incomplete */ }
          if (valid && !keptFallback) { keptFallback = true; continue; }
          await removeQuietly(fs, updates + "/" + old);
        }
      });
    },
    async writeRecord(encodedId: string, record: VersionRecord): Promise<void> {
      await withLock(encodedId, async () => { loadedDirs.set(encodedId, await writeOnce(fs, root, encodedId, record)); });
    },
    async loadRecord(encodedId: string, metadataOnly = false): Promise<GenRecord | null> {
      return loadGalleryRecord(fs, root, encodedId, (dir) => loadedDirs.set(encodedId, dir), metadataOnly);
    },
  };
}
