// Persistent gallery of past generations, backed by IndexedDB. GLBs are
// 10–15 MB each — far over the ~5 MB localStorage cap — so blobs live here.
//
// IndexedDB isn't always available: some WebKitGTK builds can't create its
// backing file, and private-mode / sandboxed webviews reject it outright. When
// that happens we must NOT lose a generation — the store transparently falls
// back to an in-memory map so the gallery still works for the session, and the
// caller's auto-save to the output folder remains the on-disk deliverable.

import type {
  GenRecord,
  ModelDimensions,
  ModelMetrics,
  OperationParams,
  VersionOperation,
  VersionRecord,
} from "./types";

const DB_NAME = "trellis-studio";
/** Schema v2 adds asset/version fields and indexes, while retaining `id`. */
export const DB_VERSION = 2;
const STORE = "generations";

let dbp: Promise<IDBDatabase> | null = null;
let useMemory = false;
const mem = new Map<string, VersionRecord>();

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
    req.onsuccess = () => resolve(req.result);
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

/** Switch to the in-memory fallback and warn once. */
function fallback(e: unknown): void {
  if (!useMemory) {
    useMemory = true;
    console.warn(
      "IndexedDB unavailable — gallery persistence disabled for this session " +
        "(generations are still saved to the output folder).",
      e,
    );
  }
}

export function newId(): string {
  // Not crypto-sensitive; unique enough for gallery keys.
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Store a record while retaining the legacy `id`, fields, and blobs. */
export async function put(rec: GenRecord): Promise<void> {
  const normalized = normalizeRecord(rec);
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
  if (useMemory) {
    return [...mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  try {
    const recs = await wrap((await tx("readonly")).getAll() as IDBRequest<GenRecord[]>);
    return recs.map(normalizeRecord).sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    fallback(e);
    return [...mem.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Legacy key lookup. `id` remains the IndexedDB key for old callers. */
export async function get(id: string): Promise<VersionRecord | undefined> {
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
  const records = await all();
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
  mem.clear();
  if (useMemory) return;
  try {
    await wrap((await tx("readwrite")).clear());
  } catch (e) {
    fallback(e);
  }
}

/** True once the store has fallen back to in-memory (no cross-session persistence). */
export function isEphemeral(): boolean {
  return useMemory;
}
