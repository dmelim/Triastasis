import * as THREE from "three";
import { GLTFExporter, type GLTFExporterOptions } from "three/examples/jsm/exporters/GLTFExporter.js";

export interface GlbExportOptions {
  /** Export visible objects only; defaults to true. */
  onlyVisible?: boolean;
  /**
   * Compatibility guard: must be true when provided. A standalone GLB cannot
   * be emitted with external image dependencies, so false is rejected.
   */
  embedImages?: boolean;
  /** Optional maximum width/height for embedded textures, as a safe integer. */
  maxTextureSize?: number;
  /** Preserve explicitly authored glTF extensions from userData when enabled. */
  includeCustomExtensions?: boolean;
}

/** Export intentionally covers static GLTF roots; callers should not infer animation support. */
export const GLB_EXPORT_LIMITATIONS = [
  "Export is static: skinned meshes are rejected and no animation clips are emitted.",
  "Triangle/index topology is preserved where GLTFExporter supports it; this is not a quad-topology exporter.",
  "Textures are always embedded and must be readable by the browser/WebGL image pipeline.",
] as const;

function hasRenderable(root: THREE.Object3D): boolean {
  let renderable = false;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      renderable = true;
    }
  });
  return renderable;
}

function hasSkinnedMesh(root: THREE.Object3D): boolean {
  let skinned = false;
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh || (object as THREE.Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      skinned = true;
    }
  });
  return skinned;
}

function exportOptions(options: GlbExportOptions): GLTFExporterOptions {
  if (options.embedImages === false) {
    throw new Error("GLB export requires embedded images; embedImages=false is not supported for standalone output");
  }
  if (
    options.maxTextureSize !== undefined &&
    (!Number.isSafeInteger(options.maxTextureSize) || options.maxTextureSize <= 0)
  ) {
    throw new Error("GLB export maxTextureSize must be a positive safe integer");
  }
  const result: GLTFExporterOptions = {
    binary: true,
    // Matrix export preserves Object3D pivot transforms; GLTFExporter creates
    // a supported container node when a Three.js pivot is present.
    trs: false,
    onlyVisible: options.onlyVisible ?? true,
    // Always embed images: a binary GLB must be self-contained.
    embedImages: true,
    includeCustomExtensions: options.includeCustomExtensions ?? false,
  };
  if (options.maxTextureSize !== undefined) result.maxTextureSize = options.maxTextureSize;
  return result;
}

/** Export a static Three.js/GLTF root as an embedded binary GLB Blob. */
export async function exportGlb(root: THREE.Object3D, options: GlbExportOptions = {}): Promise<Blob> {
  if (!(root instanceof THREE.Object3D)) {
    throw new Error("GLB export requires a Three.js Object3D root");
  }
  if (!hasRenderable(root)) {
    throw new Error("GLB export requires a root containing at least one mesh, line, or point object");
  }
  if (hasSkinnedMesh(root)) {
    throw new Error("GLB export currently supports static roots only; skinned meshes and animation clips are not supported");
  }

  const exporter = new GLTFExporter();
  let result: ArrayBuffer | { [key: string]: unknown };
  try {
    result = await exporter.parseAsync(root, exportOptions(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GLB export failed: ${message}`);
  }
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("GLB export failed: exporter returned JSON instead of binary data");
  }
  if (result.byteLength === 0) {
    throw new Error("GLB export failed: exporter returned an empty binary");
  }
  return new Blob([result], { type: "model/gltf-binary" });
}
