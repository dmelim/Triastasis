import * as THREE from "three";

export type MaterialLike = THREE.Material | THREE.Material[];
export type RenderableObject = THREE.Mesh | THREE.Line | THREE.Points;
export type Vector3Tuple = [number, number, number];
export type EulerTuple = [number, number, number];

export class SceneEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneEditError";
  }
}

export class SceneEditValidationError extends SceneEditError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "SceneEditValidationError";
    this.field = field;
  }
}

function materialList(value: MaterialLike): THREE.Material[] {
  return Array.isArray(value) ? value : [value];
}

function materialValue(object: THREE.Object3D): MaterialLike | null {
  const candidate = object as unknown as { material?: unknown };
  const value = candidate.material;
  if (value instanceof THREE.Material) return value;
  if (Array.isArray(value) && value.every((entry) => entry instanceof THREE.Material)) {
    return value as THREE.Material[];
  }
  return null;
}

function geometryValue(object: THREE.Object3D): THREE.BufferGeometry | null {
  const candidate = object as unknown as { geometry?: unknown };
  return candidate.geometry instanceof THREE.BufferGeometry ? candidate.geometry : null;
}

function containsSkinnedMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh || (object as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      found = true;
    }
  });
  return found;
}

/**
 * An isolated scene graph for non-destructive static editing.
 *
 * Geometries, materials, and texture objects are owned clones. A texture clone
 * may share immutable image/source data with its source, but it has an
 * independent Three.js/GPU texture lifetime. Consequently, disposing this
 * scene is safe even if the source viewer loads another GLB and disposes its
 * textures. The source root itself is not owned or disposed by this class.
 */
export class EditableScene {
  readonly sourceRoot: THREE.Object3D;
  readonly root: THREE.Object3D;
  readonly textureOwnership = "owned-clone" as const;
  readonly ownedGeometries: ReadonlySet<THREE.BufferGeometry>;
  readonly ownedMaterials: ReadonlySet<THREE.Material>;
  readonly ownedTextures: ReadonlySet<THREE.Texture>;
  private disposedState = false;

  constructor(
    sourceRoot: THREE.Object3D,
    root: THREE.Object3D,
    ownedGeometries: Set<THREE.BufferGeometry>,
    ownedMaterials: Set<THREE.Material>,
    ownedTextures: Set<THREE.Texture>,
  ) {
    this.sourceRoot = sourceRoot;
    this.root = root;
    this.ownedGeometries = ownedGeometries;
    this.ownedMaterials = ownedMaterials;
    this.ownedTextures = ownedTextures;
  }

  get disposed(): boolean {
    return this.disposedState;
  }

  /** Dispose all resources cloned by this scene exactly once; source resources are untouched. */
  dispose(): void {
    if (this.disposedState) return;
    this.disposedState = true;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
    this.root.clear();
  }
}

function cloneTexture(
  source: THREE.Texture,
  textureClones: Map<THREE.Texture, THREE.Texture>,
  ownedTextures: Set<THREE.Texture>,
): THREE.Texture {
  const existing = textureClones.get(source);
  if (existing) return existing;
  let clone: THREE.Texture;
  try {
    // Texture.clone() creates an independent GPU texture object while it may
    // retain the source image/Source data, which is safe to share read-only.
    clone = source.clone();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SceneEditError(`Could not clone a material texture: ${message}`);
  }
  textureClones.set(source, clone);
  ownedTextures.add(clone);
  return clone;
}

/**
 * Pair source and cloned-material object graphs so each source Texture maps to
 * one owned clone. This also handles ShaderMaterial uniform textures, whose
 * Material.clone() implementation already creates an intermediate texture.
 */
function replaceTextureReferences(
  sourceValue: unknown,
  targetValue: unknown,
  textureClones: Map<THREE.Texture, THREE.Texture>,
  ownedTextures: Set<THREE.Texture>,
  visited = new Set<object>(),
): void {
  if (
    sourceValue === null ||
    typeof sourceValue !== "object" ||
    sourceValue instanceof THREE.Texture ||
    targetValue === null ||
    typeof targetValue !== "object"
  ) return;
  if (visited.has(sourceValue)) return;
  visited.add(sourceValue);

  if (Array.isArray(sourceValue)) {
    if (!Array.isArray(targetValue)) return;
    for (let index = 0; index < sourceValue.length; index += 1) {
      const sourceChild = sourceValue[index];
      if (sourceChild instanceof THREE.Texture) {
        targetValue[index] = cloneTexture(sourceChild, textureClones, ownedTextures);
      } else {
        replaceTextureReferences(
          sourceChild,
          targetValue[index],
          textureClones,
          ownedTextures,
          visited,
        );
      }
    }
    return;
  }

  const sourceRecord = sourceValue as Record<string, unknown>;
  const targetRecord = targetValue as Record<string, unknown>;
  for (const key of Object.keys(sourceRecord)) {
    const sourceChild = sourceRecord[key];
    if (sourceChild instanceof THREE.Texture) {
      targetRecord[key] = cloneTexture(sourceChild, textureClones, ownedTextures);
    } else {
      replaceTextureReferences(
        sourceChild,
        targetRecord[key],
        textureClones,
        ownedTextures,
        visited,
      );
    }
  }
}

