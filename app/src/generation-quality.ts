import type { GenerationQualityWarning, ModelDimensions } from "./types";

export const PLANE_COLLAPSE_RATIO = 0.05;
export const REFERENCE_GUIDANCE =
  "Use a three-quarter view with visible depth, clear lighting, and a neutral background.";

/**
 * Background-plane attachment thresholds, chosen from classified evidence in
 * assets/reconstruction-test-set/runs/plane-metrics.json:
 *
 * - Fully collapsed outputs sit at thinRatio ≈ 0.004 with ~49% of vertices in
 *   a 5% slab (caught by the existing collapsed-plane rule).
 * - The observed background-sheet case (09-cel-shaded) passes the thin-ratio
 *   gate at 0.065 but concentrates 95% of vertices inside a 10% slab along
 *   its thinnest axis.
 * - Every healthy output (both pipeline builds) measures slab10 ≤ 0.50 and
 *   thinRatio ≥ 0.31, far below the sheet trigger.
 */
export const BACKGROUND_SHEET = {
  /** Sheet detection applies above the collapsed-plane cutoff… */
  minThinRatio: PLANE_COLLAPSE_RATIO,
  /** …and only up to this thickness, beyond which geometry is volumetric. */
  maxThinRatio: 0.2,
  /** Width of the tested slab, as a fraction of the thinnest extent. */
  slabBandFraction: 0.1,
  /** Minimum share of vertices inside that slab to call it an attached sheet. */
  slabShareMinimum: 0.85,
} as const;

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const COMPONENT_TYPE_F32 = 5126;

function finiteVector(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const vector = value.slice(0, 3);
  return vector.every((part) => typeof part === "number" && Number.isFinite(part))
    ? vector as [number, number, number]
    : null;
}

export function detectPlaneCollapse(
  dimensions: ModelDimensions | undefined,
  threshold = PLANE_COLLAPSE_RATIO,
): GenerationQualityWarning | null {
  if (!dimensions) return null;
  const axes = [dimensions.x, dimensions.y, dimensions.z];
  if (axes.some((axis) => !Number.isFinite(axis) || axis < 0)) return null;
  const largest = Math.max(...axes);
  if (largest <= Number.EPSILON) return null;
  const thinRatio = Math.min(...axes) / largest;
  if (thinRatio >= threshold) return null;
  return {
    code: "collapsed-plane",
    message: "Collapsed into a plane",
    thinRatio,
    threshold,
    dimensions: { ...dimensions },
  };
}

/**
 * Attached-background-sheet detector: a model can pass the bounding-box
 * thin-ratio gate while most of its vertices still lie inside one narrow
 * slab along the thinnest axis (the classic "character glued onto a large
 * flat sheet" failure). Requires vertex data; returns null when unavailable.
 */
export function detectBackgroundPlane(
  dimensions: ModelDimensions | undefined,
  slabShare: number | null,
): GenerationQualityWarning | null {
  if (!dimensions || slabShare === null) return null;
  const axes = [dimensions.x, dimensions.y, dimensions.z];
  const largest = Math.max(...axes);
  if (largest <= Number.EPSILON) return null;
  const thinRatio = Math.min(...axes) / largest;
  const { minThinRatio, maxThinRatio, slabShareMinimum } = BACKGROUND_SHEET;
  if (thinRatio < minThinRatio || thinRatio >= maxThinRatio) return null;
  if (slabShare < slabShareMinimum) return null;
  return {
    code: "background-plane-attached",
    message: "Background sheet attached",
    thinRatio,
    threshold: slabShareMinimum,
    dimensions: { ...dimensions },
  };
}

interface PositionSource {
  accessorIndices: number[];
}

function positionAccessors(json: unknown): PositionSource | null {
  if (!json || typeof json !== "object") return null;
  const document = json as {
    meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>;
    accessors?: unknown[];
  };
  if (!Array.isArray(document.meshes) || !Array.isArray(document.accessors)) return null;
  const accessorIndices: number[] = [];
  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.attributes?.POSITION;
      if (Number.isInteger(index) && (index as number) >= 0) accessorIndices.push(index as number);
    }
  }
  return { accessorIndices };
}

function dimensionsFromBounds(
  lower: [number, number, number],
  upper: [number, number, number],
): ModelDimensions | null {
  return {
    x: upper[0] - lower[0],
    y: upper[1] - lower[1],
    z: upper[2] - lower[2],
  };
}

/** Largest fraction of coordinates inside any window of `fraction * range`. */
export function maxSlabShare(coords: number[], fraction: number): number {
  if (!coords.length) return 0;
  const sorted = [...coords].sort((a, b) => a - b);
  const band = (sorted[sorted.length - 1] - sorted[0]) * fraction;
  let best = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right] - sorted[left] > band) left += 1;
    best = Math.max(best, right - left + 1);
  }
  return best / sorted.length;
}

