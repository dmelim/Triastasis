import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type DisplayMode =
  | "textured"
  | "clay"
  | "wireframe"
  | "overlay"
  | "normals"
  | "normal"
  | "uv"
  | "uv-checker"
  | "base-color"
  | "baseColor"
  | "metallic"
  | "metalness"
  | "roughness"
  | "unlit";

export type CameraPreset = "isometric" | "front" | "back" | "left" | "right" | "top" | "bottom";
export type CameraType = "perspective" | "orthographic";
export type TopologyDetail = "adaptive" | "coarse" | "full";

export interface ViewerStats {
  triangles: number;
  renderVertices: number;
  meshParts: number;
  materials: number;
  textures: number;
  maxTextureSize: number;
  animations: number;
  fileSize: number;
  dimensions: { x: number; y: number; z: number };
}

export interface ViewerSelection {
  mesh: THREE.Mesh;
  node: THREE.Object3D;
  name: string;
  meshIndex: number;
  triangleIndex: number | null;
  triangles: number;
}

export type SelectionListener = (selection: ViewerSelection | null) => void;

const EMPTY_STATS: ViewerStats = {
  triangles: 0,
  renderVertices: 0,
  meshParts: 0,
  materials: 0,
  textures: 0,
  maxTextureSize: 0,
  animations: 0,
  fileSize: 0,
  dimensions: { x: 0, y: 0, z: 0 },
};

const DEFAULT_BACKGROUND = 0x0d1016;
const TOPOLOGY_LINE_NAME = "polyloom-topology-lines";
const CHECKER_SIZE = 128;

type ViewerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type MaterialValue = THREE.Material | THREE.Material[];
type MaterialRecord = Record<string, unknown>;

interface TopologyLines {
  mesh: THREE.Mesh;
  coarse: THREE.LineSegments | null;
  full: THREE.LineSegments | null;
}

function materialList(material: MaterialValue): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function textureDimensions(texture: THREE.Texture): { width: number; height: number } {
  const source = texture.source?.data as { width?: number; height?: number } | undefined;
  const image = texture.image as { width?: number; height?: number } | undefined;
  return {
    width: Number(source?.width ?? image?.width ?? 0),
    height: Number(source?.height ?? image?.height ?? 0),
  };
}

function collectTextures(material: THREE.Material, into: Set<THREE.Texture>): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) into.add(value);
  }
}

function materialRecord(material: THREE.Material): MaterialRecord {
  return material as unknown as MaterialRecord;
}

function getTexture(material: THREE.Material, property: string): THREE.Texture | null {
  const value = materialRecord(material)[property];
  return value instanceof THREE.Texture ? value : null;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  return Math.floor((index?.count ?? position?.count ?? 0) / 3);
}

function normalizedDisplayMode(mode: DisplayMode): DisplayMode {
  if (mode === "normal") return "normals";
  if (mode === "uv-checker") return "uv";
  if (mode === "baseColor") return "base-color";
  if (mode === "metalness") return "metallic";
  return mode;
}

/**
 * The viewer owns the parsed GLTF scene and all inspection-only GPU objects.
 *
 * GLBs are parsed from an ArrayBuffer rather than through a blob URL, so this
 * class does not create object URLs while loading. The explicit URL set is
 * retained for future loader paths and is revoked by dispose if one is
 * registered.
 */
