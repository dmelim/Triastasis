import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type DisplayMode = "textured" | "clay" | "wireframe" | "overlay";
export type CameraPreset = "isometric" | "front" | "back" | "left" | "right" | "top";

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
const OVERLAY_NAME = "trellis-wire-overlay";

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
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

export class Viewer {
  private readonly mount: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly loader = new GLTFLoader();
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  private readonly fillLight = new THREE.HemisphereLight(0xdde8ff, 0x29303c, 2.1);
  private readonly clayMaterial = new THREE.MeshStandardMaterial({
    color: 0xc8ccd3,
    metalness: 0.05,
    roughness: 0.72,
  });
  private readonly wireMaterial = new THREE.MeshBasicMaterial({
    color: 0x8fb0ff,
    wireframe: true,
  });
  private readonly overlayMaterial = new THREE.MeshBasicMaterial({
    color: 0x111722,
    depthTest: true,
    transparent: true,
    opacity: 0.58,
    wireframe: true,
  });
  private readonly resizeObserver: ResizeObserver;
  private loadedRoot: THREE.Object3D | null = null;
  private meshes: THREE.Mesh[] = [];
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private bounds = new THREE.Box3();
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private displayMode: DisplayMode = "textured";
  private gridVisible = true;
  private axesVisible = false;
  private shadowsEnabled = true;
  private stats: ViewerStats = { ...EMPTY_STATS };

  constructor(mount: HTMLElement) {
    this.mount = mount;
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

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.01;

    this.fillLight.position.set(0, 1, 0);
    this.scene.add(this.fillLight);
    this.keyLight.position.set(4, 6, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.keyLight);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mount);
    this.resize();
    this.animate();
  }

  async load(glb: Blob): Promise<ViewerStats> {
    const buffer = await glb.arrayBuffer();
    const result = await this.loader.parseAsync(buffer, "");
    this.clearModel();
    this.loadedRoot = result.scene;
    this.scene.add(result.scene);

    const materialSet = new Set<THREE.Material>();
    const textureSet = new Set<THREE.Texture>();
    let triangles = 0;
    let renderVertices = 0;

    result.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      this.meshes.push(object);
      this.originals.set(object, object.material);
      object.castShadow = this.shadowsEnabled;
      object.receiveShadow = this.shadowsEnabled;

      const position = object.geometry.getAttribute("position");
      const index = object.geometry.getIndex();
      renderVertices += position?.count ?? 0;
      triangles += Math.floor((index?.count ?? position?.count ?? 0) / 3);
      for (const material of materialList(object.material)) {
        materialSet.add(material);
        collectTextures(material, textureSet);
      }
    });

    this.bounds.setFromObject(result.scene);
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
      animations: result.animations.length,
      fileSize: glb.size,
      dimensions: { x: size.x, y: size.y, z: size.z },
    };

    this.rebuildHelpers();
    this.setDisplayMode(this.displayMode);
    this.setCameraPreset("isometric");
    return this.getStats();
  }

  clear(): void {
    this.clearModel();
    this.stats = { ...EMPTY_STATS };
  }

  getStats(): ViewerStats {
    return {
      ...this.stats,
      dimensions: { ...this.stats.dimensions },
    };
  }

  resetView(): void {
    this.setCameraPreset("isometric");
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.removeWireOverlays();

    for (const mesh of this.meshes) {
      const original = this.originals.get(mesh);
      if (!original) continue;
      if (mode === "textured" || mode === "overlay") mesh.material = original;
      if (mode === "clay") mesh.material = this.clayMaterial;
      if (mode === "wireframe") mesh.material = this.wireMaterial;
      if (mode === "overlay") {
        const overlay = new THREE.Mesh(mesh.geometry, this.overlayMaterial);
        overlay.name = OVERLAY_NAME;
        overlay.scale.setScalar(1.001);
        overlay.renderOrder = 2;
        mesh.add(overlay);
      }
    }
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

  setCameraPreset(preset: CameraPreset): void {
    if (!this.loadedRoot || this.bounds.isEmpty()) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.01);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(radius / Math.sin(fov * 0.5), radius * 2.2);
    const direction = new THREE.Vector3(1, 0.72, 1);

    if (preset === "front") direction.set(0, 0, 1);
    if (preset === "back") direction.set(0, 0, -1);
    if (preset === "left") direction.set(-1, 0, 0);
    if (preset === "right") direction.set(1, 0, 0);
    if (preset === "top") direction.set(0, 1, 0.001);

    direction.normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = Math.max(distance * 20, 100);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.maxDistance = distance * 8;
    this.controls.update();
  }

  async thumbnail(): Promise<Blob | null> {
    try {
      const activeMode = this.displayMode;
      this.setDisplayMode("textured");
      this.renderer.render(this.scene, this.camera);
      const blob = await new Promise<Blob | null>((resolve) => {
        this.renderer.domElement.toBlob((blob) => resolve(blob), "image/png");
      });
      this.setDisplayMode(activeMode);
      return blob;
    } catch {
      return null;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.mount.clientWidth);
    const height = Math.max(1, this.mount.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = (): void => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    window.requestAnimationFrame(this.animate);
  };

  private clearModel(): void {
    this.removeWireOverlays();
    if (this.loadedRoot) this.scene.remove(this.loadedRoot);
    this.loadedRoot = null;
    this.meshes = [];
    this.originals.clear();
    if (this.grid) this.scene.remove(this.grid);
    if (this.axes) this.scene.remove(this.axes);
    this.grid = null;
    this.axes = null;
  }

  private removeWireOverlays(): void {
    for (const mesh of this.meshes) {
      const overlays = mesh.children.filter((child) => child.name === OVERLAY_NAME);
      for (const overlay of overlays) mesh.remove(overlay);
    }
  }

  private rebuildHelpers(): void {
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
}
