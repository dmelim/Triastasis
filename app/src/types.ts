// Shared types for Trellis Studio.

export type Resolution = 512 | 1024 | 1536;
export type BgRemoval = "auto" | "birefnet" | "threshold";
export type Uv = "xatlas" | "box";
export type TargetFaces = "auto" | number;
export type AtlasSize = "auto" | number;
export type TextureResolution = "auto" | 512 | 1024;
export type RemeshBand = "auto" | number;
export type TextureEncoding = "auto" | "webp" | "png";

/** The HTTP validation bounds shared with trellis-server. */
export const GEN_PARAM_LIMITS = {
  seed: { min: 0, max: 4_294_967_295 },
  targetFaces: { min: 10_000, max: 1_000_000 },
  atlasSize: { min: 128, max: 4_096 },
  remeshBand: { min: 0, max: 8 },
} as const;

/** Generation knobs mapped onto trellis-server's POST /generate form fields. */
export interface GenParams {
  resolution: Resolution;
  seed: number;
  bgRemoval: BgRemoval;
  uv: Uv;
  /** Omit or use "auto" to keep the backend's per-resolution QEM default. */
  targetFaces?: TargetFaces;
  /** Omit to preserve the server launch default; true/false are explicit overrides. */
  texture?: boolean;
  /** Omit or use "auto" to keep the backend's per-resolution atlas default. */
  atlasSize?: AtlasSize;
  /** Omit or use "auto" to keep the backend's automatic texture decode resolution. */
  textureResolution?: TextureResolution;
  /** Omit or use "auto" to keep the backend's resolution-scaled remesh band. */
  remeshBand?: RemeshBand;
  /** Omit or use "auto" to keep the backend's WebP-if-available default. */
  textureEncoding?: TextureEncoding;
}

/** All generation fields after legacy records/defaults have been normalized. */
export type NormalizedGenParams = Required<GenParams>;

export type GenParamField = keyof GenParams;

/** Structured validation error for future field-level controls. */
export class GenParamsValidationError extends Error {
  readonly field: GenParamField;

  constructor(field: GenParamField, message: string) {
    super(`${field}: ${message}`);
    this.name = "GenParamsValidationError";
    this.field = field;
  }
}

export const DEFAULT_PARAMS: GenParams = {
  resolution: 1024,
  seed: 42,
  bgRemoval: "auto",
  uv: "xatlas",
  targetFaces: "auto",
  texture: true,
  atlasSize: "auto",
  textureResolution: "auto",
  remeshBand: "auto",
  textureEncoding: "auto",
};

function invalid(field: GenParamField, message: string): never {
  throw new GenParamsValidationError(field, message);
}

function integerInRange(field: GenParamField, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return invalid(field, "must be an integer");
  }
  if (value < min || value > max) {
    return invalid(field, `must be between ${min} and ${max}`);
  }
  return value;
}

function normalizeChoice<T extends string | number>(
  field: GenParamField,
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = value ?? fallback;
  if ((typeof normalized !== "string" && typeof normalized !== "number") || !allowed.includes(normalized as T)) {
    return invalid(field, `must be one of ${allowed.join(", ")}`);
  }
  return normalized as T;
}

/**
 * Normalize legacy/partial records before sending them to the server. Missing
 * new fields use the native backend defaults; custom values are validated with
 * the same bounds enforced by trellis-server and produce field-specific errors.
 */