function cloneMaterial(
  source: THREE.Material,
  textureClones: Map<THREE.Texture, THREE.Texture>,
  ownedTextures: Set<THREE.Texture>,
): THREE.Material {
  const clone = source.clone();
  replaceTextureReferences(source, clone, textureClones, ownedTextures);
  return clone;
}

/** Clone a static GLTF root without sharing mutable geometry/material state. */
export function cloneEditableScene(sourceRoot: THREE.Object3D): EditableScene {
  if (containsSkinnedMesh(sourceRoot)) {
    throw new SceneEditError("Editable scene cloning currently supports static roots; skinned meshes are not supported.");
  }

  let root: THREE.Object3D;
  try {
    root = sourceRoot.clone(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SceneEditError(`Could not clone the GLTF scene: ${message}`);
  }

  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  const textureClones = new Map<THREE.Texture, THREE.Texture>();
  const ownedTextures = new Set<THREE.Texture>();

  const cloneResources = (source: THREE.Object3D, target: THREE.Object3D): void => {
    const sourceGeometry = geometryValue(source);
    const sourceMaterial = materialValue(source);
    if (sourceGeometry) {
      // Always clone per renderable object. Two source objects may reference
      // one geometry, but editing one mesh part must not mutate the other.
      const geometry = sourceGeometry.clone();
      ownedGeometries.add(geometry);

      const targetRecord = target as unknown as {
        geometry: THREE.BufferGeometry;
        material?: MaterialLike;
      };
      targetRecord.geometry = geometry;
      if (sourceMaterial) {
        const materials = materialList(sourceMaterial).map((material) => {
          // Clone each mesh's material slot independently so editing one part
          // cannot unexpectedly change another part that shared a source material.
          const clone = cloneMaterial(material, textureClones, ownedTextures);
          ownedMaterials.add(clone);
          return clone;
        });
        targetRecord.material = Array.isArray(sourceMaterial) ? materials : materials[0];
      }
    }

    for (let index = 0; index < source.children.length; index += 1) {
      const sourceChild = source.children[index];
      const targetChild = target.children[index];
      if (targetChild) cloneResources(sourceChild, targetChild);
    }
  };

  cloneResources(sourceRoot, root);
  return new EditableScene(sourceRoot, root, ownedGeometries, ownedMaterials, ownedTextures);
}

/** Idempotent cleanup helper for callers that do not retain the class instance. */
export function disposeEditableScene(scene: EditableScene): void {
  scene.dispose();
}

export interface TransformSnapshot {
  objectUuid: string;
  position: Vector3Tuple;
  rotation: EulerTuple;
  rotationOrder: THREE.EulerOrder;
  scale: Vector3Tuple;
  /** Three.js pivot is local-space and is exported as a supported node transform. */
  pivot: Vector3Tuple | null;
}

export type TransformOperation =
  | { kind: "position"; value: Vector3Tuple }
  | { kind: "rotation"; value: EulerTuple; order?: THREE.EulerOrder }
  | { kind: "scale"; value: Vector3Tuple }
  | { kind: "pivot"; value: Vector3Tuple | null };

export interface TransformEditResult {
  changed: boolean;
  before: TransformSnapshot;
  after: TransformSnapshot;
  limitations: string[];
}

function tuple(value: readonly number[], field: string): Vector3Tuple {
  if (value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    throw new SceneEditValidationError(field, "must contain three finite numbers");
  }
  return [value[0], value[1], value[2]];
}

function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function captureTransformSnapshot(target: THREE.Object3D): TransformSnapshot {
  return {
    objectUuid: target.uuid,
    position: tuple(target.position.toArray(), "position"),
    rotation: tuple([target.rotation.x, target.rotation.y, target.rotation.z], "rotation"),
    rotationOrder: target.rotation.order,
    scale: tuple(target.scale.toArray(), "scale"),
    pivot: target.pivot ? tuple(target.pivot.toArray(), "pivot") : null,
  };
}

export function restoreTransformSnapshot(target: THREE.Object3D, snapshot: TransformSnapshot): void {
  if (target.uuid !== snapshot.objectUuid) {
    throw new SceneEditError("Transform snapshot belongs to a different Object3D");
  }
  target.position.fromArray(snapshot.position);
  target.rotation.set(snapshot.rotation[0], snapshot.rotation[1], snapshot.rotation[2], snapshot.rotationOrder);
  target.scale.fromArray(snapshot.scale);
  target.pivot = snapshot.pivot ? new THREE.Vector3(...snapshot.pivot) : null;
  target.updateMatrixWorld(true);
}

/** Apply one serializable Object3D-level transform operation and return history snapshots. */
export function applyTransformOperation(
  target: THREE.Object3D,
  operation: TransformOperation,
): TransformEditResult {
  const before = captureTransformSnapshot(target);
  switch (operation.kind) {
    case "position":
      target.position.fromArray(tuple(operation.value, "position"));
      break;
    case "rotation":
      target.rotation.set(
        ...tuple(operation.value, "rotation"),
        operation.order ?? target.rotation.order,
      );
      break;
    case "scale":
      target.scale.fromArray(tuple(operation.value, "scale"));
      break;
    case "pivot":
      target.pivot = operation.value === null
        ? null
        : new THREE.Vector3(...tuple(operation.value, "pivot"));
      break;
    default:
      return operation satisfies never;
  }
  target.updateMatrixWorld(true);
  const after = captureTransformSnapshot(target);
  const changed =
    !sameTuple(before.position, after.position) ||
    !sameTuple(before.rotation, after.rotation) ||
    before.rotationOrder !== after.rotationOrder ||
    !sameTuple(before.scale, after.scale) ||
    (before.pivot === null) !== (after.pivot === null) ||
    (before.pivot !== null && after.pivot !== null && !sameTuple(before.pivot, after.pivot));
  return { changed, before, after, limitations: [] };
}

export interface MaterialEdit {
  baseColor?: THREE.ColorRepresentation | readonly [number, number, number];
  metalness?: number;
  roughness?: number;
  opacity?: number;
}

export interface MaterialEditOptions {
  /** Omit to apply the edit to every slot; set to target one slot in an array. */
  materialIndex?: number;
}

export interface MaterialSnapshot {
  objectUuid: string;
  materialIndex: number;
  materialType: string;
  baseColor?: Vector3Tuple;
  metalness?: number;
  roughness?: number;
  opacity: number;
  transparent: boolean;
}

export interface MaterialEditResult {
  changed: boolean;
  before: MaterialSnapshot[];
  after: MaterialSnapshot[];
  limitations: string[];
}

function materialSnapshot(object: THREE.Object3D, material: THREE.Material, materialIndex: number): MaterialSnapshot {
  const record = material as unknown as Record<string, unknown>;
  const color = record.color instanceof THREE.Color
    ? tuple([record.color.r, record.color.g, record.color.b], "baseColor")
    : undefined;
  const opacity = typeof record.opacity === "number" && Number.isFinite(record.opacity) ? record.opacity : 1;
  return {
    objectUuid: object.uuid,
    materialIndex,
    materialType: material.type,
    baseColor: color,
    metalness: typeof record.metalness === "number" ? record.metalness : undefined,
    roughness: typeof record.roughness === "number" ? record.roughness : undefined,
    opacity,
    transparent: material.transparent,
  };
}

function ownMaterialSnapshots(object: THREE.Object3D): MaterialSnapshot[] {
  const value = materialValue(object);
  return value ? materialList(value).map((material, index) => materialSnapshot(object, material, index)) : [];
}

/** Capture primitive-only snapshots for all renderable objects under a root. */
export function captureMaterialSnapshots(root: THREE.Object3D): MaterialSnapshot[] {
  const snapshots: MaterialSnapshot[] = [];
  root.traverse((object) => snapshots.push(...ownMaterialSnapshots(object)));
  return snapshots;
}

export const captureMaterialSnapshot = captureMaterialSnapshots;

function clampUnit(field: string, value: unknown, limitations: Set<string>): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SceneEditValidationError(field, "must be a finite number");
  }
  const clamped = Math.min(1, Math.max(0, value));
  if (clamped !== value) limitations.add(`${field} was clamped to the range 0..1`);
  return clamped;
}

