import { Box3, BufferAttribute, BufferGeometry } from "three";

/** Position welding mode used to bridge UV/chart vertex splits. */
export type PositionWeldMode = "relative" | "exact";

const DEFAULT_WELD_RATIO = 1e-6;

/** Caller-owned association data carried through component analysis. */
export interface ComponentAnalysisOptions<TSource = unknown> {
  sourceMetadata?: TSource;
  /** Defaults to a conservative 1e-6 of the model's largest extent. */
  positionWeldMode?: PositionWeldMode;
  /** Absolute model-space tolerance; ignored in exact mode. */
  positionTolerance?: number;
}

/** A connected set of triangles sharing indexed vertices. */
export interface ConnectedComponent<TSource = unknown> {
  /** Stable for the same indexed triangle order and vertex assignment. */
  id: string;
  triangleCount: number;
  vertexCount: number;
  bounds: Box3;
  /** Triangle offsets, not index-buffer offsets. */
  triangleIndices: Uint32Array;
  /** Sorted source vertex indices used by this component. */
  vertexIndices: Uint32Array;
  minTriangleIndex: number;
  minVertexIndex: number;
  sourceMetadata?: TSource;
}

export interface ComponentAnalysis<TSource = unknown> {
  indexed: boolean;
  triangleCount: number;
  invalidTriangleCount: number;
  components: ConnectedComponent<TSource>[];
  limitations: string[];
  positionWeldMode: PositionWeldMode;
  positionTolerance: number;
  weldedVertexPairCount: number;
  sourceMetadata?: TSource;
}

class DisjointSet {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    this.rank = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) this.parent[index] = index;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(a: number, b: number): boolean {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return false;
    if (this.rank[rootA] < this.rank[rootB]) [rootA, rootB] = [rootB, rootA];
    this.parent[rootB] = rootA;
    if (this.rank[rootA] === this.rank[rootB]) this.rank[rootA] += 1;
    return true;
  }
}

function modelExtent(position: BufferAttribute): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    const x = position.getX(vertexIndex);
    const y = position.getY(vertexIndex);
    const z = position.getZ(vertexIndex);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return Number.isFinite(extent) && extent > 0 ? extent : 1;
}

interface WeldSettings {
  mode: PositionWeldMode;
  tolerance: number;
  limitations: string[];
}

function resolveWeldSettings(
  position: BufferAttribute,
  options: ComponentAnalysisOptions,
): WeldSettings {
  const mode = options.positionWeldMode ?? "relative";
  const limitations: string[] = [];
  if (mode === "exact") return { mode, tolerance: 0, limitations };

  const requested = options.positionTolerance;
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) {
    limitations.push("Invalid position tolerance was ignored; the relative default was used.");
  }
  const tolerance = requested !== undefined && Number.isFinite(requested) && requested >= 0
    ? requested
    : Math.max(modelExtent(position) * DEFAULT_WELD_RATIO, Number.EPSILON);
  return { mode, tolerance, limitations };
}

function exactPositionKey(position: BufferAttribute, vertexIndex: number): string {
  return `${position.getX(vertexIndex)}\u0000${position.getY(vertexIndex)}\u0000${position.getZ(vertexIndex)}`;
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * Join indexed vertices that occupy the same physical position. A spatial
 * hash checks only the 27 neighboring cells, so the expected cost is O(V)
 * under a bounded local density rather than an O(V²) all-pairs scan.
 */
function weldPositionVertices(
  position: BufferAttribute,
  usedVertices: Uint8Array,
  disjointSet: DisjointSet,
  settings: WeldSettings,
): number {
  let weldedVertexPairCount = 0;
  if (settings.tolerance === 0) {
    const exactPositions = new Map<string, number>();
    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
      if (!usedVertices[vertexIndex]) continue;
      const key = exactPositionKey(position, vertexIndex);
      const previous = exactPositions.get(key);
      if (previous !== undefined && disjointSet.union(previous, vertexIndex)) weldedVertexPairCount += 1;
      else if (previous === undefined) exactPositions.set(key, vertexIndex);
    }
    return weldedVertexPairCount;
  }

  const cellSize = settings.tolerance;
  const toleranceSquared = cellSize * cellSize;
  const buckets = new Map<string, number[]>();
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    if (!usedVertices[vertexIndex]) continue;
    const x = position.getX(vertexIndex);
    const y = position.getY(vertexIndex);
    const z = position.getZ(vertexIndex);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const cellZ = Math.floor(z / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          const bucket = buckets.get(cellKey(cellX + offsetX, cellY + offsetY, cellZ + offsetZ));
          if (!bucket) continue;
          for (const candidate of bucket) {
            const dx = x - position.getX(candidate);
            const dy = y - position.getY(candidate);
            const dz = z - position.getZ(candidate);
            if (dx * dx + dy * dy + dz * dz <= toleranceSquared && disjointSet.union(candidate, vertexIndex)) {
              weldedVertexPairCount += 1;
            }
          }
        }
      }
    }
    const currentKey = cellKey(cellX, cellY, cellZ);
    const currentBucket = buckets.get(currentKey);
    if (currentBucket) currentBucket.push(vertexIndex);
    else buckets.set(currentKey, [vertexIndex]);
  }
  return weldedVertexPairCount;
}

