/** Versioned binary transport shared with the native capture/replay adapter. */
export const MAX_GENERATION_BYTES = 512 * 1024 * 1024;
export const DATA_PROFILE = "textured-512-v1";
const HASH = /^[0-9a-f]{64}$/;
type Json = Record<string, unknown>;
export interface GenerationDataRef {
  sha256: string;
  bytes: number;
  profile: typeof DATA_PROFILE;
  sourceSurfaceSha256: string;
  sourceGlbSha256: string;
  /** Current version's GLB binding. Edited versions do not inherit this. */
  modelSha256: string;
}
export interface BundleEntry { name: string; offset: number; bytes: number; sha256: string; [key: string]: unknown }
export interface BinaryContainer {
  manifest: Json;
  entries: Map<string, BundleEntry>;
  entry(name: string): Promise<Blob>;
}
function object(value: unknown): value is Json { return !!value && typeof value === "object" && !Array.isArray(value); }
function requireValue(valid: unknown, message: string): asserts valid { if (!valid) throw new Error(message); }
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
export async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
}
export function validGenerationDataRef(value: unknown): value is GenerationDataRef {
  return object(value) && value.profile === DATA_PROFILE && integer(value.bytes) && value.bytes > 16 && value.bytes <= MAX_GENERATION_BYTES
    && hash(value.sha256) && hash(value.sourceSurfaceSha256) && hash(value.sourceGlbSha256) && hash(value.modelSha256);
}
export async function readBinaryContainer(blob: Blob, magic: string, schema: string, names: readonly string[]): Promise<BinaryContainer> {
  requireValue(blob.size >= 16 && blob.size <= MAX_GENERATION_BYTES, "Binary package size is invalid");
  const header = await blob.slice(0, 16).arrayBuffer();
  requireValue(new TextDecoder().decode(header.slice(0, 8)) === magic, "Unsupported binary package");
  const view = new DataView(header), length = view.getUint32(8, true), count = view.getUint32(12, true);
  requireValue(length > 0 && length <= 1024 * 1024 && count > 0 && count <= 32, "Invalid package manifest size");
  const start = 16 + Math.ceil(length / 8) * 8;
  requireValue(start <= blob.size, "Package manifest is truncated");
  const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await blob.slice(16, 16 + length).arrayBuffer()));
  requireValue(object(metadata) && metadata.schema === schema && metadata.version === 1, "Unsupported package schema");
  requireValue(Array.isArray(metadata.files) && metadata.files.length === count, "Invalid package entry count");
  const entries = new Map<string, BundleEntry>();
  let cursor = 0;
  for (const item of metadata.files) {
    requireValue(object(item) && typeof item.name === "string" && names.includes(item.name) && !entries.has(item.name), "Invalid package entry name");
    requireValue(integer(item.offset) && item.offset === cursor && integer(item.bytes) && item.bytes > 0 && hash(item.sha256), "Invalid package entry bounds");
    requireValue(item.bytes <= blob.size - start - cursor, "Package entry is truncated");
    entries.set(item.name, item as BundleEntry);
    cursor = Math.ceil((cursor + item.bytes) / 8) * 8;
  }
  requireValue(start + cursor === blob.size, "Package length does not match its manifest");
  return { manifest: metadata, entries, async entry(name) {
    const item = entries.get(name); requireValue(item, `Package has no ${name}`);
    const bytes = blob.slice(start + item.offset, start + item.offset + item.bytes);
    requireValue(await sha256(bytes) === item.sha256, `Package ${name} failed checksum verification`);
    return bytes;
  } };
}
export const GENERATION_ENTRIES = ["roots.i32", "shape.norm.f32", ...[0,1,2,3].map(i => `subdivision-${i}.u8`),
  "conditioning.f32", "original-noise.f32", "cutout.png", "surface.mesh", "dense-snap.mesh"] as const;

