import type { GenerationQualityWarning, ModelDimensions } from "./types";

export const PLANE_COLLAPSE_RATIO = 0.05;
export const REFERENCE_GUIDANCE =
  "Use a three-quarter view with visible depth, clear lighting, and a neutral background.";

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

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

function dimensionsFromGltf(json: unknown): ModelDimensions | null {
  if (!json || typeof json !== "object") return null;
  const document = json as { meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: number } }> }>; accessors?: unknown[] };
  if (!Array.isArray(document.meshes) || !Array.isArray(document.accessors)) return null;

  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.attributes?.POSITION;
      if (!Number.isInteger(index) || (index as number) < 0) continue;
      const accessor = document.accessors[index as number] as { min?: unknown; max?: unknown } | undefined;
      const min = finiteVector(accessor?.min);
      const max = finiteVector(accessor?.max);
      if (!min || !max) continue;
      found = true;
      for (let axis = 0; axis < 3; axis += 1) {
        lower[axis] = Math.min(lower[axis], min[axis]);
        upper[axis] = Math.max(upper[axis], max[axis]);
      }
    }
  }
  if (!found) return null;
  return { x: upper[0] - lower[0], y: upper[1] - lower[1], z: upper[2] - lower[2] };
}

/** Inspect accessor bounds without loading the GLB into the interactive viewer. */
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

  let offset = 12;
  while (offset + 8 <= glb.size) {
    const chunkHeader = new DataView(await glb.slice(offset, offset + 8).arrayBuffer());
    const length = chunkHeader.getUint32(0, true);
    const type = chunkHeader.getUint32(4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > glb.size) break;
    if (type === GLB_JSON_CHUNK) {
      try {
        const raw = new TextDecoder().decode(await glb.slice(start, end).arrayBuffer()).replace(/[\u0000\u0020]+$/g, "");
        const dimensions = dimensionsFromGltf(JSON.parse(raw));
        return { dimensions, warning: detectPlaneCollapse(dimensions ?? undefined) };
      } catch {
        return { dimensions: null, warning: null };
      }
    }
    offset = end;
  }
  return { dimensions: null, warning: null };
}
