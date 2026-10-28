import type { GalleryMetadataPatch } from "./gallery-storage";
import { parseProject, type LibraryProject } from "./projects";
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
import { inspectGenerationData, sha256, validGenerationDataRef } from "./generation-data";
import {
  clearNativeGallery,
  deleteNativeRecords,
  loadNativeGallery,
  loadNativeRecord,
  nativeGalleryRecoveryCount,
  markNativeMigrationCompleted,
  nativeMigrationWasCompleted,
  writeNativeRecord,
  updateNativeMetadata,
} from "./native-gallery";

const DB_NAME = "trellis-studio";
/** Schema v3 adds shared bundles while retaining existing version keys/indexes. */
export const DB_VERSION = 3;
const STORE = "generations";
const BUNDLES = "generation-bundles";

let dbp: Promise<IDBDatabase> | null = null;
let useMemory = false;
/** True after IndexedDB has successfully opened for this session. */
let persistentDbEstablished = false;
/** A persistent operation failed after the database was available. */
let persistentDbFailure: unknown = null;
let nativeInitialization: Promise<boolean> | null = null;
let nativePersistenceFailure: unknown = null;
const mem = new Map<string, VersionRecord>();
const memoryOnlyVersions = new Set<string>();

/** A failed save must export the retained bytes rather than query a missing disk record. */
export function versionNeedsMemoryExport(id: string): boolean { return memoryOnlyVersions.has(id); }

