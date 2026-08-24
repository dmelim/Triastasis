// Persistent gallery of past generations. The desktop app stores records in
// Tauri's app-local data directory so development and packaged webview origins
// see the same assets. Plain-browser builds retain the IndexedDB backend.
//
// IndexedDB isn't always available: some WebKitGTK builds can't create its
// backing file, and private-mode / sandboxed webviews reject it outright. When
// that happens we must NOT lose a generation — the store transparently falls
// back to an in-memory map so the gallery still works for the session, and the
// caller's auto-save to the output folder remains the on-disk deliverable.

import type {
  GenRecord,
  GenerationQualityWarning,
  ModelDimensions,
  ModelMetrics,
  OperationParams,
  VersionOperation,
  VersionRecord,
} from "./types";
import { isTauri } from "./tauri";
import {
  clearNativeGallery,
  deleteNativeRecords,
  loadNativeGallery,
  markNativeMigrationCompleted,
  nativeMigrationWasCompleted,
  writeNativeRecord,
} from "./native-gallery";

const DB_NAME = "trellis-studio";
/** Schema v2 adds asset/version fields and indexes, while retaining `id`. */
export const DB_VERSION = 2;
const STORE = "generations";

let dbp: Promise<IDBDatabase> | null = null;
let useMemory = false;
/** True after IndexedDB has successfully opened for this session. */
let persistentDbEstablished = false;
/** A persistent operation failed after the database was available. */
let persistentDbFailure: unknown = null;
let nativeInitialization: Promise<boolean> | null = null;
let nativePersistenceFailure: unknown = null;
const mem = new Map<string, VersionRecord>();

export type DestructiveStoreOperation = "delete" | "clear";

/**
 * A destructive gallery operation could not be confirmed against persistent storage.
 * The in-memory fallback remains available for reads, but we deliberately do
 * not claim that records were removed while the persistent store may still
 * contain them.
 */
export class GalleryPersistenceError extends Error {
  readonly operation: DestructiveStoreOperation;
  readonly causeError: unknown;

  constructor(operation: DestructiveStoreOperation, cause: unknown) {
    const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    super(
      `Could not ${operation === "clear" ? "clear the persistent gallery" : "delete the saved model"} ` +
        `from disk. The persistent records were not confirmed changed. ` +
        `Reload Triastasis and retry; if the problem continues, check the app's storage permissions${detail}.`,
    );
    this.name = "GalleryPersistenceError";
    this.operation = operation;
    this.causeError = cause;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDimensions(value: unknown): ModelDimensions | undefined {
  if (!isObject(value)) return undefined;
  return {
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    z: finiteNumber(value.z, 0),
  };
}

function normalizeMetrics(value: unknown): ModelMetrics | null {
  if (!isObject(value)) return null;
  const metrics: ModelMetrics = {};
  const numericFields: Array<keyof Omit<ModelMetrics, "dimensions">> = [
    "triangles",
    "renderVertices",
    "uniquePositions",
    "meshParts",
    "materials",
    "textures",
    "maxTextureSize",
    "animations",
    "fileSize",
  ];
  for (const field of numericFields) {
    if (typeof value[field] === "number" && Number.isFinite(value[field])) {
      metrics[field] = value[field] as number;
    }
  }
  const dimensions = normalizeDimensions(value.dimensions);
  if (dimensions) metrics.dimensions = dimensions;
  return metrics;
}

function normalizeQualityWarning(value: unknown): GenerationQualityWarning | undefined {
  if (!isObject(value) || value.code !== "collapsed-plane") return undefined;
  const dimensions = normalizeDimensions(value.dimensions);
  if (!dimensions) return undefined;
  return {
    code: "collapsed-plane",
    message: nonEmptyString(value.message) ?? "Collapsed into a plane",
    thinRatio: finiteNumber(value.thinRatio, 0),
    threshold: finiteNumber(value.threshold, 0.05),
    dimensions,
  };
}

/**
 * Fill the v2 fields without changing the legacy key or blobs. The fallback
 * choices are deterministic for every valid v1 record:
 *
 * - versionId and id remain the old record key;
 * - a sweep group becomes the stable asset ID, otherwise the record key does;
 * - ts becomes createdAt;
 * - name becomes the human label;
 * - old generations are `generated` operations with no metrics.
 */
function normalizeRecord(record: GenRecord): VersionRecord {
  const id = nonEmptyString(record.id) ?? "legacy-record";
  const ts = finiteNumber(record.ts, 0);
  const versionId = nonEmptyString(record.versionId) ?? id;
  const assetId = nonEmptyString(record.assetId) ?? nonEmptyString(record.sweepGroupId) ?? id;
  const label = nonEmptyString(record.label) ?? nonEmptyString(record.name) ?? "Untitled model";
  const operation = nonEmptyString(record.operation) as VersionOperation | undefined;
  const operationParams = isObject(record.operationParams)
    ? { ...record.operationParams } as OperationParams
    : {};

  return {
    ...record,
    id,
    versionId,
    assetId,
    parentVersionId: nonEmptyString(record.parentVersionId),
    operation: operation ?? "generated",
    operationParams,
    createdAt: finiteNumber(record.createdAt, ts),
    // `name` stays the source-image filename for old UI callers; `label` is
    // the user-facing version name introduced by the new model.
    label,
    favorite: record.favorite === true,
    metrics: normalizeMetrics(record.metrics),
    qualityWarning: normalizeQualityWarning(record.qualityWarning),
    thumb: record.thumb ?? null,
  };
}

function addIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains("ts")) store.createIndex("ts", "ts");
  if (!store.indexNames.contains("assetId")) store.createIndex("assetId", "assetId");
  if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
  if (!store.indexNames.contains("parentVersionId")) {
    store.createIndex("parentVersionId", "parentVersionId");
  }
}