function expandBounds(bounds: Box3, position: BufferAttribute, vertexIndex: number): void {
  const x = position.getX(vertexIndex);
  const y = position.getY(vertexIndex);
  const z = position.getZ(vertexIndex);
  bounds.min.x = Math.min(bounds.min.x, x);
  bounds.min.y = Math.min(bounds.min.y, y);
  bounds.min.z = Math.min(bounds.min.z, z);
  bounds.max.x = Math.max(bounds.max.x, x);
  bounds.max.y = Math.max(bounds.max.y, y);
  bounds.max.z = Math.max(bounds.max.z, z);
}

interface ComponentBuilder<TSource> {
  root: number;
  triangles: number[];
  vertices: Set<number>;
  bounds: Box3;
  minTriangleIndex: number;
  minVertexIndex: number;
  sourceMetadata?: TSource;
}

function componentId(minTriangleIndex: number, minVertexIndex: number): string {
  // The first triangle and vertex make a deterministic key without relying
  // on traversal order or a process-local counter.
  return `component-t${minTriangleIndex.toString(36)}-v${minVertexIndex.toString(36)}`;
}

function nonIndexedAnalysis<TSource>(
  position: BufferAttribute,
  settings: WeldSettings,
  sourceMetadata?: TSource,
): ComponentAnalysis<TSource> {
  const triangleCount = Math.floor(position.count / 3);
  const components: ConnectedComponent<TSource>[] = [];
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const firstVertex = triangleIndex * 3;
    const vertexIndices = new Uint32Array([firstVertex, firstVertex + 1, firstVertex + 2]);
    const bounds = new Box3().makeEmpty();
    vertexIndices.forEach((vertexIndex) => expandBounds(bounds, position, vertexIndex));
    components.push({
      id: componentId(triangleIndex, firstVertex),
      triangleCount: 1,
      vertexCount: 3,
      bounds,
      triangleIndices: new Uint32Array([triangleIndex]),
      vertexIndices,
      minTriangleIndex: triangleIndex,
      minVertexIndex: firstVertex,
      sourceMetadata,
    });
  }

  const limitations = [
    "Geometry is non-indexed; triangles are treated as disconnected because there are no shared vertex indices.",
    "Position welding is not applied to non-indexed geometry in this analysis path.",
    "Component removal requires indexed geometry so attributes can remain aligned without rebuilding every vertex buffer.",
  ];
  if (position.count % 3 !== 0) limitations.push("Trailing non-triangle position data was ignored.");
  return {
    indexed: false,
    triangleCount,
    invalidTriangleCount: 0,
    components,
    limitations,
    positionWeldMode: settings.mode,
    positionTolerance: settings.tolerance,
    weldedVertexPairCount: 0,
    sourceMetadata,
  };
}

/**
 * Analyze connected triangle components with a union-find over indexed
 * vertices. The algorithm is O(V + T α(V)) time and O(V + T) memory, where V
 * is the position count and T is the number of indexed triangles.
 */