export function normalizeGenParams(params: Partial<GenParams> = {}): NormalizedGenParams {
  const resolution = params.resolution ?? DEFAULT_PARAMS.resolution;
  if (resolution !== 512 && resolution !== 1024 && resolution !== 1536) {
    invalid("resolution", "must be 512, 1024, or 1536");
  }

  const seed = integerInRange(
    "seed",
    params.seed ?? DEFAULT_PARAMS.seed,
    GEN_PARAM_LIMITS.seed.min,
    GEN_PARAM_LIMITS.seed.max,
  );
  const bgRemoval = normalizeChoice("bgRemoval", params.bgRemoval, ["auto", "birefnet", "threshold"], "auto");
  const uv = normalizeChoice("uv", params.uv, ["xatlas", "box"], "xatlas");

  const rawTargetFaces = params.targetFaces ?? DEFAULT_PARAMS.targetFaces!;
  const targetFaces: TargetFaces = rawTargetFaces === "auto"
    ? "auto"
    : integerInRange("targetFaces", rawTargetFaces, GEN_PARAM_LIMITS.targetFaces.min, GEN_PARAM_LIMITS.targetFaces.max);

  const texture = params.texture ?? DEFAULT_PARAMS.texture!;
  if (typeof texture !== "boolean") invalid("texture", "must be true or false");

  const rawAtlasSize = params.atlasSize ?? DEFAULT_PARAMS.atlasSize!;
  const atlasSize: AtlasSize = rawAtlasSize === "auto"
    ? "auto"
    : integerInRange("atlasSize", rawAtlasSize, GEN_PARAM_LIMITS.atlasSize.min, GEN_PARAM_LIMITS.atlasSize.max);

  const textureResolution = normalizeChoice(
    "textureResolution",
    params.textureResolution,
    ["auto", 512, 1024] as const,
    "auto",
  );

  const rawRemeshBand = params.remeshBand ?? DEFAULT_PARAMS.remeshBand!;
  const remeshBand: RemeshBand = rawRemeshBand === "auto"
    ? "auto"
    : integerInRange("remeshBand", rawRemeshBand, GEN_PARAM_LIMITS.remeshBand.min, GEN_PARAM_LIMITS.remeshBand.max);

  const textureEncoding = normalizeChoice(
    "textureEncoding",
    params.textureEncoding,
    ["auto", "webp", "png"],
    "auto",
  );

  return {
    resolution,
    seed,
    bgRemoval,
    uv,
    targetFaces,
    texture,
    atlasSize,
    textureResolution,
    remeshBand,
    textureEncoding,
  };
}

/** A normalized bounding-box size captured from a rendered model. */
export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
}

/**
 * Metrics are deliberately independent of the viewer implementation.  A
 * record can therefore keep metrics after the viewer is replaced, and older
 * records can be upgraded without importing Three.js into the storage layer.
 */
export interface ModelMetrics {
  triangles?: number;
  renderVertices?: number;
  uniquePositions?: number;
  meshParts?: number;
  materials?: number;
  textures?: number;
  maxTextureSize?: number;
  animations?: number;
  fileSize?: number;
  dimensions?: ModelDimensions;
}

/** The operation that produced a version of an asset. */
export type VersionOperation =
  | "generated"
  | "imported"
  | "simplified"
  | "cleaned"
  | "material-edited"
  | "retopologized"
  | "rigged"
  | "edited"
  // Keep integrations extensible without making the storage schema change for
  // every future operation name.
  | (string & {});

/** Parameters supplied to a geometry/material operation. */
export type OperationParams = Record<string, unknown>;

/** Written by the installer, read by the Tauri shell + surfaced to the UI. */
export interface AppConfig {
  serverBin: string;
  modelsDir: string;
  backend: string;
  gpu: number;
  host: string;
  port: number;
  /** where generated GLBs are auto-saved (Tauri only). */
  outputDir: string;
  /** true once the shell has a usable config.json; false => "setup needed". */
  configured: boolean;
}

/** One persisted generation (IndexedDB record). */
export interface GenRecord {
  id: string;
  ts: number;
  name: string;
  params: GenParams;
  input: Blob; // source image
  glb: Blob; // resulting model/gltf-binary
  thumb: Blob | null; // model-viewer snapshot for the gallery
  /** Present when this record is one candidate inside a seed sweep. */
  sweepGroupId?: string;
  sweepIndex?: number;
  sweepCount?: number;

  /**
   * Version-model fields. They are optional on this compatibility-facing
   * type because main.ts and records written by v1 predate the schema. The
   * store normalizes every record returned from IndexedDB into VersionRecord.
   */
  assetId?: string;
  versionId?: string;
  parentVersionId?: string;
  operation?: VersionOperation;
  operationParams?: OperationParams;
  createdAt?: number;
  label?: string;
  favorite?: boolean;
  metrics?: ModelMetrics | null;
}

/** A fully normalized record returned by the version-aware store APIs. */
export interface VersionRecord extends GenRecord {
  assetId: string;
  versionId: string;
  operation: VersionOperation;
  operationParams: OperationParams;
  createdAt: number;
  label: string;
  favorite: boolean;
  metrics: ModelMetrics | null;
}
