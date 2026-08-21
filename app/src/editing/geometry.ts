import { BufferAttribute } from "three";
import type { BufferGeometry } from "three";
import {
  analyzeConnectedComponents,
  type ComponentAnalysis,
} from "./components";

export interface GeometryOperationResult {
  /** Always a clone; the input geometry is never mutated. */
  geometry: BufferGeometry;
  changed: boolean;
  limitations: string[];
  removedComponentIds?: string[];
}

export interface RemoveComponentsOptions<TSource = unknown> {
  /** Reuse analysis from the same source geometry to avoid a second scan. */
  analysis?: ComponentAnalysis<TSource>;
  /** Recalculate normals after removal; off by default to preserve authored normals. */
  recomputeNormals?: boolean;
}

export interface WindingOptions {
  /** Rebuild normals from positions after swapping each triangle's winding. */
  recomputeNormals?: boolean;
}

/**
 * BufferGeometry.clone() deep-copies the index and vertex attributes through
 * BufferGeometry.copy(). Keeping this in one named helper makes ownership
 * explicit to edit commands and prevents accidental scene-object mutation.
 */
export function cloneGeometry(source: BufferGeometry): BufferGeometry {
  return source.clone();
}

function makeIndexArray(source: ArrayLike<number>, values: number[]): Uint8Array | Uint16Array | Uint32Array {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (source instanceof Uint8Array && max <= 0xff) return Uint8Array.from(values);
  if (source instanceof Uint16Array && max <= 0xffff) return Uint16Array.from(values);
  return Uint32Array.from(values);
}

function materialByTriangle(geometry: BufferGeometry, triangleCount: number): Int32Array {
  const materials = new Int32Array(triangleCount);
  for (const group of geometry.groups) {
    const start = Math.max(0, Math.floor(group.start / 3));
    const end = Math.min(triangleCount, Math.ceil((group.start + group.count) / 3));
    for (let triangleIndex = start; triangleIndex < end; triangleIndex += 1) {
      materials[triangleIndex] = group.materialIndex ?? 0;
    }
  }
  return materials;
}

function restoreMaterialGroups(
  geometry: BufferGeometry,
  materialIndices: number[],
): void {
  geometry.clearGroups();
  if (!materialIndices.length) return;
  let runStart = 0;
  let materialIndex = materialIndices[0];
  for (let triangleIndex = 1; triangleIndex < materialIndices.length; triangleIndex += 1) {
    if (materialIndices[triangleIndex] === materialIndex) continue;
    geometry.addGroup(runStart * 3, (triangleIndex - runStart) * 3, materialIndex);
    runStart = triangleIndex;
    materialIndex = materialIndices[triangleIndex];
  }
  geometry.addGroup(runStart * 3, (materialIndices.length - runStart) * 3, materialIndex);
}

/**
 * Remove selected connected components from an indexed geometry. Vertex
 * attributes (including UVs and morph attributes) are cloned untouched, so
 * removed vertices may remain as unreferenced data. Material groups are
 * rebuilt in retained triangle order.
 */
export function removeConnectedComponents<TSource = unknown>(
  source: BufferGeometry,
  selectedComponentIds: Iterable<string>,
  options: RemoveComponentsOptions<TSource> = {},
): GeometryOperationResult {
  const analysis = options.analysis ?? analyzeConnectedComponents<TSource>(source);
  const requested = new Set(selectedComponentIds);
  const known = new Set(analysis.components.map((component) => component.id));
  const unknownIds = [...requested].filter((id) => !known.has(id));
  const removedComponents = analysis.components.filter((component) => requested.has(component.id));
  const limitations = [...analysis.limitations];

  if (!removedComponents.length) {
    if (unknownIds.length) limitations.push(`Unknown component ID(s) were ignored: ${unknownIds.join(", ")}.`);
    if (analysis.invalidTriangleCount > 0) {
      limitations.push("Invalid triangles were retained because no valid component was selected for removal.");
    }
    return {
      geometry: cloneGeometry(source),
      changed: false,
      limitations,
      removedComponentIds: [],
    };
  }

  const index = source.getIndex();
  if (!index) {
    limitations.push("Removing components is currently supported only for indexed geometry.");
    return {
      geometry: cloneGeometry(source),
      changed: false,
      limitations,
      removedComponentIds: [],
    };
  }

  const removedIds = new Set(removedComponents.map((component) => component.id));
  const componentByTriangle = new Int32Array(analysis.triangleCount);
  componentByTriangle.fill(-1);
  analysis.components.forEach((component, componentIndex) => {
    component.triangleIndices.forEach((triangleIndex) => {
      if (triangleIndex < componentByTriangle.length) componentByTriangle[triangleIndex] = componentIndex;
    });
  });
  const materialIndices = materialByTriangle(source, analysis.triangleCount);
  const outputIndices: number[] = [];
  const outputMaterials: number[] = [];
  let droppedInvalidTriangleCount = 0;
  for (let triangleIndex = 0; triangleIndex < analysis.triangleCount; triangleIndex += 1) {
    const componentIndex = componentByTriangle[triangleIndex];
    const component = componentIndex >= 0 ? analysis.components[componentIndex] : undefined;
    if (!component) {
      if (analysis.invalidTriangleCount > 0) {
        droppedInvalidTriangleCount += 1;
        continue;
      }
      limitations.push("Component analysis did not map every source triangle; removal was refused.");
      return {
        geometry: cloneGeometry(source),
        changed: false,
        limitations,
        removedComponentIds: [],
      };
    }
    if (component && removedIds.has(component.id)) continue;
    const offset = triangleIndex * 3;
    outputIndices.push(index.getX(offset), index.getX(offset + 1), index.getX(offset + 2));
    outputMaterials.push(materialIndices[triangleIndex]);
  }

  const geometry = cloneGeometry(source);
  geometry.setIndex(new BufferAttribute(makeIndexArray(index.array, outputIndices), 1));
  if (source.groups.length) restoreMaterialGroups(geometry, outputMaterials);
  geometry.setDrawRange(0, outputIndices.length);
  if (source.drawRange.start !== 0 || source.drawRange.count !== Infinity) {
    limitations.push("The output draw range was reset to the retained index range.");
  }
  limitations.push("Unreferenced vertex attributes are retained; a later compaction pass can reduce buffer size.");
  if (options.recomputeNormals) {
    geometry.computeVertexNormals();
  } else {
    limitations.push("Normals were preserved and may need recalculation around removed component boundaries.");
  }
  if (index.count % 3 !== 0) limitations.push("Trailing non-triangle index data was dropped.");
  if (droppedInvalidTriangleCount) {
    limitations.push(`${droppedInvalidTriangleCount} invalid triangle(s) reported by analysis were dropped.`);
  }

  return {
    geometry,
    changed: true,
    limitations,
    removedComponentIds: removedComponents.map((component) => component.id),
  };
}