function normalizeColor(
  value: THREE.ColorRepresentation | readonly [number, number, number],
  limitations: Set<string>,
): THREE.Color {
  let color: THREE.Color;
  if (Array.isArray(value)) {
    if (value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new SceneEditValidationError("baseColor", "must be a color representation or three finite channels");
    }
    color = new THREE.Color(
      clampUnit("baseColor.r", value[0], limitations),
      clampUnit("baseColor.g", value[1], limitations),
      clampUnit("baseColor.b", value[2], limitations),
    );
  } else {
    try {
      color = new THREE.Color(value as THREE.ColorRepresentation);
    } catch {
      throw new SceneEditValidationError("baseColor", "is not a valid Three.js color representation");
    }
    color.r = clampUnit("baseColor.r", color.r, limitations);
    color.g = clampUnit("baseColor.g", color.g, limitations);
    color.b = clampUnit("baseColor.b", color.b, limitations);
  }
  return color;
}

function selectedMaterialIndices(value: MaterialLike, requested: number | undefined): number[] {
  const count = materialList(value).length;
  if (requested === undefined) return Array.from({ length: count }, (_, index) => index);
  if (!Number.isInteger(requested) || requested < 0 || requested >= count) {
    throw new SceneEditValidationError("materialIndex", `must be an integer from 0 to ${Math.max(0, count - 1)}`);
  }
  return [requested];
}