function migrateRecords(store: IDBObjectStore): void {
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.update(normalizeRecord(cursor.value as GenRecord));
    cursor.continue();
  };
}

function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const store = d.objectStoreNames.contains(STORE)
        ? req.transaction!.objectStore(STORE)
        : d.createObjectStore(STORE, { keyPath: "id" });
      addIndexes(store);
      // This also makes a partially upgraded database safe: records are
      // normalized whenever an app version opens an older schema.
      migrateRecords(store);
    };
    req.onsuccess = () => {
      persistentDbEstablished = true;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  return dbp;
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function indexedRecords(): Promise<VersionRecord[]> {
  const recs = await wrap((await tx("readonly")).getAll() as IDBRequest<GenRecord[]>);
  return recs.map(normalizeRecord).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Load the native gallery and, when running under the old packaged origin,
 * copy every legacy IndexedDB record once. The old database is deliberately
 * left untouched, making the migration rollback-safe.
 */
async function initializeNativeStore(): Promise<boolean> {
  if (!isTauri()) return false;
  if (nativeInitialization) return nativeInitialization;
  nativeInitialization = (async () => {
    const nativeRecords = (await loadNativeGallery()).map(normalizeRecord);
    mem.clear();
    for (const record of nativeRecords) mem.set(record.id, record);

    if (!(await nativeMigrationWasCompleted())) {
      let legacyRecords: VersionRecord[];
      try {
        legacyRecords = await indexedRecords();
      } catch (error) {
        // The Vite origin normally has no legacy database. Do not create the
        // marker there: the next packaged-origin launch must still get a chance
        // to discover and migrate the user's existing IndexedDB records.
        console.warn("Legacy gallery migration was not available on this origin", error);
        return true;
      }

      if (legacyRecords.length > 0) {
        // Populate the session cache first. If an already-running old shell has
        // not picked up the new filesystem capability yet, the user still sees
        // every legacy asset and destructive actions remain safely disabled.
        for (const record of legacyRecords) mem.set(record.id, record);
        try {
          for (const record of legacyRecords) {
            if (!nativeRecords.some((nativeRecord) => nativeRecord.id === record.id)) {
              await writeNativeRecord(record);
            }
          }
          await markNativeMigrationCompleted();
          console.info(`Migrated ${legacyRecords.length} gallery records to app-local storage.`);
        } catch (error) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
          throw new Error(`Could not migrate the legacy gallery to app-local storage${detail}`);
        }
      }
    }
    return true;
  })().catch((error) => {
    nativePersistenceFailure = error;
    fallback(error);
    return false;
  });
  return nativeInitialization;
}

/** Switch to the in-memory fallback and warn once. */
function fallback(e: unknown): void {
  if (persistentDbEstablished) {
    // Keep the memory fallback useful for reads in this session, but remember
    // that persistent state is no longer trustworthy for destructive calls.
    // Those calls must surface an actionable error instead of deleting only
    // the in-memory copy and reporting success.
    persistentDbFailure ??= e;
  }
  if (!useMemory) {
    useMemory = true;
    console.warn(
      "Gallery storage unavailable — persistence disabled for this session " +
        "(generations are still saved to the output folder).",
      e,
    );
  }
}

function assertDestructivePersistenceAvailable(operation: DestructiveStoreOperation): void {
  if (nativePersistenceFailure) throw new GalleryPersistenceError(operation, nativePersistenceFailure);
  if (persistentDbFailure) throw new GalleryPersistenceError(operation, persistentDbFailure);
}

export function newId(): string {
  // Not crypto-sensitive; unique enough for gallery keys.
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Store a record while retaining the legacy `id`, fields, and blobs. */
export async function put(rec: GenRecord): Promise<void> {
  const normalized = normalizeRecord(rec);
  if (await initializeNativeStore()) {
    try {
      await writeNativeRecord(normalized);
      mem.set(normalized.id, normalized);
    } catch (error) {
      nativePersistenceFailure = error;
      fallback(error);
      mem.set(normalized.id, normalized);
    }
    return;
  }
  if (useMemory) {
    mem.set(normalized.id, normalized);
    return;
  }
  try {
    await wrap((await tx("readwrite")).put(normalized));
  } catch (e) {
    fallback(e);
    mem.set(normalized.id, normalized);
  }
}

/** List all versions, newest first. */
export async function all(): Promise<VersionRecord[]> {
  if (await initializeNativeStore()) {
    return [...mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (useMemory) {
    return [...mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  try {
    return await indexedRecords();
  } catch (e) {
    fallback(e);
    return [...mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Legacy key lookup. `id` remains the IndexedDB key for old callers. */
export async function get(id: string): Promise<VersionRecord | undefined> {
  if (await initializeNativeStore()) return mem.get(id);
  if (useMemory) return mem.get(id);
  try {
    const rec = await wrap((await tx("readonly")).get(id) as IDBRequest<GenRecord | undefined>);
    return rec ? normalizeRecord(rec) : undefined;
  } catch (e) {
    fallback(e);
    return mem.get(id);
  }
}

async function findVersion(versionId: string): Promise<VersionRecord | undefined> {
  const direct = await get(versionId);
  if (direct) return direct;
  return (await all()).find((record) => record.versionId === versionId);
}

/** List every version belonging to one stable asset/group. */
export async function listAssetVersions(assetId: string): Promise<VersionRecord[]> {
  return (await all())
    .filter((record) => record.assetId === assetId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Retrieve a version by its stable version ID (or legacy record key). */
export async function getVersion(versionId: string): Promise<VersionRecord | undefined> {
  return findVersion(versionId);
}

// Named aliases keep callers that use the higher-level generation vocabulary
// source-compatible while the underlying records gain version semantics.
export async function saveGeneration(rec: GenRecord): Promise<void> {
  await put(rec);
}

export async function listGenerations(): Promise<VersionRecord[]> {
  return all();
}

export async function getGeneration(id: string): Promise<VersionRecord | undefined> {
  return get(id);
}

export interface DerivedVersionInput {
  /** The edited or otherwise derived GLB. */
  glb: Blob;
  thumb?: Blob | null;
  input?: Blob;
  params?: GenRecord["params"];
  metrics?: ModelMetrics | null;
  operation?: VersionOperation;
  operationParams?: OperationParams;
  label?: string;
  favorite?: boolean;
}

/**
 * Create a child version without mutating the source. The source may be a
 * stored version ID or a record already held by a caller. Derived versions
 * deliberately do not inherit seed-sweep fields, so the legacy gallery does
 * not display an edited child as another sweep candidate.
 */
export async function createDerivedVersion(
  source: string | GenRecord,
  input: DerivedVersionInput,
): Promise<VersionRecord> {
  const parent = typeof source === "string" ? await getVersion(source) : normalizeRecord(source);
  if (!parent) throw new Error(`Version not found: ${source}`);
  if (!(input.glb instanceof Blob)) throw new Error("A derived version requires a GLB Blob");

  const versionId = newId();
  const operation = input.operation ?? "edited";
  const label = input.label?.trim() || `${parent.label} (${operation})`;
  const now = Date.now();
  const record: VersionRecord = {
    id: versionId,
    versionId,
    assetId: parent.assetId,
    parentVersionId: parent.versionId,
    operation,
    operationParams: input.operationParams ? { ...input.operationParams } : {},
    createdAt: now,
    ts: now,
    name: parent.name,
    label,
    favorite: input.favorite === true,
    params: input.params ?? parent.params,
    input: input.input ?? parent.input,
    glb: input.glb,
    thumb: input.thumb ?? null,
    metrics: input.metrics ?? null,
  };
  await put(record);
  return record;
}

async function updateVersion(
  versionId: string,
  update: (record: VersionRecord) => VersionRecord,
): Promise<VersionRecord> {
  const record = await findVersion(versionId);
  if (!record) throw new Error(`Version not found: ${versionId}`);
  const updated = normalizeRecord(update(record));
  await put(updated);
  return updated;
}

/** Rename a version without changing its source-image filename. */
export async function renameVersion(versionId: string, label: string): Promise<VersionRecord> {
  const nextLabel = label.trim();
  if (!nextLabel) throw new Error("Version label cannot be empty");
  return updateVersion(versionId, (record) => ({ ...record, label: nextLabel }));
}

/** Mark or unmark a version as a user favorite. */
export async function setVersionFavorite(
  versionId: string,
  favorite: boolean,
): Promise<VersionRecord> {
  return updateVersion(versionId, (record) => ({ ...record, favorite }));
}

async function deleteIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  assertDestructivePersistenceAvailable("delete");
  if (await initializeNativeStore()) {
    try {
      await deleteNativeRecords(ids);
      ids.forEach((id) => mem.delete(id));
      return;
    } catch (error) {
      nativePersistenceFailure = error;
      throw new GalleryPersistenceError("delete", error);
    }
  }
  if (useMemory) {
    ids.forEach((id) => mem.delete(id));
    return;
  }
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const transaction = d.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const id of ids) store.delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  } catch (e) {
    fallback(e);
    if (persistentDbEstablished) throw new GalleryPersistenceError("delete", e);
    ids.forEach((id) => mem.delete(id));
  }
}

export interface DeleteVersionOptions {
  /** Delete all descendants too. Defaults to false for a safe refusal. */
  cascade?: boolean;
}

/**
 * Delete a version safely. A parent with children is refused by default so a
 * history branch cannot disappear accidentally. Callers that intentionally
 * remove a complete branch can opt into a descendant cascade.
 */
export async function deleteVersion(
  versionId: string,
  options: DeleteVersionOptions = {},
): Promise<void> {
  assertDestructivePersistenceAvailable("delete");
  const records = await all();
  // `all()` may have discovered a persistent read failure and switched reads
  // to the in-memory fallback. Refuse to turn that stale view into a false
  // deletion success.
  assertDestructivePersistenceAvailable("delete");
  const target = records.find((record) => record.id === versionId || record.versionId === versionId);
  if (!target) return;

  // `parentVersionId` stores the stable version identifier, not the
  // IndexedDB key. Normalized legacy records have id === versionId, so this
  // remains compatible with v1 while keeping the two identities distinct.
  const children = records.filter((record) => record.parentVersionId === target.versionId);
  if (children.length && !options.cascade) {
    throw new Error("Cannot delete a version that has derived children; delete the branch explicitly");
  }

  // Traverse with version IDs, but delete using the physical record IDs. This
  // matters when a record intentionally has id !== versionId: otherwise a
  // grandchild whose parentVersionId points to the parent's versionId could be
  // missed after the first child is discovered.
  const lineageVersionIds = new Set<string>([target.versionId]);
  const recordIds = new Set<string>([target.id]);
  if (options.cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (
          record.parentVersionId &&
          lineageVersionIds.has(record.parentVersionId) &&
          !recordIds.has(record.id)
        ) {
          lineageVersionIds.add(record.versionId);
          recordIds.add(record.id);
          changed = true;
        }
      }
    }
  }
  await deleteIds([...recordIds]);
}

/** Legacy delete alias retained for current gallery callers. */
export async function del(id: string): Promise<void> {
  await deleteVersion(id);
}

export async function deleteGeneration(id: string): Promise<void> {
  await del(id);
}

export async function clear(): Promise<void> {
  assertDestructivePersistenceAvailable("clear");
  if (await initializeNativeStore()) {
    try {
      await clearNativeGallery();
      mem.clear();
      return;
    } catch (error) {
      nativePersistenceFailure = error;
      throw new GalleryPersistenceError("clear", error);
    }
  }
  if (useMemory) {
    mem.clear();
    return;
  }
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const transaction = d.transaction(STORE, "readwrite");
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error ?? "IndexedDB transaction failed")));
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error ?? new Error("IndexedDB transaction aborted"));
      try {
        const request = transaction.objectStore(STORE).clear();
        request.onerror = () => fail(request.error);
      } catch (error) {
        fail(error);
      }
    });
    mem.clear();
  } catch (e) {
    fallback(e);
    if (persistentDbEstablished) throw new GalleryPersistenceError("clear", e);
    mem.clear();
  }
}

/** True once the store has fallen back to in-memory (no cross-session persistence). */
export function isEphemeral(): boolean {
  return useMemory;
}