/** Short alias retained for edit-tool integrations. */
export const removeComponents = removeConnectedComponents;

/**
 * Swap the second and third index of every triangle. Existing normals are
 * negated when possible; callers can request a full normal rebuild instead.
 * A conventional vec4 tangent keeps its xyz direction but changes handedness
 * when the triangle winding is reversed, so its w component is flipped too.
 * Malformed tangent attributes are removed rather than left silently stale.
 */
export function reverseTriangleWinding(
  source: BufferGeometry,
  options: WindingOptions = {},
): GeometryOperationResult {
  const geometry = cloneGeometry(source);
  const index = geometry.getIndex();
  const limitations: string[] = [];
  if (!index) {
    return {
      geometry,
      changed: false,
      limitations: ["Triangle winding reversal currently requires indexed geometry."],
    };
  }

  const triangleCount = Math.floor(index.count / 3);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = triangleIndex * 3;
    const second = index.getX(offset + 1);
    index.setX(offset + 1, index.getX(offset + 2));
    index.setX(offset + 2, second);
  }
  index.needsUpdate = true;

  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  if (options.recomputeNormals) {
    geometry.computeVertexNormals();
  } else if (normal) {
    for (let vertexIndex = 0; vertexIndex < normal.count; vertexIndex += 1) {
      normal.setXYZ(
        vertexIndex,
        -normal.getX(vertexIndex),
        -normal.getY(vertexIndex),
        -normal.getZ(vertexIndex),
      );
    }
    normal.needsUpdate = true;
  } else {
    limitations.push("No normal attribute was present; recalculate normals before shaded rendering.");
  }

  const tangent = geometry.getAttribute("tangent") as BufferAttribute | undefined;
  if (tangent) {
    const position = geometry.getAttribute("position") as BufferAttribute | undefined;
    if (tangent.itemSize !== 4 || !position || tangent.count !== position.count) {
      geometry.deleteAttribute("tangent");
      limitations.push(
        "The tangent attribute was removed because it was not a matching vec4 per-vertex attribute; " +
          "recalculate tangents before normal-mapped rendering.",
      );
    } else {
      // For a standard tangent frame, reversing the triangle order flips N
      // while the UV-derived tangent direction stays the same. Negating w
      // preserves the bitangent orientation reconstructed by the shader.
      for (let vertexIndex = 0; vertexIndex < tangent.count; vertexIndex += 1) {
        tangent.setW(vertexIndex, -tangent.getW(vertexIndex));
      }
      tangent.needsUpdate = true;
    }
  }
  if (index.count % 3 !== 0) limitations.push("Trailing non-triangle index data was left unchanged.");

  return { geometry, changed: true, limitations };
}

/** Recalculate vertex normals on a cloned geometry without changing winding. */
export function repairNormals(source: BufferGeometry): GeometryOperationResult {
  const geometry = cloneGeometry(source);
  if (!geometry.getAttribute("position")) {
    return {
      geometry,
      changed: false,
      limitations: ["Geometry has no position attribute; normals could not be recalculated."],
    };
  }
  geometry.computeVertexNormals();
  const limitations: string[] = [];
  if (!geometry.getIndex()) {
    limitations.push("Non-indexed geometry keeps one independently calculated normal per vertex occurrence.");
  } else {
    limitations.push("Existing hard edges remain split only where the source geometry already splits vertices.");
  }
  return { geometry, changed: true, limitations };
}

/** Explicit alias for callers that prefer the operation's verb. */
export const recalculateNormals = repairNormals;