export function analyzeConnectedComponents<TSource = unknown>(
  geometry: BufferGeometry,
  options: ComponentAnalysisOptions<TSource> = {},
): ComponentAnalysis<TSource> {
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  const index = geometry.getIndex();
  if (!position) {
    return {
      indexed: Boolean(index),
      triangleCount: 0,
      invalidTriangleCount: 0,
      components: [],
      limitations: ["Geometry has no position attribute."],
      positionWeldMode: options.positionWeldMode ?? "relative",
      positionTolerance: 0,
      weldedVertexPairCount: 0,
      sourceMetadata: options.sourceMetadata,
    };
  }
  const weldSettings = resolveWeldSettings(position, options);
  if (!index) return nonIndexedAnalysis(position, weldSettings, options.sourceMetadata);

  const triangleCount = Math.floor(index.count / 3);
  const limitations: string[] = [...weldSettings.limitations];
  if (index.count % 3 !== 0) limitations.push("Trailing non-triangle index data was ignored.");

  const disjointSet = new DisjointSet(position.count);
  const triangleVertices = new Uint32Array(triangleCount * 3);
  const validTriangles = new Uint8Array(triangleCount);
  const usedVertices = new Uint8Array(position.count);
  let invalidTriangleCount = 0;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = triangleIndex * 3;
    const a = index.getX(offset);
    const b = index.getX(offset + 1);
    const c = index.getX(offset + 2);
    triangleVertices[offset] = a;
    triangleVertices[offset + 1] = b;
    triangleVertices[offset + 2] = c;
    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      a >= position.count ||
      b >= position.count ||
      c >= position.count
    ) {
      invalidTriangleCount += 1;
      continue;
    }
    validTriangles[triangleIndex] = 1;
    usedVertices[a] = 1;
    usedVertices[b] = 1;
    usedVertices[c] = 1;
    disjointSet.union(a, b);
    disjointSet.union(b, c);
  }
  if (invalidTriangleCount) {
    limitations.push(`${invalidTriangleCount} triangle(s) referenced vertices outside the position attribute and were ignored.`);
  }
  const weldedVertexPairCount = weldPositionVertices(position, usedVertices, disjointSet, weldSettings);

  const builders = new Map<number, ComponentBuilder<TSource>>();
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if (!validTriangles[triangleIndex]) continue;
    const offset = triangleIndex * 3;
    const a = triangleVertices[offset];
    const b = triangleVertices[offset + 1];
    const c = triangleVertices[offset + 2];
    const root = disjointSet.find(a);
    let builder = builders.get(root);
    if (!builder) {
      builder = {
        root,
        triangles: [],
        vertices: new Set<number>(),
        bounds: new Box3().makeEmpty(),
        minTriangleIndex: triangleIndex,
        minVertexIndex: Math.min(a, b, c),
        sourceMetadata: options.sourceMetadata,
      };
      builders.set(root, builder);
    }
    builder.triangles.push(triangleIndex);
    builder.vertices.add(a);
    builder.vertices.add(b);
    builder.vertices.add(c);
    builder.minTriangleIndex = Math.min(builder.minTriangleIndex, triangleIndex);
    builder.minVertexIndex = Math.min(builder.minVertexIndex, a, b, c);
    expandBounds(builder.bounds, position, a);
    expandBounds(builder.bounds, position, b);
    expandBounds(builder.bounds, position, c);
  }

  const components = [...builders.values()]
    .sort((a, b) => a.minTriangleIndex - b.minTriangleIndex)
    .map((builder) => {
      const vertexIndices = Uint32Array.from([...builder.vertices].sort((a, b) => a - b));
      return {
        id: componentId(builder.minTriangleIndex, builder.minVertexIndex),
        triangleCount: builder.triangles.length,
        vertexCount: vertexIndices.length,
        bounds: builder.bounds,
        triangleIndices: Uint32Array.from(builder.triangles),
        vertexIndices,
        minTriangleIndex: builder.minTriangleIndex,
        minVertexIndex: builder.minVertexIndex,
        sourceMetadata: builder.sourceMetadata,
      } satisfies ConnectedComponent<TSource>;
    });

  return {
    indexed: true,
    triangleCount,
    invalidTriangleCount,
    components,
    limitations,
    positionWeldMode: weldSettings.mode,
    positionTolerance: weldSettings.tolerance,
    weldedVertexPairCount,
    sourceMetadata: options.sourceMetadata,
  };
}

/** Short alias for integrations that call the result "component analysis". */
export const analyzeComponents = analyzeConnectedComponents;

export interface SeamConnectivityFixtureResult {
  passed: boolean;
  componentCount: number;
  triangleCount: number;
  weldedVertexPairCount: number;
  details: string;
}

/**
 * Small dependency-free smoke fixture for the UV-seam case: the second
 * triangle repeats both edge positions with different source indices. The
 * physical mesh must still be reported as one component.
 */
export function runDuplicatedSeamConnectivityFixture(): SeamConnectivityFixtureResult {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        0, 0, 0, // first triangle A
        1, 0, 0, // first triangle B
        0, 1, 0, // first triangle C
        0, 0, 0, // duplicated seam A'
        1, 0, 0, // duplicated seam B'
        1, -1, 0, // second triangle D
      ]),
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  const analysis = analyzeConnectedComponents(geometry, { positionWeldMode: "exact" });
  const passed = analysis.components.length === 1 && analysis.components[0]?.triangleCount === 2;
  geometry.dispose();
  return {
    passed,
    componentCount: analysis.components.length,
    triangleCount: analysis.components.reduce((sum, component) => sum + component.triangleCount, 0),
    weldedVertexPairCount: analysis.weldedVertexPairCount,
    details: passed
      ? "Duplicated seam positions joined into one physical component."
      : "Duplicated seam positions were incorrectly split into multiple components.",
  };
}