function readAccessorFloats(
  accessorIndex: number,
  gltf: { accessors?: unknown[]; bufferViews?: unknown[] },
  binary: Uint8Array,
): Float32Array | null {
  const accessor = gltf.accessors?.[accessorIndex] as
    | { componentType?: number; type?: string; count?: number; bufferView?: number; byteOffset?: number }
    | undefined;
  if (!accessor || accessor.componentType !== COMPONENT_TYPE_F32 || accessor.type !== "VEC3") return null;
  const view = gltf.bufferViews?.[accessor.bufferView ?? -1] as
    | { byteOffset?: number; byteStride?: number }
    | undefined;
  if (!view) return null;
  const stride = view.byteStride ?? 12;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const count = accessor.count ?? 0;
  if (count <= 0) return null;
  const needed = base + stride * (count - 1) + 12;
  if (needed > binary.length) return null;
  const out = new Float32Array(count * 3);
  const dataView = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  for (let i = 0; i < count; i += 1) {
    const offset = base + i * stride;
    out[i * 3] = dataView.getFloat32(offset, true);
    out[i * 3 + 1] = dataView.getFloat32(offset + 4, true);
    out[i * 3 + 2] = dataView.getFloat32(offset + 8, true);
  }
  return out;
}

interface Inspection {
  dimensions: ModelDimensions | null;
  warning: GenerationQualityWarning | null;
  slabShare: number | null;
}

function analyzeGltfDocument(
  json: unknown,
  binary: Uint8Array | null,
): Inspection {
  let lower: [number, number, number] = [Infinity, Infinity, Infinity];
  let upper: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = false;
  const sources = positionAccessors(json);
  if (!sources) return { dimensions: null, warning: null, slabShare: null };

  const document = json as { accessors?: Array<{ min?: unknown; max?: unknown }> };
  for (const index of sources.accessorIndices) {
    const accessor = document.accessors?.[index];
    const min = finiteVector(accessor?.min);
    const max = finiteVector(accessor?.max);
    if (!min || !max) continue;
    found = true;
    for (let axis = 0; axis < 3; axis += 1) {
      lower[axis] = Math.min(lower[axis], min[axis]);
      upper[axis] = Math.max(upper[axis], max[axis]);
    }
  }
  if (!found) return { dimensions: null, warning: null, slabShare: null };

  const dimensions = dimensionsFromBounds(lower, upper)!;

  // Vertex-level sheet analysis needs the binary chunk and f32 positions.
  let slabShare: number | null = null;
  if (binary && sources.accessorIndices.length) {
    try {
      const axes = [dimensions.x, dimensions.y, dimensions.z];
      const largest = Math.max(...axes);
      if (largest > Number.EPSILON) {
        const thinAxis = axes.indexOf(Math.min(...axes));
        const thickness = axes[thinAxis];
        if (thickness > Number.EPSILON) {
          const coords: number[] = [];
          for (const accessorIndex of sources.accessorIndices) {
            const floats = readAccessorFloats(accessorIndex, json as never, binary);
            if (!floats) continue;
            for (let i = 0; i < floats.length; i += 3) coords.push(floats[i + thinAxis]);
          }
          if (coords.length) slabShare = maxSlabShare(coords, BACKGROUND_SHEET.slabBandFraction);
        }
      }
    } catch {
      slabShare = null;
    }
  }

  const warning =
    detectPlaneCollapse(dimensions) ??
    detectBackgroundPlane(dimensions, slabShare);
  return { dimensions, warning, slabShare };
}

/** Inspect a GLB for dimensions and quality warnings without opening it in the viewer. */
export async function inspectGeneratedGlb(glb: Blob): Promise<{
  dimensions: ModelDimensions | null;
  warning: GenerationQualityWarning | null;
}> {
  if (glb.size < 20) return { dimensions: null, warning: null };
  const header = await glb.slice(0, 12).arrayBuffer();
  const view = new DataView(header);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    return { dimensions: null, warning: null };
  }

  // Collect both chunks first: the binary payload feeds vertex-level metrics.
  let jsonChunk: string | null = null;
  let binaryChunk: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= glb.size) {
    const chunkHeader = new DataView(await glb.slice(offset, offset + 8).arrayBuffer());
    const length = chunkHeader.getUint32(0, true);
    const type = chunkHeader.getUint32(4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > glb.size) break;
    if (type === GLB_JSON_CHUNK && jsonChunk === null) {
      jsonChunk = new TextDecoder().decode(await glb.slice(start, end).arrayBuffer()).replace(/[\u0000\u0020]+$/g, "");
    } else if (type === GLB_BINARY_CHUNK && binaryChunk === null) {
      binaryChunk = new Uint8Array(await glb.slice(start, end).arrayBuffer());
    }
    offset = end;
  }
  if (jsonChunk === null) return { dimensions: null, warning: null };
  try {
    const parsed = JSON.parse(jsonChunk);
    const inspection = analyzeGltfDocument(parsed, binaryChunk);
    return { dimensions: inspection.dimensions, warning: inspection.warning };
  } catch {
    return { dimensions: null, warning: null };
  }
}