export async function inspectGenerationData(blob: Blob): Promise<{ reference: GenerationDataRef; container: BinaryContainer }> {
  const container = await readBinaryContainer(blob, "TRGST001", "triastasis-generation-data", GENERATION_ENTRIES);
  const m = container.manifest;
  requireValue(m.profile === DATA_PROFILE && m.resolution === 512 && m.texture_resolution === 512 && m.root_grid === 32, "Unsupported saved texture guide");
  requireValue(m.array_order === "item-major" && m.octant_order === "x-bit0-y-bit1-z-bit2" && m.negative_conditioning === "zeros", "Unsupported saved array profile");
  requireValue(m.shape_normalization === "trellis2-native-shape-f32-v1" && m.texture_normalization === "trellis2-native-texture-f32-v1", "Unsupported saved normalization");
  requireValue(hash(m.source_surface_sha256) && hash(m.source_glb_sha256) && hash(m.coordinate_order_sha256), "Saved generation provenance is missing");
  requireValue(integer(m.generation_seed) && m.generation_seed > 0 && m.generation_seed <= 0xffffffff, "Invalid saved generation seed");
  const counts = m.hierarchy_counts;
  requireValue(Array.isArray(counts) && counts.length === 5 && counts.every(n => integer(n) && n > 0 && n <= 9_000_000)
    && counts[0] <= 32768 && counts[0] === m.roots, "Invalid saved hierarchy counts");
  requireValue(container.entries.size === GENERATION_ENTRIES.length, "Saved generation payloads are incomplete");
  const dimensions = (name: string, type: string, rows: number, channels: number, width = 4) => {
    const e = container.entries.get(name)!;
    requireValue(e.dtype === type && Array.isArray(e.shape) && e.shape.length === 2 && e.shape[0] === rows && e.shape[1] === channels
      && e.bytes === rows * channels * width, `Invalid ${name} dimensions`);
  };
  dimensions("roots.i32", "int32-le", counts[0], 3);
  dimensions("shape.norm.f32", "float32-le", counts[0], 32);
  dimensions("original-noise.f32", "float32-le", counts[0], 32);
  dimensions("conditioning.f32", "float32-le", 1029, 1024);
  for (let i = 0; i < 4; i++) dimensions(`subdivision-${i}.u8`, "uint8", counts[i], 8, 1);
  for (const name of ["surface.mesh", "dense-snap.mesh"]) {
    const e = container.entries.get(name)!;
    requireValue(e.encoding === "triastasis-mesh-le-v1" && integer(e.vertices) && e.vertices > 0 && e.vertices <= 15_000_000
      && integer(e.triangles) && e.triangles > 0 && e.triangles <= 30_000_000
      && e.bytes === 8 + 12 * (e.vertices + e.triangles), `Invalid ${name} dimensions`);
  }
  requireValue(container.entries.get("surface.mesh")!.sha256 === m.source_surface_sha256, "Saved surface binding is invalid");
  // Check each entry in turn; never materialize the entire payload set at once.
  for (const name of GENERATION_ENTRIES) await container.entry(name);
  return { container, reference: { sha256: await sha256(blob), bytes: blob.size, profile: DATA_PROFILE,
    sourceSurfaceSha256: m.source_surface_sha256, sourceGlbSha256: m.source_glb_sha256, modelSha256: m.source_glb_sha256 } };
}

export interface GenerationPayload { glb: Blob; generationData?: Blob | null; generationDataRef?: GenerationDataRef; generationDataError?: string }
export async function unpackGenerationPackage(blob: Blob): Promise<GenerationPayload> {
  const container = await readBinaryContainer(blob, "TRGPK001", "triastasis-generation-package", ["model.glb", "generation.trg"]);
  const glb = (await container.entry("model.glb")).slice(0, undefined, "model/gltf-binary");
  const error = container.manifest.generation_data_error;
  if (!container.entries.has("generation.trg")) return { glb, generationDataError: object(error) && typeof error.code === "string" ? error.code : "generation_data_unavailable" };
  try {
    const generationData = await container.entry("generation.trg");
    const { reference } = await inspectGenerationData(generationData);
    requireValue(await sha256(glb) === reference.sourceGlbSha256, "Saved data does not belong to this model");
    return { glb, generationData, generationDataRef: reference };
  } catch (error) {
    return { glb, generationDataError: error instanceof Error ? error.message : "generation_data_invalid" };
  }
}