export class Viewer {
  private readonly mount: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  private activeCamera: ViewerCamera;
  private controls: OrbitControls<ViewerCamera>;
  private readonly loader = new GLTFLoader();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  private readonly fillLight = new THREE.HemisphereLight(0xdde8ff, 0x29303c, 2.1);
  private readonly clayMaterial = new THREE.MeshStandardMaterial({
    color: 0xc8ccd3,
    metalness: 0.05,
    roughness: 0.72,
    side: THREE.DoubleSide,
  });
  private readonly wireSuppressionMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly coarseTopologyMaterial = new THREE.LineBasicMaterial({
    color: 0x8faeff,
    transparent: true,
    opacity: 0.52,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly fullTopologyMaterial = new THREE.LineBasicMaterial({
    color: 0xaec2ff,
    transparent: true,
    opacity: 0.88,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly resizeObserver: ResizeObserver;
  private readonly selectionListeners = new Set<SelectionListener>();
  private readonly ownedObjectUrls = new Set<string>();
  private loadedRoot: THREE.Object3D | null = null;
  private meshes: THREE.Mesh[] = [];
  private originals = new Map<THREE.Mesh, MaterialValue>();
  private initialVisibility = new Map<THREE.Mesh, boolean>();
  private hiddenMeshes = new Set<THREE.Mesh>();
  private topologyLines: TopologyLines[] = [];
  private activeInspectionMaterials = new Set<THREE.Material>();
  private bounds = new THREE.Box3();
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private selectionHelper: THREE.BoxHelper | null = null;
  private selection: ViewerSelection | null = null;
  private checkerTexture: THREE.DataTexture | null = null;
  private displayMode: DisplayMode = "textured";
  private topologyDetail: TopologyDetail = "adaptive";
  private gridVisible = true;
  private axesVisible = false;
  private shadowsEnabled = true;
  private cameraType: CameraType = "perspective";
  private orthoHeight = 2;
  private stats: ViewerStats = { ...EMPTY_STATS };
  private animationFrame = 0;
  private disposed = false;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.activeCamera = this.perspectiveCamera;
    this.scene.background = new THREE.Color(DEFAULT_BACKGROUND);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = "viewer-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D model viewer");
    mount.appendChild(this.renderer.domElement);

    this.controls = this.createControls(this.activeCamera);
    this.fillLight.position.set(0, 1, 0);
    this.scene.add(this.fillLight);
    this.keyLight.position.set(4, 6, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.keyLight);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mount);
    this.resize();
    this.animationFrame = window.requestAnimationFrame(this.animate);
  }

  async load(glb: Blob): Promise<ViewerStats> {
    const buffer = await glb.arrayBuffer();
    const result = await this.loader.parseAsync(buffer, "");
    return this.loadRoot(result.scene, glb.size, result.animations.length);
  }

  /** Adopt an already parsed root, such as the cloned root used by editing. */
  loadRoot(root: THREE.Object3D, fileSize = 0, animations = 0): ViewerStats {
    if (this.disposed) throw new Error("The viewer has been disposed");
    if (!(root instanceof THREE.Object3D)) throw new Error("Viewer root must be a Three.js Object3D");
    this.clearModel();
    this.loadedRoot = root;
    this.scene.add(root);

    this.collectLoadedStats(fileSize, animations);
    this.buildTopologyLines();
    this.rebuildHelpers();
    this.setDisplayMode(this.displayMode);
    this.setCameraPreset("isometric");
    return this.getStats();
  }

  /** Return the current parsed or adopted root for read-only integrations. */
  getLoadedRoot(): THREE.Object3D | null {
    return this.loadedRoot;
  }

  /** Replace one loaded mesh geometry without changing scene ownership. */
  replaceMeshGeometry(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): boolean {
    if (!this.meshes.includes(mesh)) return false;
    mesh.geometry = geometry;
    return true;
  }

  /** Recompute inspection stats and topology after an in-place edit. */
  refresh(fileSize = this.stats.fileSize, animations = this.stats.animations): ViewerStats {
    if (!this.loadedRoot) return this.getStats();
    const selectedMesh = this.selection?.mesh ?? null;
    const selectedTriangle = this.selection?.triangleIndex ?? null;

    this.bounds.setFromObject(this.loadedRoot);
    this.collectLoadedStats(fileSize, animations, true);
    this.buildTopologyLines();
    this.rebuildHelpers();
    this.setDisplayMode(this.displayMode);
    if (selectedMesh && this.meshes.includes(selectedMesh)) {
      this.selectMesh(selectedMesh, selectedTriangle);
    }
    return this.getStats();
  }

  private collectLoadedStats(fileSize: number, animations: number, preserveState = false): void {
    const root = this.loadedRoot;
    if (!root) return;

    const previousOriginals = preserveState ? new Map(this.originals) : new Map<THREE.Mesh, MaterialValue>();
    const previousInitialVisibility = preserveState ? new Map(this.initialVisibility) : new Map<THREE.Mesh, boolean>();
    const previousHidden = preserveState ? new Set(this.hiddenMeshes) : new Set<THREE.Mesh>();
    this.meshes = [];
    this.originals.clear();
    this.initialVisibility.clear();
    this.hiddenMeshes.clear();
    const materialSet = new Set<THREE.Material>();
    const textureSet = new Set<THREE.Texture>();
    let triangles = 0;
    let renderVertices = 0;

    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      this.meshes.push(object);
      const original = previousOriginals.get(object) ?? object.material;
      this.originals.set(object, original);
      this.initialVisibility.set(object, previousInitialVisibility.get(object) ?? object.visible);
      if (previousHidden.has(object)) this.hiddenMeshes.add(object);
      object.castShadow = this.shadowsEnabled;
      object.receiveShadow = this.shadowsEnabled;

      const position = object.geometry.getAttribute("position");
      const index = object.geometry.getIndex();
      renderVertices += position?.count ?? 0;
      triangles += Math.floor((index?.count ?? position?.count ?? 0) / 3);
      for (const material of materialList(original)) {
        materialSet.add(material);
        collectTextures(material, textureSet);
      }
    });