export type DestructiveStoreOperation = "delete" | "clear" | "save";

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
      `Could not ${operation === "save" ? "save the model" : operation === "clear" ? "clear the persistent gallery" : "delete the saved model"} ` +
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
      if (!d.objectStoreNames.contains(BUNDLES)) d.createObjectStore(BUNDLES, { keyPath: "sha256" });
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
    for (const record of nativeRecords) { mem.set(record.id, record); memoryOnlyVersions.delete(record.versionId); }

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
        for (const record of legacyRecords) {
          if (!mem.has(record.id)) { mem.set(record.id, record); memoryOnlyVersions.add(record.versionId); }
        }
        try {
          for (const record of legacyRecords) {
            if (!nativeRecords.some((nativeRecord) => nativeRecord.id === record.id)) {
              await writeNativeRecord(record);
              mem.set(record.id, { ...record, glb: null });
              memoryOnlyVersions.delete(record.versionId);
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
export interface SaveOutcome { persisted: boolean; error?: unknown; generationDataError?: string; generationDataRef?: GenRecord["generationDataRef"] }

const assetWrites = new Map<string, Promise<unknown>>();
function withAssetWrite<T>(assetId: string, write: () => Promise<T>): Promise<T> {
  const previous = assetWrites.get(assetId) ?? Promise.resolve();
  const next = previous.then(write, write);
  assetWrites.set(assetId, next);
  void next.finally(() => { if (assetWrites.get(assetId) === next) assetWrites.delete(assetId); }).catch(() => undefined);
  return next;
}

/** New candidates inherit the asset favorite; later preview saves retain current metadata. */
export function putGeneratedVersion(record: VersionRecord): Promise<SaveOutcome> {
  return withAssetWrite(record.assetId, () => withVersionWrite(record.versionId, async () => {
    const current = await getVersion(record.versionId);
    const siblings = current ? [] : await listAssetVersions(record.assetId);
    const favorite = current?.favorite ?? (siblings.length ? siblings.every(item => item.favorite) : record.favorite);
    const metadata = current ? { label: current.label, operationParams: current.operationParams } : {};
    const result = await put({ ...record, ...metadata, favorite });
    Object.assign(record, metadata, { favorite });
    if (result.persisted) {
      record.generationDataRef = result.generationDataRef;
      record.generationDataError = result.generationDataError;
      record.generationData = null;
    }
    return result;
  }));
}

/** Use current membership, serialized with candidate saves, rather than a rendered card snapshot. */
export function setAssetFavorite(assetId: string, favorite: boolean): Promise<void> {
  return withAssetWrite(assetId, async () => {
    for (const record of await listAssetVersions(assetId)) await setVersionFavorite(record.versionId, favorite);
  });
}

export async function put(rec: GenRecord, requirePersistent = false): Promise<SaveOutcome> {
  const normalized = normalizeRecord(rec);
  try {
    if (await initializeNativeStore()) {
      await writeNativeRecord(normalized);
      // The caller/viewer retains its model; the Library reloads saved bytes on demand.
      mem.set(normalized.id, { ...normalized, glb: null, generationData: null });
      memoryOnlyVersions.delete(normalized.versionId);
      return { persisted: true, generationDataError: normalized.generationDataError, generationDataRef: normalized.generationDataRef };
    }
    if (useMemory) throw nativePersistenceFailure ?? persistentDbFailure ?? new Error("Persistent storage unavailable");
    const database = await db();
    if (normalized.generationData) {
      try {
        const actual = (await inspectGenerationData(normalized.generationData)).reference;
        const reference = normalized.generationDataRef ?? actual;
        if (!validGenerationDataRef(reference) || reference.sha256 !== actual.sha256 || reference.bytes !== actual.bytes
          || reference.sourceSurfaceSha256 !== actual.sourceSurfaceSha256 || reference.sourceGlbSha256 !== actual.sourceGlbSha256
          || !normalized.glb || await sha256(normalized.glb) !== reference.modelSha256) throw new Error("Generation data is bound to a different model");
        normalized.generationDataRef = reference;
      } catch (error) {
        normalized.generationDataRef = undefined; normalized.generationData = null;
        normalized.generationDataError = error instanceof Error ? error.message : "Generation data could not be saved";
      }
    }
    const commitRecord = () => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(normalized.generationDataRef ? [STORE, BUNDLES] : STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Gallery write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Gallery write aborted"));
      const commit = () => transaction.objectStore(STORE).put({ ...normalized, generationData: null });
      if (normalized.generationDataRef) {
        const bundles = transaction.objectStore(BUNDLES);
        if (normalized.generationData) {
          bundles.put({ sha256: normalized.generationDataRef.sha256, blob: normalized.generationData }); commit();
        } else {
          const request = bundles.get(normalized.generationDataRef.sha256);
          request.onsuccess = () => {
            if (!request.result) { normalized.generationDataRef = undefined; normalized.generationDataError = "Saved generation data is missing"; }
            commit();
          };
        }
      } else commit();
    });
    try { await commitRecord(); }
    catch (error) {
      if (!normalized.generationDataRef) throw error;
      // Optional bundle/quota failures must still give the usable GLB a chance
      // to persist, in a separate transaction without a dangling reference.
      normalized.generationDataRef = undefined; normalized.generationData = null;
      normalized.generationDataError = error instanceof Error ? error.message : "Generation data could not be saved";
      await commitRecord();
    }
    mem.set(normalized.id, { ...normalized, generationData: null });
    memoryOnlyVersions.delete(normalized.versionId);
    return { persisted: true, generationDataError: normalized.generationDataError, generationDataRef: normalized.generationDataRef };
  } catch (error) {
    if (isTauri()) nativePersistenceFailure = error;
    fallback(error);
    if (requirePersistent) throw new GalleryPersistenceError("save", error);
    mem.set(normalized.id, normalized);
    memoryOnlyVersions.add(normalized.versionId);
    return { persisted: false, error };
  }
}

/** Merge newly registered versions without replacing local edits or concurrent deletions. */
export async function refreshNativeLibrary(): Promise<number> {
  if (!(await initializeNativeStore())) return 0;
  const knownIds = new Set(mem.keys());
  const records = (await loadNativeGallery()).map(normalizeRecord);
  let added = 0;
  for (const record of records) {
    // Registration only adds records. Do not replace an in-flight UI edit.
    if (!knownIds.has(record.id) && !mem.has(record.id)) {
      mem.set(record.id, record);
      added += 1;
    }
  }
  return added;
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

export interface DerivedVersionInput {
  /** Supplied explicitly only for an operation preserving the frozen surface. */
  generationDataRef?: GenRecord["generationDataRef"];
  generationData?: Blob | null;
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
    generationDataRef: input.generationDataRef,
    generationData: input.generationData,
    thumb: input.thumb ?? null,
    metrics: input.metrics ?? null,
  };
  const saved = await put(record, true);
  record.generationDataRef = saved.generationDataRef;
  record.generationDataError = saved.generationDataError;
  return record;
}

function applyProjectPatch(params: OperationParams, project: LibraryProject | null | undefined): OperationParams {
  if (project === undefined) return params;
  const { project: _previous, ...rest } = params;
  const next = parseProject(project);
  return next ? { ...rest, project: next } : rest;
}

const metadataWrites = new Map<string, Promise<unknown>>();
function withVersionWrite<T>(versionId: string, write: () => Promise<T>): Promise<T> {
  const prior = metadataWrites.get(versionId) ?? Promise.resolve();
  const next = prior.then(write, write);
  metadataWrites.set(versionId, next);
  return next.finally(() => { if (metadataWrites.get(versionId) === next) metadataWrites.delete(versionId); });
}
async function updateVersion(versionId: string, patch: GalleryMetadataPatch): Promise<VersionRecord> {
  return withVersionWrite(versionId, () => updateVersionNow(versionId, patch));
}
async function updateVersionNow(
  versionId: string,
  patch: GalleryMetadataPatch,
): Promise<VersionRecord> {
  const record = await findVersion(versionId);
  if (!record) throw new Error(`Version not found: ${versionId}`);
  const updated = normalizeRecord({
    ...record,
    ...(patch.label === undefined ? {} : { label: patch.label }),
    ...(patch.favorite === undefined ? {} : { favorite: patch.favorite }),
    ...(patch.assetLabel === undefined && patch.project === undefined ? {} : {
      operationParams: applyProjectPatch(
        patch.assetLabel === undefined ? record.operationParams : { ...record.operationParams, assetLabel: patch.assetLabel },
        patch.project,
      ),
    }),
  });
  if (await initializeNativeStore()) {
    try { await updateNativeMetadata(record.id, patch); mem.set(record.id, updated); }
    catch (error) { nativePersistenceFailure = error; throw new GalleryPersistenceError("save", error); }
  } else await put(updated, true);
  return updated;
}

/** Rename a version without changing its source-image filename. */
export async function renameVersion(versionId: string, label: string): Promise<VersionRecord> {
  const nextLabel = label.trim();
  if (!nextLabel) throw new Error("Version label cannot be empty");
  return updateVersion(versionId, { label: nextLabel });
}

export async function renameAssetLabel(versionId: string, label: string): Promise<VersionRecord> {
  if (!label.trim()) throw new Error("Asset label cannot be empty");
  return updateVersion(versionId, { assetLabel: label.trim() });
}

/** Assign a version to a project, or clear it with null. */
export async function setVersionProject(versionId: string, project: LibraryProject | null): Promise<VersionRecord> {
  return updateVersion(versionId, { project });
}

/** Mark or unmark a version as a user favorite. */
export async function setVersionFavorite(
  versionId: string,
  favorite: boolean,
): Promise<VersionRecord> {
  return updateVersion(versionId, { favorite });
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
    await collectIndexedBundles(d).catch(error => console.warn("Unused generation data could not be removed", error));
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
      const hasBundles = d.objectStoreNames?.contains(BUNDLES);
      const transaction = d.transaction(hasBundles ? [STORE, BUNDLES] : STORE, "readwrite");
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
        if (hasBundles) transaction.objectStore(BUNDLES).clear();
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

/** A native gallery failure must not be presented as a genuinely empty library. */
export function galleryLoadFailed(): boolean {
  return nativePersistenceFailure !== null;
}

/** Saved native records omitted because neither a committed nor legacy copy was readable. */
export function galleryRecoveryCount(): number {
  return nativeGalleryRecoveryCount();
}

/** Hydrate only the selected record; do not retain all opened GLBs in the Library cache. */
export async function loadVersionModel(record: VersionRecord): Promise<VersionRecord & { glb: Blob }> {
  if (record.glb) return { ...record, glb: record.glb };
  const loaded = normalizeRecord(await loadNativeRecord(record.id));
  if (!loaded.glb) throw new Error("Saved model could not be loaded");
  return { ...loaded, glb: loaded.glb };
}

export async function loadVersionGenerationData(record: VersionRecord): Promise<Blob> {
  if (record.generationData) return record.generationData;
  if (!record.generationDataRef) throw new Error("Generation data was not saved for this model");
  if (!isTauri()) {
    const value = await wrap((await db()).transaction(BUNDLES, "readonly").objectStore(BUNDLES).get(record.generationDataRef.sha256));
    if (!(value?.blob instanceof Blob) || value.blob.size !== record.generationDataRef.bytes || await sha256(value.blob) !== record.generationDataRef.sha256)
      throw new Error("Saved generation data is missing or corrupt");
    return value.blob;
  }
  const native = await import("./native-gallery");
  return native.loadNativeGenerationData(record.id);
}

async function collectIndexedBundles(database: IDBDatabase): Promise<void> {
  if (!database.objectStoreNames?.contains(BUNDLES)) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, BUNDLES], "readwrite");
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Bundle cleanup aborted"));
    const records = transaction.objectStore(STORE).getAll();
    records.onsuccess = () => {
      const used = new Set((records.result as GenRecord[]).map(record => record.generationDataRef?.sha256).filter(Boolean));
      const cursor = transaction.objectStore(BUNDLES).openCursor();
      cursor.onsuccess = () => { const item = cursor.result; if (!item) return; if (!used.has(String(item.key))) item.delete(); item.continue(); };
    };
  });
}