/** Apply a validated PBR edit to one mesh/line/points part and return history snapshots. */
export function applyMaterialEdit(
  target: THREE.Object3D,
  edit: MaterialEdit,
  options: MaterialEditOptions = {},
): MaterialEditResult {
  const value = materialValue(target);
  if (!value) throw new SceneEditError("Material edits require a renderable mesh part with a material");
  if (Object.keys(edit).length === 0) throw new SceneEditValidationError("material", "at least one editable property is required");

  const limitations = new Set<string>();
  const baseColor = edit.baseColor === undefined ? undefined : normalizeColor(edit.baseColor, limitations);
  const metalness = edit.metalness === undefined ? undefined : clampUnit("metalness", edit.metalness, limitations);
  const roughness = edit.roughness === undefined ? undefined : clampUnit("roughness", edit.roughness, limitations);
  const opacity = edit.opacity === undefined ? undefined : clampUnit("opacity", edit.opacity, limitations);
  const before = ownMaterialSnapshots(target);
  const materials = materialList(value);
  for (const index of selectedMaterialIndices(value, options.materialIndex)) {
    const material = materials[index];
    const record = material as unknown as Record<string, unknown>;
    if (baseColor) {
      if (record.color instanceof THREE.Color) record.color.copy(baseColor);
      else limitations.add(`Material slot ${index} does not expose a base color and was left unchanged`);
    }
    if (metalness !== undefined) {
      if (typeof record.metalness === "number") record.metalness = metalness;
      else limitations.add(`Material slot ${index} does not expose metalness and was left unchanged`);
    }
    if (roughness !== undefined) {
      if (typeof record.roughness === "number") record.roughness = roughness;
      else limitations.add(`Material slot ${index} does not expose roughness and was left unchanged`);
    }
    if (opacity !== undefined) {
      record.opacity = opacity;
      // Keep the blend state in sync with the edited opacity. In particular,
      // changing a previously translucent material back to 1 must leave the
      // material on the opaque render path instead of retaining stale blending.
      material.transparent = opacity < 1;
    }
    material.needsUpdate = true;
  }
  const after = ownMaterialSnapshots(target);
  return {
    changed: JSON.stringify(before) !== JSON.stringify(after),
    before: options.materialIndex === undefined ? before : before.filter((snapshot) => snapshot.materialIndex === options.materialIndex),
    after: options.materialIndex === undefined ? after : after.filter((snapshot) => snapshot.materialIndex === options.materialIndex),
    limitations: [...limitations],
  };
}

function objectMap(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const objects = new Map<string, THREE.Object3D>();
  root.traverse((object) => objects.set(object.uuid, object));
  return objects;
}

/** Restore snapshots against a cloned root; returns non-fatal missing-target limitations. */
export function restoreMaterialSnapshots(root: THREE.Object3D, snapshots: readonly MaterialSnapshot[]): string[] {
  const objects = objectMap(root);
  const limitations = new Set<string>();
  for (const snapshot of snapshots) {
    const object = objects.get(snapshot.objectUuid);
    const value = object ? materialValue(object) : null;
    const material = value ? materialList(value)[snapshot.materialIndex] : undefined;
    if (!object || !material) {
      limitations.add(`Material snapshot target ${snapshot.objectUuid} slot ${snapshot.materialIndex} was not found`);
      continue;
    }
    const record = material as unknown as Record<string, unknown>;
    if (snapshot.baseColor && record.color instanceof THREE.Color) record.color.setRGB(...snapshot.baseColor);
    if (snapshot.metalness !== undefined && typeof record.metalness === "number") record.metalness = snapshot.metalness;
    if (snapshot.roughness !== undefined && typeof record.roughness === "number") record.roughness = snapshot.roughness;
    record.opacity = snapshot.opacity;
    material.transparent = snapshot.transparent;
    material.needsUpdate = true;
  }
  return [...limitations];
}