    this.bounds.setFromObject(root);
    const size = this.bounds.getSize(new THREE.Vector3());
    let maxTextureSize = 0;
    for (const texture of textureSet) {
      const imageSize = textureDimensions(texture);
      maxTextureSize = Math.max(maxTextureSize, imageSize.width, imageSize.height);
    }

    this.stats = {
      triangles,
      renderVertices,
      meshParts: this.meshes.length,
      materials: materialSet.size,
      textures: textureSet.size,
      maxTextureSize,
      animations,
      fileSize,
      dimensions: { x: size.x, y: size.y, z: size.z },
    };
  }

  clear(): void {
    this.clearModel();
    this.stats = { ...EMPTY_STATS };
  }

  /**
   * Free the renderer, controls, model resources, helpers, and observer.
   * Call this when the owning workspace is unmounted.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.releaseObjectUrls();
    this.checkerTexture?.dispose();
    this.checkerTexture = null;
    this.clayMaterial.dispose();
    this.wireSuppressionMaterial.dispose();
    this.coarseTopologyMaterial.dispose();
    this.fullTopologyMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.selectionListeners.clear();
  }

  /**
   * Register a URL owned by the viewer. load itself does not need one,
   * because GLTFLoader receives an ArrayBuffer; this is for future URL-based
   * loading paths and makes their lifetime explicit.
   */
  trackObjectUrl(url: string): string {
    this.ownedObjectUrls.add(url);
    return url;
  }

  getStats(): ViewerStats {
    return {
      ...this.stats,
      dimensions: { ...this.stats.dimensions },
    };
  }

  getDisplayMode(): DisplayMode {
    return this.displayMode;
  }

  resetView(): void {
    this.setCameraPreset("isometric");
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = normalizedDisplayMode(mode);
    this.restoreOriginalMaterials();

    for (const mesh of this.meshes) {
      const original = this.originals.get(mesh);
      if (!original) continue;
      if (this.displayMode === "clay") {
        mesh.material = this.clayMaterial;
      } else if (this.displayMode === "normals") {
        mesh.material = this.makeNormalsMaterials(original);
      } else if (this.displayMode === "uv") {
        mesh.material = this.makeUvMaterials(original);
      } else if (
        this.displayMode === "base-color" ||
        this.displayMode === "metallic" ||
        this.displayMode === "roughness"
      ) {
        mesh.material = this.makeChannelMaterials(original, this.displayMode);
      } else if (this.displayMode === "unlit") {
        mesh.material = this.makeUnlitMaterials(original);
      } else if (this.displayMode === "wireframe") {
        mesh.material = this.wireSuppressionMaterial;
      } else {
        mesh.material = original;
      }
    }

    this.updateDisplayVisibility();
    this.updateTopologyVisibility();
  }

  setTopologyDetail(detail: TopologyDetail): void {
    this.topologyDetail = detail;
    this.updateTopologyVisibility();
  }

  getTopologyDetail(): TopologyDetail {
    return this.topologyDetail;
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    if (this.grid) this.grid.visible = visible;
  }

  setAxesVisible(visible: boolean): void {
    this.axesVisible = visible;
    if (this.axes) this.axes.visible = visible;
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = 1.4;
  }

  setBackground(color: string): void {
    this.scene.background = new THREE.Color(color);
  }

  setExposure(exposure: number): void {
    this.renderer.toneMappingExposure = Math.max(0.25, Math.min(2.5, exposure));
  }

  setShadows(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.keyLight.castShadow = enabled;
    for (const mesh of this.meshes) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
  }

  getCameraType(): CameraType {
    return this.cameraType;
  }

  setCameraType(type: CameraType): void {
    if (type === this.cameraType) return;
    const previousPosition = this.activeCamera.position.clone();
    const previousQuaternion = this.activeCamera.quaternion.clone();
    const target = this.controls.target.clone();
    const cursor = this.controls.cursor.clone();
    const controlState = {
      enabled: this.controls.enabled,
      enableDamping: this.controls.enableDamping,
      dampingFactor: this.controls.dampingFactor,
      screenSpacePanning: this.controls.screenSpacePanning,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance,
      minZoom: this.controls.minZoom,
      maxZoom: this.controls.maxZoom,
      minTargetRadius: this.controls.minTargetRadius,
      maxTargetRadius: this.controls.maxTargetRadius,
      minPolarAngle: this.controls.minPolarAngle,
      maxPolarAngle: this.controls.maxPolarAngle,
      minAzimuthAngle: this.controls.minAzimuthAngle,
      maxAzimuthAngle: this.controls.maxAzimuthAngle,
      enableZoom: this.controls.enableZoom,
      zoomSpeed: this.controls.zoomSpeed,
      enableRotate: this.controls.enableRotate,
      rotateSpeed: this.controls.rotateSpeed,
      enablePan: this.controls.enablePan,
      panSpeed: this.controls.panSpeed,
      keyPanSpeed: this.controls.keyPanSpeed,
      zoomToCursor: this.controls.zoomToCursor,
      autoRotate: this.controls.autoRotate,
      autoRotateSpeed: this.controls.autoRotateSpeed,
    };
    this.controls.dispose();

    this.cameraType = type;
    this.activeCamera = type === "perspective" ? this.perspectiveCamera : this.orthographicCamera;
    this.activeCamera.position.copy(previousPosition);
    this.activeCamera.quaternion.copy(previousQuaternion);
    this.controls = this.createControls(this.activeCamera);
    this.controls.target.copy(target);
    this.controls.cursor.copy(cursor);
    this.controls.enabled = controlState.enabled;
    this.controls.enableDamping = controlState.enableDamping;
    this.controls.dampingFactor = controlState.dampingFactor;
    this.controls.screenSpacePanning = controlState.screenSpacePanning;
    this.controls.minDistance = controlState.minDistance;
    this.controls.maxDistance = controlState.maxDistance;
    this.controls.minZoom = controlState.minZoom;
    this.controls.maxZoom = controlState.maxZoom;
    this.controls.minTargetRadius = controlState.minTargetRadius;
    this.controls.maxTargetRadius = controlState.maxTargetRadius;
    this.controls.minPolarAngle = controlState.minPolarAngle;
    this.controls.maxPolarAngle = controlState.maxPolarAngle;
    this.controls.minAzimuthAngle = controlState.minAzimuthAngle;
    this.controls.maxAzimuthAngle = controlState.maxAzimuthAngle;
    this.controls.enableZoom = controlState.enableZoom;
    this.controls.zoomSpeed = controlState.zoomSpeed;
    this.controls.enableRotate = controlState.enableRotate;
    this.controls.rotateSpeed = controlState.rotateSpeed;
    this.controls.enablePan = controlState.enablePan;
    this.controls.panSpeed = controlState.panSpeed;
    this.controls.keyPanSpeed = controlState.keyPanSpeed;
    this.controls.zoomToCursor = controlState.zoomToCursor;
    this.controls.autoRotate = controlState.autoRotate;
    this.controls.autoRotateSpeed = controlState.autoRotateSpeed;
    this.updateCameraProjection();
    this.controls.update();
    this.updateTopologyVisibility();
  }

  setCameraPreset(preset: CameraPreset): void {
    if (!this.loadedRoot || this.bounds.isEmpty()) return;
    const direction = new THREE.Vector3(1, 0.72, 1);
    if (preset === "front") direction.set(0, 0, 1);
    if (preset === "back") direction.set(0, 0, -1);
    if (preset === "left") direction.set(-1, 0, 0);
    if (preset === "right") direction.set(1, 0, 0);
    if (preset === "top") direction.set(0, 1, 0.001);
    if (preset === "bottom") direction.set(0, -1, 0.001);
    this.frameBounds(this.bounds, direction);
  }

  /**
   * Raycast against mesh primitives using client coordinates from the canvas.
   * The returned selection is a mesh/node-level component with an optional
   * triangle index from the raycast hit.
   */
  selectAt(clientX: number, clientY: number): ViewerSelection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const candidates = this.meshes.filter((mesh) => !this.hiddenMeshes.has(mesh));
    const hits = this.raycaster.intersectObjects(candidates, false);
    const hit = hits.find((candidate) => candidate.object instanceof THREE.Mesh);
    if (!hit || !(hit.object instanceof THREE.Mesh)) {
      this.clearSelection();
      return null;
    }
    return this.selectMesh(hit.object, hit.faceIndex ?? null);
  }

  /** Select a mesh primitive directly, useful for list-based inspector UIs. */
  selectMesh(mesh: THREE.Mesh | null, triangleIndex: number | null = null): ViewerSelection | null {
    if (!mesh || !this.meshes.includes(mesh)) {
      this.clearSelection();
      return null;
    }
    const meshIndex = this.meshes.indexOf(mesh);
    this.selection = {
      mesh,
      node: mesh,
      name: mesh.name || "Mesh " + (meshIndex + 1),
      meshIndex,
      triangleIndex,
      triangles: triangleCount(mesh.geometry),
    };
    if (!this.selectionHelper) {
      this.selectionHelper = new THREE.BoxHelper(mesh, 0xffc857);
      this.selectionHelper.name = "polyloom-selection-helper";
      this.selectionHelper.material.depthTest = false;
      this.selectionHelper.material.depthWrite = false;
      this.scene.add(this.selectionHelper);
    } else {
      this.selectionHelper.object = mesh;
      this.selectionHelper.setFromObject(mesh);
    }
    this.selectionHelper.visible = !this.hiddenMeshes.has(mesh);
    this.emitSelection();
    return { ...this.selection };
  }

  getSelection(): ViewerSelection | null {
    return this.selection ? { ...this.selection } : null;
  }

  /** Return the currently loaded mesh primitives for an inspector list. */
  getMeshParts(): readonly THREE.Mesh[] {
    return [...this.meshes];
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    this.emitSelection();
  }

  onSelectionChanged(listener: SelectionListener): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  setMeshVisible(mesh: THREE.Mesh, visible: boolean): boolean {
    if (!this.meshes.includes(mesh)) return false;
    if (visible) {
      this.hiddenMeshes.delete(mesh);
      this.initialVisibility.set(mesh, true);
    } else {
      this.hiddenMeshes.add(mesh);
    }
    this.updateDisplayVisibility();
    this.updateTopologyVisibility();
    if (this.selection?.mesh === mesh && !visible && this.selectionHelper) {
      this.selectionHelper.visible = false;
    }
    return true;
  }

  hideSelection(): boolean {
    const mesh = this.selection?.mesh;
    return mesh ? this.setMeshVisible(mesh, false) : false;
  }

  isolateSelection(): boolean {
    const selected = this.selection?.mesh;
    if (!selected) return false;
    for (const mesh of this.meshes) {
      if (mesh === selected) {
        this.hiddenMeshes.delete(mesh);
        this.initialVisibility.set(mesh, true);
      } else {
        this.hiddenMeshes.add(mesh);
      }
    }
    this.updateDisplayVisibility();
    this.updateTopologyVisibility();
    if (this.selectionHelper) this.selectionHelper.visible = true;
    return true;
  }

  showAll(): void {
    this.hiddenMeshes.clear();
    for (const mesh of this.meshes) this.initialVisibility.set(mesh, true);
    this.updateDisplayVisibility();
    this.updateTopologyVisibility();
    if (this.selectionHelper) this.selectionHelper.visible = Boolean(this.selection);
  }

  frameSelection(): boolean {
    const mesh = this.selection?.mesh;
    if (!mesh) return false;
    const selectionBounds = new THREE.Box3().setFromObject(mesh);
    if (selectionBounds.isEmpty()) return false;
    const direction = this.activeCamera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-8) direction.set(1, 0.72, 1);
    this.frameBounds(selectionBounds, direction);
    return true;
  }

  async thumbnail(): Promise<Blob | null> {
    const activeMode = this.displayMode;
    const selectionHelperVisible = this.selectionHelper?.visible ?? false;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    try {
      this.setDisplayMode("textured");
      this.renderer.render(this.scene, this.activeCamera);
      const blob = await new Promise<Blob | null>((resolve) => {
        this.renderer.domElement.toBlob((value) => resolve(value), "image/png");
      });
      return blob;
    } catch {
      return null;
    } finally {
      this.setDisplayMode(activeMode);
      if (this.selectionHelper) this.selectionHelper.visible = selectionHelperVisible;
    }
  }

  private createControls(camera: ViewerCamera): OrbitControls<ViewerCamera> {
    const controls = new OrbitControls(camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.01;
    controls.minZoom = 0.1;
    controls.maxZoom = 20;
    controls.autoRotateSpeed = 1.4;
    controls.addEventListener("change", this.handleControlsChange);
    return controls;
  }

  private readonly handleControlsChange = (): void => {
    this.updateTopologyVisibility();
  };

  private resize(): void {
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    this.updateCameraProjection(width / height);
    this.renderer.setSize(width, height, false);
  }

  private updateCameraProjection(aspectOverride?: number): void {
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    const aspect = aspectOverride ?? width / height;
    if (this.cameraType === "perspective") {
      this.perspectiveCamera.aspect = aspect;
      this.perspectiveCamera.updateProjectionMatrix();
      return;
    }
    const halfHeight = Math.max(this.orthoHeight * 0.5, 0.001);
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.top = halfHeight;
    this.orthographicCamera.bottom = -halfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  private frameBounds(targetBounds: THREE.Box3, direction: THREE.Vector3): void {
    const center = targetBounds.getCenter(new THREE.Vector3());
    const size = targetBounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.01);
    direction.normalize();

    if (this.cameraType === "perspective") {
      const fov = THREE.MathUtils.degToRad(this.perspectiveCamera.fov);
      const distance = Math.max(radius / Math.sin(fov * 0.5), radius * 2.2);
      this.perspectiveCamera.position.copy(center).addScaledVector(direction, distance);
      this.perspectiveCamera.near = Math.max(distance / 1000, 0.001);
      this.perspectiveCamera.far = Math.max(distance * 20, 100);
      this.perspectiveCamera.lookAt(center);
      this.perspectiveCamera.updateProjectionMatrix();
    } else {
      const aspect = Math.max(this.mount.clientWidth, 1) / Math.max(this.mount.clientHeight, 1);
      this.orthoHeight = Math.max(size.y, size.x / aspect, size.z, 0.01) * 1.35;
      this.updateCameraProjection(aspect);
      this.orthographicCamera.position.copy(center).addScaledVector(direction, Math.max(radius * 2.2, 1));
      this.orthographicCamera.near = 0.001;
      this.orthographicCamera.far = Math.max(radius * 20, 100);
      this.orthographicCamera.lookAt(center);
      this.orthographicCamera.updateProjectionMatrix();
    }

    this.controls.target.copy(center);
    this.controls.maxDistance = Math.max(radius * 8, 0.1);
    this.controls.update();
    this.updateTopologyVisibility();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.controls.update();
    this.updateTopologyTransforms();
    if (this.selectionHelper && this.selection) {
      this.selectionHelper.update();
      this.selectionHelper.visible = !this.hiddenMeshes.has(this.selection.mesh);
    }
    this.renderer.render(this.scene, this.activeCamera);
    this.animationFrame = window.requestAnimationFrame(this.animate);
  };

  private makeNormalsMaterials(original: MaterialValue): MaterialValue {
    return this.mapMaterials(original, (source) => {
      const material = new THREE.MeshNormalMaterial({ side: source.side, flatShading: false });
      material.toneMapped = false;
      this.activeInspectionMaterials.add(material);
      return material;
    });
  }

  private makeUvMaterials(original: MaterialValue): MaterialValue {
    const checker = this.getCheckerTexture();
    return this.mapMaterials(original, (source) => {
      const material = this.makeBasicMaterial(source, checker);
      material.color.set(0xffffff);
      material.transparent = false;
      material.opacity = 1;
      material.toneMapped = false;
      this.activeInspectionMaterials.add(material);
      return material;
    });
  }

  private makeUnlitMaterials(original: MaterialValue): MaterialValue {
    return this.mapMaterials(original, (source) => {
      const material = this.makeBasicMaterial(source, getTexture(source, "map"));
      this.activeInspectionMaterials.add(material);
      return material;
    });
  }

  private makeChannelMaterials(
    original: MaterialValue,
    mode: "base-color" | "metallic" | "roughness",
  ): MaterialValue {
    return this.mapMaterials(original, (source) => {
      if (mode === "base-color") {
        const material = this.makeBasicMaterial(source, getTexture(source, "map"));
        material.toneMapped = false;
        this.activeInspectionMaterials.add(material);
        return material;
      }
      const sourceRecord = materialRecord(source);
      const factorValue = Number(sourceRecord[mode === "metallic" ? "metalness" : "roughness"] ?? 0);
      const map = getTexture(source, mode === "metallic" ? "metalnessMap" : "roughnessMap");
      const channel = mode === "metallic" ? 0 : 1;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          channelMap: { value: map },
          hasMap: { value: Boolean(map) },
          factor: { value: Number.isFinite(factorValue) ? factorValue : 0 },
          channel: { value: channel },
        },
        vertexShader: [
          "varying vec2 vUv;",
          "void main() {",
          "  vUv = uv;",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform sampler2D channelMap;",
          "uniform bool hasMap;",
          "uniform float factor;",
          "uniform int channel;",
          "varying vec2 vUv;",
          "void main() {",
          "  float value = factor;",
          "  if (hasMap) {",
          "    vec4 sampleValue = texture2D(channelMap, vUv);",
          "    value *= channel == 0 ? sampleValue.b : sampleValue.g;",
          "  }",
          "  gl_FragColor = vec4(vec3(clamp(value, 0.0, 1.0)), 1.0);",
          "}",
        ].join("\n"),
        side: source.side,
        depthWrite: source.depthWrite,
        depthTest: source.depthTest,
      });
      material.toneMapped = false;
      this.activeInspectionMaterials.add(material);
      return material;
    });
  }

  private mapMaterials(
    original: MaterialValue,
    mapper: (source: THREE.Material) => THREE.Material,
  ): MaterialValue {
    return Array.isArray(original) ? original.map(mapper) : mapper(original);
  }

  private makeBasicMaterial(source: THREE.Material, map: THREE.Texture | null): THREE.MeshBasicMaterial {
    const sourceRecord = materialRecord(source);
    const material = new THREE.MeshBasicMaterial();
    const sourceColor = sourceRecord.color;
    if (sourceColor instanceof THREE.Color) material.color.copy(sourceColor);
    material.map = map;
    material.alphaMap = getTexture(source, "alphaMap");
    material.opacity = Number(sourceRecord.opacity ?? 1);
    material.transparent = Boolean(sourceRecord.transparent);
    material.alphaTest = Number(sourceRecord.alphaTest ?? 0);
    material.side = source.side;
    material.depthTest = source.depthTest;
    material.depthWrite = source.depthWrite;
    material.vertexColors = Boolean(sourceRecord.vertexColors);
    material.toneMapped = false;
    material.needsUpdate = true;
    return material;
  }

  private getCheckerTexture(): THREE.DataTexture {
    if (this.checkerTexture) return this.checkerTexture;
    const data = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
    for (let y = 0; y < CHECKER_SIZE; y += 1) {
      for (let x = 0; x < CHECKER_SIZE; x += 1) {
        const cell = (Math.floor(x / 16) + Math.floor(y / 16)) % 2;
        const value = cell ? 218 : 54;
        const offset = (y * CHECKER_SIZE + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(data, CHECKER_SIZE, CHECKER_SIZE, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    this.checkerTexture = texture;
    return texture;
  }

  private buildTopologyLines(): void {
    this.removeTopologyLinesFromScene();
    this.topologyLines = this.meshes.map((mesh) => ({
      mesh,
      coarse: this.makeTopologyLine(mesh, false),
      full: null,
    }));
    this.updateTopologyTransforms();
  }

  /**
   * Dense triangle meshes are sampled for the default/adaptive view. This is
   * a display-level reduction only: the original indexed geometry is untouched.
   * Adaptive mode swaps to every edge when the camera is close enough to inspect
   * topology, while full mode forces the complete wireframe at any distance.
   */
  private makeTopologyLine(mesh: THREE.Mesh, full: boolean): THREE.LineSegments | null {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (!position) return null;
    const index = geometry.getIndex();
    const triangles = triangleCount(geometry);
    if (!triangles) return null;
    const triangleBudget = full ? triangles : 24000;
    const stride = full ? 1 : Math.max(1, Math.ceil(triangles / triangleBudget));
    const values: number[] = [];

    const addEdge = (a: number, b: number): void => {
      values.push(
        position.getX(a),
        position.getY(a),
        position.getZ(a),
        position.getX(b),
        position.getY(b),
        position.getZ(b),
      );
    };

    for (let triangle = 0; triangle < triangles; triangle += stride) {
      const offset = triangle * 3;
      const a = index ? index.getX(offset) : offset;
      const b = index ? index.getX(offset + 1) : offset + 1;
      const c = index ? index.getX(offset + 2) : offset + 2;
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    const line = new THREE.LineSegments(
      lineGeometry,
      full ? this.fullTopologyMaterial : this.coarseTopologyMaterial,
    );
    line.name = TOPOLOGY_LINE_NAME;
    line.frustumCulled = true;
    line.matrixAutoUpdate = false;
    this.scene.add(line);
    return line;
  }

  private updateTopologyTransforms(): void {
    for (const topology of this.topologyLines) {
      topology.mesh.updateWorldMatrix(true, false);
      if (topology.coarse) topology.coarse.matrix.copy(topology.mesh.matrixWorld);
      if (topology.full) topology.full.matrix.copy(topology.mesh.matrixWorld);
    }
  }

  private updateTopologyVisibility(): void {
    const topologyVisible = this.displayMode === "wireframe" || this.displayMode === "overlay";
    const size = this.bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.01);
    const distance = this.activeCamera.position.distanceTo(this.controls.target);
    // Perspective zoom changes distance. Orthographic zoom changes the
    // projected world span instead, so distance alone would never reveal the
    // complete topology while the user zooms in with the wheel.
    const closeEnoughForFull = this.cameraType === "orthographic"
      ? this.orthoHeight / Math.max(this.orthographicCamera.zoom, 0.001) <= extent * 0.9
      : distance <= extent * 1.65;

    for (const topology of this.topologyLines) {
      const enabled = topologyVisible && !this.hiddenMeshes.has(topology.mesh);
      const useFull =
        this.topologyDetail === "full" ||
        (this.topologyDetail === "adaptive" && closeEnoughForFull);
      if (enabled && useFull && !topology.full) topology.full = this.makeTopologyLine(topology.mesh, true);
      if (topology.coarse) topology.coarse.visible = enabled && !useFull;
      if (topology.full) topology.full.visible = enabled && useFull;
    }
  }

  private updateDisplayVisibility(): void {
    const suppressModel = this.displayMode === "wireframe";
    for (const mesh of this.meshes) {
      const sourceVisible = this.initialVisibility.get(mesh) ?? true;
      mesh.visible = sourceVisible && !this.hiddenMeshes.has(mesh) && !suppressModel;
    }
  }

  private removeTopologyLinesFromScene(): void {
    for (const topology of this.topologyLines) {
      if (topology.coarse) {
        this.scene.remove(topology.coarse);
        topology.coarse.geometry.dispose();
      }
      if (topology.full) {
        this.scene.remove(topology.full);
        topology.full.geometry.dispose();
      }
    }
    this.topologyLines = [];
  }

  private restoreOriginalMaterials(): void {
    for (const mesh of this.meshes) {
      const original = this.originals.get(mesh);
      if (original) mesh.material = original;
    }
    for (const material of this.activeInspectionMaterials) material.dispose();
    this.activeInspectionMaterials.clear();
  }

  private rebuildHelpers(): void {
    this.disposeHelpers();
    if (this.bounds.isEmpty()) return;
    const size = this.bounds.getSize(new THREE.Vector3());
    const center = this.bounds.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.1);

    this.grid = new THREE.GridHelper(extent * 2.5, 20, 0x596271, 0x252b35);
    this.grid.position.set(center.x, this.bounds.min.y, center.z);
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(extent * 0.65);
    this.axes.position.set(center.x, this.bounds.min.y, center.z);
    this.axes.visible = this.axesVisible;
    this.scene.add(this.axes);
  }

  private disposeHelpers(): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.disposeObjectResources(this.grid);
      this.grid = null;
    }
    if (this.axes) {
      this.scene.remove(this.axes);
      this.disposeObjectResources(this.axes);
      this.axes = null;
    }
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.dispose();
      this.selectionHelper = null;
    }
  }

  private clearModel(): void {
    this.clearSelection();
    this.restoreOriginalMaterials();
    this.removeTopologyLinesFromScene();
    this.disposeHelpers();
    this.releaseObjectUrls();
    if (this.loadedRoot) {
      this.scene.remove(this.loadedRoot);
      this.disposeObjectResources(this.loadedRoot);
    }
    this.loadedRoot = null;
    this.meshes = [];
    this.originals.clear();
    this.initialVisibility.clear();
    this.hiddenMeshes.clear();
    this.bounds.makeEmpty();
  }

  private disposeObjectResources(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    root.traverse((object) => {
      const geometry = (object as THREE.Mesh).geometry;
      if (geometry instanceof THREE.BufferGeometry) geometries.add(geometry);
      const material = (object as THREE.Mesh).material;
      if (material) {
        for (const entry of materialList(material)) {
          materials.add(entry);
          collectTextures(entry, textures);
        }
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) {
      if (texture !== this.checkerTexture) texture.dispose();
    }
  }

  private releaseObjectUrls(): void {
    for (const url of this.ownedObjectUrls) URL.revokeObjectURL(url);
    this.ownedObjectUrls.clear();
  }

  private emitSelection(): void {
    const snapshot = this.selection ? { ...this.selection } : null;
    for (const listener of this.selectionListeners) listener(snapshot);
  }
}
