import "./ui.css";
import type { BufferGeometry, Mesh, Object3D } from "three";
import { generate, health } from "./api";
import { loadConfig } from "./config";
import { createButton } from "./design-system/button";
import {
  detectPlaneCollapse,
  inspectGeneratedGlb,
  REFERENCE_GUIDANCE,
} from "./generation-quality";
import type { ComponentAnalysis, EditHistory } from "./editing";
import { renderSettings } from "./settings";
import type {
  EditableScene,
  MaterialSnapshot,
  TransformOperation,
  TransformSnapshot,
} from "./scene-edits";
import {
  all,
  clear as clearStore,
  createDerivedVersion,
  del as removeRecord,
  isEphemeral,
  listAssetVersions,
  newId,
  put,
  renameVersion,
  setVersionFavorite,
} from "./store";
import {
  automationInfo,
  automationJobFiles,
  automationJobs,
  isTauri,
  listen,
  listenForNativeFileDrops,
  previewAlpha,
  readDroppedImage,
  saveBytes,
  saveToOutputDir,
} from "./tauri";
import type { AutomationJob } from "./tauri";
import type { CameraPreset, CameraType, DisplayMode, TopologyDetail, Viewer, ViewerSelection, ViewerStats } from "./viewer";
import {
  DEFAULT_PARAMS,
  GenParamsValidationError,
  normalizeGenParams,
  type GenParams,
  type ModelMetrics,
  type VersionRecord,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- element refs ----
const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("file-input");
const inputPreview = $<HTMLImageElement>("input-preview");
const maskPreview = $<HTMLImageElement>("mask-preview");
const sourceTab = $<HTMLButtonElement>("preview-source-tab");
const maskTab = $<HTMLButtonElement>("preview-mask-tab");
const previewMaskBtn = $<HTMLButtonElement>("preview-mask-btn");
const maskHelp = $("mask-help");
const dropHint = $("dropzone-hint");
const generateBtn = $<HTMLButtonElement>("generate-btn");
const sweepBtn = $<HTMLButtonElement>("sweep-btn");
const progress = $("progress");
const progressTitle = $("progress-title");
const progressQueue = $("progress-queue");
const progressStage = $("progress-stage");
const progressElapsed = $("progress-elapsed");
const progressBar = $("progress-bar");
const progressBarFill = $("progress-bar-fill");
const progressCard = progress.querySelector<HTMLElement>(".progress-card")!;
const progressCollapseBtn = $<HTMLButtonElement>("progress-collapse-btn");
const cancelBtn = $<HTMLButtonElement>("cancel-btn");
const clearQueueBtn = $<HTMLButtonElement>("clear-queue-btn");
const resetViewBtn = $<HTMLButtonElement>("reset-view");
const saveGlbBtn = $<HTMLButtonElement>("save-glb");
const viewerCaption = $("viewer-caption");
const viewerEmpty = $("viewer-empty");
const generateModeBtn = $<HTMLButtonElement>("mode-generate");
const viewModeBtn = $<HTMLButtonElement>("mode-view");
const generateModePanel = $("generate-mode-panel");
const viewModePanel = $("view-mode-panel");
const inspectEmpty = $("inspect-empty");
const inspectContent = $("inspect-content");
const gallerySummary = $("gallery-summary");
const galleryEl = $("gallery");
const clearGalleryBtn = $<HTMLButtonElement>("clear-gallery");
const backendBadge = $("backend-badge");
const automationBadge = $("automation-badge");
const serverDot = $("server-dot");
const serverLabel = $("server-label");
const setupBanner = $("setup-banner");
const candidateWrap = $("candidate-wrap");
const candidateGallery = $("candidate-gallery");
const candidateSummary = $("candidate-summary");
const clearCandidatesBtn = $<HTMLButtonElement>("clear-candidates");
const viewerMount = $("viewer-mount");
const viewerReferenceToggle = $<HTMLButtonElement>("viewer-reference-toggle");
const viewerReferencePopover = $("viewer-reference-popover");
const viewerReferenceImage = $<HTMLImageElement>("viewer-reference-image");
const topologyDetailSelect = $<HTMLSelectElement>("view-topology-detail");
const cameraTypeSelect = $<HTMLSelectElement>("view-camera-type");
const meshPartSelect = $<HTMLSelectElement>("mesh-part-select");
const selectionFrameBtn = $<HTMLButtonElement>("selection-frame");
const selectionIsolateBtn = $<HTMLButtonElement>("selection-isolate");
const selectionHideBtn = $<HTMLButtonElement>("selection-hide");
const selectionShowAllBtn = $<HTMLButtonElement>("selection-show-all");
const selectionStatus = $("selection-status");
const editStatus = $("edit-status");
const editStartBtn = $<HTMLButtonElement>("edit-start");
const editControls = $("edit-controls");
const editComponentSelect = $<HTMLSelectElement>("edit-component-select");
const editComponentStatus = $("edit-component-status");
const editDeleteComponentBtn = $<HTMLButtonElement>("edit-delete-component");
const editApplyTransformBtn = $<HTMLButtonElement>("edit-apply-transform");
const editApplyMaterialBtn = $<HTMLButtonElement>("edit-apply-material");
const editRecomputeNormalsBtn = $<HTMLButtonElement>("edit-recompute-normals");
const editReverseWindingBtn = $<HTMLButtonElement>("edit-reverse-winding");
const editUndoBtn = $<HTMLButtonElement>("edit-undo");
const editRedoBtn = $<HTMLButtonElement>("edit-redo");
const editExportBtn = $<HTMLButtonElement>("edit-export-glb");
const editSaveDerivedBtn = $<HTMLButtonElement>("edit-save-derived");
const editLimitations = $("edit-limitations");

const targetFacesMode = $<HTMLSelectElement>("ctl-target-faces-mode");
const targetFacesInput = $<HTMLInputElement>("ctl-target-faces");
const targetFacesWrap = $("ctl-target-faces-wrap");
const atlasSizeMode = $<HTMLSelectElement>("ctl-atlas-size-mode");
const atlasSizeInput = $<HTMLInputElement>("ctl-atlas-size");
const atlasSizeWrap = $("ctl-atlas-size-wrap");
const remeshBandMode = $<HTMLSelectElement>("ctl-remesh-band-mode");
const remeshBandInput = $<HTMLInputElement>("ctl-remesh-band");
const remeshBandWrap = $("ctl-remesh-band-wrap");
const resolutionSelect = $<HTMLSelectElement>("ctl-res");
const textureSelect = $<HTMLSelectElement>("ctl-texture");
const textureResolutionSelect = $<HTMLSelectElement>("ctl-texture-resolution");
const targetFacesHelp = $("ctl-target-faces-help");
const textureResolutionHelp = $("texture-resolution-help");

// ---- state ----
let viewer: Viewer | null = null;
let viewerPromise: Promise<Viewer> | null = null;

async function getViewer(): Promise<Viewer> {
  if (viewer) return viewer;
  if (!viewerPromise) {
    viewerPromise = import("./viewer")
      .then(({ Viewer: ViewerClass }) => {
        viewer = new ViewerClass(viewerMount);
        applyViewerPreferences(viewer);
        viewer.onSelectionChanged((selection) => renderSelection(selection));
        return viewer!;
      })
      .catch((error: unknown) => {
        viewerPromise = null;
        throw error;
      });
  }
  return viewerPromise;
}

type EditingModule = typeof import("./editing");
type SceneEditsModule = typeof import("./scene-edits");
type ExportModule = typeof import("./export-glb");
let editingModule: EditingModule | null = null;
let sceneEditsModule: SceneEditsModule | null = null;
let editingModulesPromise: Promise<[EditingModule, SceneEditsModule, ExportModule]> | null = null;

async function getEditingModules(): Promise<[EditingModule, SceneEditsModule, ExportModule]> {
  if (!editingModulesPromise) {
    editingModulesPromise = Promise.all([
      import("./editing"),
      import("./scene-edits"),
      import("./export-glb"),
    ]).then((modules) => {
      editingModule = modules[0];
      sceneEditsModule = modules[1];
      return modules;
    }).catch((error: unknown) => {
      editingModulesPromise = null;
      throw error;
    });
  }
  return editingModulesPromise;
}
let inputImage: Blob | null = null;
let inputName = "input.png";
let currentGlb: Blob | null = null;
let activeId: string | null = null;
let serverOnline = false;
let generating = false;
let abort: AbortController | null = null;
let elapsedTimer: number | null = null;
let galleryUrls: string[] = [];
let candidateUrls: string[] = [];
let warnedEphemeral = false;
let maskObjectUrl: string | null = null;
let inputObjectUrl: string | null = null;
let activeLabel = "";

function updateViewerCaption(): void {
  if (!activeLabel) {
    viewerCaption.textContent = "";
    return;
  }
  const parts = [activeLabel];
  if (activeParams) {
    parts.push(String(activeParams.resolution));
    parts.push(`seed ${activeParams.seed}`);
  }
  if (currentGlb) parts.push(`${(currentGlb.size / 1e6).toFixed(1)} MB`);
  viewerCaption.textContent = parts.join(" | ");
}

type WorkspaceMode = "generate" | "view";

type CandidateStatus = "queued" | "generating" | "ready" | "failed" | "cancelled";
interface CandidateSlot {
  seed: number;
  status: CandidateStatus;
  record?: VersionRecord;
  error?: string;
}
let candidates: CandidateSlot[] = [];

interface SweepMembership {
  id: string;
  index: number;
  count: number;
}

interface GenerationJob {
  image: Blob;
  name: string;
  params: GenParams;
  label: string;
  autoOpen: boolean;
  sweep?: SweepMembership;
  candidate?: CandidateSlot;
}

let generationQueue: GenerationJob[] = [];
let currentJob: GenerationJob | null = null;
let progressStageLabel = "Preparing job";
let progressStageStart = 2;
let progressStageEnd = 8;
let progressHasServerStart = false;

// ---- workspace modes and viewer inspector ----
let workspaceMode: WorkspaceMode = "generate";

function syncViewerReference(): void {
  const available = workspaceMode === "view" && Boolean(currentGlb && inputObjectUrl);
  viewerReferenceToggle.classList.toggle("hidden", !available);
  if (available && inputObjectUrl) viewerReferenceImage.src = inputObjectUrl;
  if (!available) {
    viewerReferencePopover.classList.add("hidden");
    viewerReferenceToggle.setAttribute("aria-expanded", "false");
  }
}

function setWorkspaceMode(mode: WorkspaceMode): void {
  workspaceMode = mode;
  const generatingMode = mode === "generate";
  generateModeBtn.classList.toggle("active", generatingMode);
  viewModeBtn.classList.toggle("active", !generatingMode);
  generateModeBtn.setAttribute("aria-selected", String(generatingMode));
  viewModeBtn.setAttribute("aria-selected", String(!generatingMode));
  generateModePanel.classList.toggle("hidden", !generatingMode);
  viewModePanel.classList.toggle("hidden", generatingMode);
  syncViewerReference();
}

function compactNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function compactDimension(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

let activeParams: GenParams | null = null;
let activeStats: ViewerStats | null = null;
let pointerDownAt: { x: number; y: number } | null = null;

interface EditorState {
  geometryByUuid: Map<string, BufferGeometry>;
  transforms: Map<string, TransformSnapshot>;
  materials: MaterialSnapshot[];
  operations: Array<Record<string, unknown>>;
}

interface EditorSession {
  scene: EditableScene;
  history: EditHistory<EditorState>;
}

let editorSession: EditorSession | null = null;
let componentAnalysis: ComponentAnalysis | null = null;
let selectedComponentId: string | null = null;

function requestedFacesLabel(params: GenParams | null): string {
  if (!params || params.targetFaces === undefined || params.targetFaces === "auto") return "Auto";
  return compactNumber(params.targetFaces);
}

function statsToMetrics(stats: ViewerStats): ModelMetrics {
  return {
    triangles: stats.triangles,
    renderVertices: stats.renderVertices,
    meshParts: stats.meshParts,
    materials: stats.materials,
    textures: stats.textures,
    maxTextureSize: stats.maxTextureSize,
    animations: stats.animations,
    fileSize: stats.fileSize,
    dimensions: { ...stats.dimensions },
  };
}

function signedDelta(value: number): string {
  return `${value >= 0 ? "+" : "-"}${compactNumber(Math.abs(value))}`;
}

function parentComparisonText(version: VersionRecord, parent: VersionRecord | undefined): string {
  if (!parent || !version.metrics || !parent.metrics) return "";
  const deltas: string[] = [];
  if (version.metrics.triangles !== undefined && parent.metrics.triangles !== undefined) {
    deltas.push(`triangles ${signedDelta(version.metrics.triangles - parent.metrics.triangles)}`);
  }
  if (version.metrics.fileSize !== undefined && parent.metrics.fileSize !== undefined) {
    const deltaMb = (version.metrics.fileSize - parent.metrics.fileSize) / 1e6;
    deltas.push(`file ${deltaMb >= 0 ? "+" : "-"}${Math.abs(deltaMb).toFixed(1)} MB`);
  }
  return deltas.length ? `vs parent: ${deltas.join(", ")}` : "";
}

function renderViewerStats(stats: ViewerStats | null, params: GenParams | null = activeParams): void {
  activeStats = stats;
  const ready = Boolean(stats);
  inspectEmpty.classList.toggle("hidden", ready);
  inspectContent.classList.toggle("hidden", !ready);
  viewerEmpty.classList.toggle("hidden", ready);
  if (!stats) {
    $("stat-requested-faces").textContent = "Auto";
    $("stat-actual-faces").textContent = "0";
    return;
  }

  $("stat-topology").textContent = "Triangles";
  $("stat-triangles").textContent = compactNumber(stats.triangles);
  $("stat-vertices").textContent = compactNumber(stats.renderVertices);
  $("stat-parts").textContent = compactNumber(stats.meshParts);
  $("stat-materials").textContent = compactNumber(stats.materials);
  $("stat-textures").textContent = compactNumber(stats.textures);
  $("stat-texture-size").textContent = stats.maxTextureSize ? `${stats.maxTextureSize}px max` : "None";
  $("stat-dimensions").textContent = [stats.dimensions.x, stats.dimensions.y, stats.dimensions.z]
    .map(compactDimension)
    .join(" x ");
  $("stat-file-size").textContent = `${(stats.fileSize / 1e6).toFixed(1)} MB`;
  $("stat-animations").textContent = compactNumber(stats.animations);
  $("stat-requested-faces").textContent = requestedFacesLabel(params);
  $("stat-actual-faces").textContent = compactNumber(stats.triangles);
}

function updateCustomParamVisibility(): void {
  const textureEnabled = textureSelect.value === "on";
  if (!textureEnabled) targetFacesMode.value = "auto";
  targetFacesMode.disabled = !textureEnabled;
  targetFacesInput.disabled = !textureEnabled || targetFacesMode.value !== "custom";
  targetFacesWrap.classList.toggle("hidden", !textureEnabled || targetFacesMode.value !== "custom");
  targetFacesHelp.textContent = textureEnabled
    ? "Custom target faces is applied by the current textured QEM path."
    : "Geometry-only output currently uses the backend's automatic face target; custom target faces is unavailable.";

  const supportsExplicit1024 = resolutionSelect.value === "1024";
  const texture1024Option = textureResolutionSelect.querySelector<HTMLOptionElement>('option[value="1024"]');
  if (texture1024Option) texture1024Option.disabled = !supportsExplicit1024;
  if (!supportsExplicit1024 && textureResolutionSelect.value === "1024") {
    textureResolutionSelect.value = "auto";
  }
  textureResolutionHelp.textContent = supportsExplicit1024
    ? "1024 px decode is available with 1024 geometry; 512 px works at every geometry resolution."
    : "This geometry resolution supports Auto or 512 px texture decode; 1024 px is limited to 1024 geometry.";
  atlasSizeWrap.classList.toggle("hidden", atlasSizeMode.value !== "custom");
  remeshBandWrap.classList.toggle("hidden", remeshBandMode.value !== "custom");
}

function applyViewerPreferences(instance: Viewer): void {
  instance.setGridVisible($<HTMLInputElement>("view-grid").checked);
  instance.setAxesVisible($<HTMLInputElement>("view-axes").checked);
  instance.setAutoRotate($<HTMLInputElement>("view-rotate").checked);
  instance.setShadows($<HTMLInputElement>("view-shadows").checked);
  instance.setExposure(Number($<HTMLInputElement>("view-exposure").value));
  instance.setBackground($<HTMLSelectElement>("view-background").value);
  instance.setTopologyDetail(topologyDetailSelect.value as TopologyDetail);
  instance.setCameraType(cameraTypeSelect.value as CameraType);
}

function runViewer(action: (instance: Viewer) => void): void {
  void getViewer().then(action).catch((error: unknown) => {
    toast((error as Error).message || "The 3D viewer could not start", "err");
  });
}

function renderMeshParts(instance: Viewer): void {
  const parts = instance.getMeshParts();
  meshPartSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = parts.length ? "Select a mesh part" : "No mesh parts loaded";
  placeholder.disabled = parts.length > 0;
  meshPartSelect.appendChild(placeholder);
  if (!parts.length) {
    renderSelection(null);
    return;
  }
  parts.forEach((part, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = part.name || `Mesh part ${index + 1}`;
    meshPartSelect.appendChild(option);
  });
  const selected = instance.getSelection();
  meshPartSelect.value = selected ? String(selected.meshIndex) : "";
  selectionShowAllBtn.disabled = false;
  renderEditorActions();
}

async function withEditorOriginalMaterials<T>(
  root: Object3D,
  operation: (root: Object3D) => Promise<T> | T,
): Promise<T> {
  if (viewer?.getLoadedRoot() === root) return viewer.withOriginalMaterials(operation);
  return operation(root);
}

async function captureEditorState(root: Object3D, operations: Array<Record<string, unknown>> = []): Promise<EditorState> {
  if (!sceneEditsModule) throw new Error("Editing helpers are not loaded");
  const geometryByUuid = new Map<string, BufferGeometry>();
  const transforms = new Map<string, TransformSnapshot>();
  root.traverse((object) => {
    transforms.set(object.uuid, sceneEditsModule!.captureTransformSnapshot(object));
    const candidate = object as Mesh & { geometry?: BufferGeometry };
    if (candidate.geometry && typeof candidate.geometry.clone === "function") {
      geometryByUuid.set(object.uuid, candidate.geometry.clone());
    }
  });
  const materials = await withEditorOriginalMaterials(
    root,
    (originalRoot) => sceneEditsModule!.captureMaterialSnapshots(originalRoot),
  );
  return {
    geometryByUuid,
    transforms,
    materials,
    operations: operations.map((operation) => ({ ...operation })),
  };
}

function disposeEditorState(state: EditorState): void {
  const geometries = new Set(state.geometryByUuid.values());
  for (const geometry of geometries) geometry.dispose();
}

async function applyEditorState(root: Object3D, state: EditorState): Promise<void> {
  if (!sceneEditsModule) throw new Error("Editing helpers are not loaded");
  await withEditorOriginalMaterials(root, (originalRoot) => {
    const objects = new Map<string, Object3D>();
    originalRoot.traverse((object) => objects.set(object.uuid, object));
    for (const [uuid, geometry] of state.geometryByUuid) {
      const object = objects.get(uuid) as (Mesh & { geometry?: BufferGeometry }) | undefined;
      if (object?.geometry) object.geometry = geometry;
    }
    for (const snapshot of state.transforms.values()) {
      const object = objects.get(snapshot.objectUuid);
      if (object) sceneEditsModule!.restoreTransformSnapshot(object, snapshot);
    }
    sceneEditsModule!.restoreMaterialSnapshots(originalRoot, state.materials);
  });
}

function currentEditableMesh(): Mesh | null {
  if (!viewer) return null;
  const selected = viewer.getSelection()?.mesh;
  if (selected) return selected;
  const index = Number(meshPartSelect.value);
  return Number.isInteger(index) && index >= 0 ? viewer.getMeshParts()[index] ?? null : null;
}

function setEditNotice(message: string): void {
  editLimitations.textContent = message;
}

function renderTransformFields(mesh: Mesh | null): void {
  const fields = [
    "edit-position-x", "edit-position-y", "edit-position-z",
    "edit-rotation-x", "edit-rotation-y", "edit-rotation-z",
    "edit-scale-x", "edit-scale-y", "edit-scale-z",
  ].map((id) => $<HTMLInputElement>(id));
  if (!mesh) {
    fields.forEach((field) => { field.value = ""; });
    return;
  }
  const snapshot = sceneEditsModule
    ? sceneEditsModule.captureTransformSnapshot(mesh)
    : {
        position: [mesh.position.x, mesh.position.y, mesh.position.z] as [number, number, number],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z] as [number, number, number],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z] as [number, number, number],
      };
  const values = [
    ...snapshot.position,
    ...snapshot.rotation.map((value) => value * 180 / Math.PI),
    ...snapshot.scale,
  ];
  fields.forEach((field, index) => { field.value = values[index].toFixed(3); });
}

function colorHex(value: readonly number[] | undefined): string {
  if (!value || value.length !== 3) return "#ffffff";
  return `#${value.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

let materialFieldsRenderToken = 0;

async function renderMaterialFields(mesh: Mesh | null): Promise<void> {
  const renderToken = ++materialFieldsRenderToken;
  const color = $<HTMLInputElement>("edit-base-color");
  const metalness = $<HTMLInputElement>("edit-metalness");
  const roughness = $<HTMLInputElement>("edit-roughness");
  if (!mesh) {
    color.value = "#ffffff";
    metalness.value = "0";
    roughness.value = "0.5";
  } else {
    const root = viewer?.getLoadedRoot() ?? mesh;
    const snapshots = sceneEditsModule
      ? await withEditorOriginalMaterials(
        root,
        () => sceneEditsModule!.captureMaterialSnapshots(mesh).filter((snapshot) => snapshot.objectUuid === mesh.uuid),
      )
      : [];
    if (renderToken !== materialFieldsRenderToken || currentEditableMesh() !== mesh) return;
    const snapshot = snapshots[0];
    color.value = colorHex(snapshot?.baseColor);
    metalness.value = String(snapshot?.metalness ?? 0);
    roughness.value = String(snapshot?.roughness ?? 0.5);
  }
  $("edit-metalness-value").textContent = Number(metalness.value).toFixed(2);
  $("edit-roughness-value").textContent = Number(roughness.value).toFixed(2);
}

function renderComponentOptions(): void {
  const previous = selectedComponentId;
  editComponentSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = Boolean(componentAnalysis?.components.length);
  placeholder.textContent = componentAnalysis
    ? componentAnalysis.components.length ? "Select a component" : "No connected components"
    : editorSession ? "Select a mesh part first" : "Create an edit copy to inspect components";
  editComponentSelect.appendChild(placeholder);
  for (const [index, component] of (componentAnalysis?.components ?? []).entries()) {
    const option = document.createElement("option");
    option.value = component.id;
    option.textContent = `Component ${index + 1} | ${component.triangleCount.toLocaleString()} triangles | ${component.vertexCount.toLocaleString()} vertices`;
    editComponentSelect.appendChild(option);
  }
  selectedComponentId = previous && componentAnalysis?.components.some((component) => component.id === previous)
    ? previous
    : null;
  editComponentSelect.value = selectedComponentId ?? "";
  const selected = componentAnalysis?.components.find((component) => component.id === selectedComponentId);
  if (selected) {
    editComponentStatus.textContent = `${selected.triangleCount.toLocaleString()} triangles, ${selected.vertexCount.toLocaleString()} vertices.`;
  } else if (componentAnalysis) {
    const details = componentAnalysis.limitations.join(" ");
    editComponentStatus.textContent = `${componentAnalysis.components.length.toLocaleString()} connected components.${details ? ` ${details}` : ""}`;
  } else {
    editComponentStatus.textContent = editorSession ? "Select a mesh part first." : "Create an edit copy to inspect components.";
  }
}

function refreshComponentList(): void {
  componentAnalysis = null;
  selectedComponentId = null;
  if (!editorSession) {
    renderComponentOptions();
    return;
  }
  const mesh = currentEditableMesh();
  if (!mesh) {
    renderComponentOptions();
    return;
  }
  if (!editingModule) {
    renderComponentOptions();
    return;
  }
  componentAnalysis = editingModule.analyzeConnectedComponents(mesh.geometry);
  renderComponentOptions();
}

function renderEditorActions(): void {
  const session = editorSession;
  const mesh = currentEditableMesh();
  const hasMesh = Boolean(mesh);
  const hasComponent = Boolean(selectedComponentId && componentAnalysis?.components.some((component) => component.id === selectedComponentId));
  const hasAnimationClips = Boolean(activeStats?.animations);
  editControls.classList.toggle("hidden", !session);
  editStartBtn.disabled = !activeStats || hasAnimationClips || Boolean(session);
  editStartBtn.textContent = session ? "Editing copy active" : "Create edit copy";
  editStatus.textContent = session
    ? session.history.dirty ? `Editing copy, ${session.history.undoDepth} pending change${session.history.undoDepth === 1 ? "" : "s"}` : "Editing copy, no unsaved changes"
    : hasAnimationClips ? "Animation clips present, static editing unavailable" : "Read-only model";
  editDeleteComponentBtn.disabled = !session || !hasComponent || !componentAnalysis?.indexed;
  editApplyTransformBtn.disabled = !session || !hasMesh;
  editApplyMaterialBtn.disabled = !session || !hasMesh;
  editRecomputeNormalsBtn.disabled = !session || !hasMesh;
  editReverseWindingBtn.disabled = !session || !hasMesh;
  editUndoBtn.disabled = !session || !session.history.canUndo;
  editRedoBtn.disabled = !session || !session.history.canRedo;
  editExportBtn.disabled = !session || hasAnimationClips;
  editSaveDerivedBtn.disabled = !session || hasAnimationClips || !session.history.dirty || !activeId;
  renderTransformFields(mesh);
  void renderMaterialFields(mesh).catch(() => undefined);
}

function renderSelection(selection: ViewerSelection | null): void {
  meshPartSelect.value = selection ? String(selection.meshIndex) : "";
  selectionFrameBtn.disabled = !selection;
  selectionIsolateBtn.disabled = !selection;
  selectionHideBtn.disabled = !selection;
  selectionShowAllBtn.disabled = !viewer || !activeStats;
  selectionStatus.textContent = selection
    ? `${selection.name} selected. ${compactNumber(selection.triangles)} triangles.`
    : "Click the model or choose a mesh part.";
  if (editorSession) refreshComponentList();
  renderEditorActions();
}

function disposeEditorSession(): void {
  if (!editorSession) return;
  editorSession.history.dispose(true);
  editorSession.scene.dispose();
  editorSession = null;
  componentAnalysis = null;
  selectedComponentId = null;
  renderComponentOptions();
  renderEditorActions();
}

function editHistoryLimit(stats: ViewerStats): number {
  // Each snapshot owns a full geometry clone. Keep ordinary models pleasant
  // to undo while putting a hard cap on retained GPU memory for dense assets.
  const complexity = Math.max(stats.triangles, stats.renderVertices * 0.6);
  if (complexity >= 2_000_000) return 3;
  if (complexity >= 1_000_000) return 5;
  if (complexity >= 500_000) return 8;
  return 12;
}

async function startEditing(): Promise<EditorSession | null> {
  if (editorSession) return editorSession;
  const instance = await getViewer();
  if ((activeStats?.animations ?? 0) > 0) {
    toast("Static editing is unavailable while animation clips are present", "err");
    return null;
  }
  const sourceRoot = instance.getLoadedRoot();
  if (!sourceRoot) {
    toast("Load a model before creating an edit copy", "err");
    return null;
  }
  const selectedIndex = instance.getSelection()?.meshIndex ?? Number(meshPartSelect.value);
  let scene: EditableScene | null = null;
  try {
    const [editing, sceneEdits] = await getEditingModules();
    scene = await instance.withOriginalMaterials((root) => sceneEdits.cloneEditableScene(root));
    const stats = instance.loadRoot(scene.root, currentGlb?.size ?? activeStats?.fileSize ?? 0, activeStats?.animations ?? 0);
    const initial = await captureEditorState(scene.root);
    const maxHistoryEntries = editHistoryLimit(stats);
    editorSession = {
      scene,
      history: new editing.EditHistory(initial, {
        maxEntries: maxHistoryEntries,
        disposeSnapshot: disposeEditorState,
      }),
    };
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0) {
      instance.selectMesh(instance.getMeshParts()[selectedIndex] ?? null);
    }
    renderViewerStats(stats, activeParams);
    renderMeshParts(instance);
    renderSelection(instance.getSelection());
    setEditNotice(
      `Edits are held in memory until you export or save a derived version. Undo keeps up to ${maxHistoryEntries} snapshots for this model.`,
    );
    toast("Editable copy ready", "ok");
    return editorSession;
  } catch (error) {
    if (scene) {
      const adoptedRoot = scene.root;
      scene.dispose();
      if (instance.getLoadedRoot() === adoptedRoot) instance.clear();
    }
    toast((error as Error).message || "This model cannot be edited", "err");
    return null;
  }
}

async function ensureEditing(): Promise<EditorSession | null> {
  return editorSession ?? startEditing();
}

function refreshEditorView(): void {
  if (!viewer) return;
  const stats = viewer.refresh(currentGlb?.size ?? activeStats?.fileSize ?? 0, activeStats?.animations ?? 0);
  renderViewerStats(stats, activeParams);
  renderMeshParts(viewer);
  renderSelection(viewer.getSelection());
  renderEditorActions();
}

async function commitEditorMutation(
  label: string,
  operation: Record<string, unknown>,
  transientGeometries: BufferGeometry[] = [],
): Promise<void> {
  const session = editorSession;
  if (!session) return;
  const root = session.scene.root;
  const next = await captureEditorState(root, [...session.history.current.operations, operation]);
  if (editorSession !== session) {
    disposeEditorState(next);
    return;
  }
  session.history.execute({ label, apply: () => next });
  await applyEditorState(root, next);
  for (const geometry of transientGeometries) geometry.dispose();
  refreshEditorView();
}

function numberField(id: string, label: string): number[] {
  const fields = id.split(",").map((fieldId) => $<HTMLInputElement>(fieldId));
  const values = fields.map((field) => Number(field.value));
  if (values.some((value) => !Number.isFinite(value))) throw new Error(`${label} values must be finite numbers`);
  return values;
}

async function applyTransformEdit(): Promise<void> {
  const session = await ensureEditing();
  const mesh = currentEditableMesh();
  if (!session || !mesh) return;
  try {
    const position = numberField("edit-position-x,edit-position-y,edit-position-z", "Position") as [number, number, number];
    const rotationDegrees = numberField("edit-rotation-x,edit-rotation-y,edit-rotation-z", "Rotation");
    const rotation: [number, number, number] = rotationDegrees.map((value) => value * Math.PI / 180) as [number, number, number];
    const scale = numberField("edit-scale-x,edit-scale-y,edit-scale-z", "Scale") as [number, number, number];
    const operations: TransformOperation[] = [
      { kind: "position", value: position },
      { kind: "rotation", value: rotation },
      { kind: "scale", value: scale },
    ];
    if (!sceneEditsModule) throw new Error("Editing helpers are not loaded");
    const results = operations.map((operation) => sceneEditsModule!.applyTransformOperation(mesh, operation));
    if (!results.some((result) => result.changed)) {
      setEditNotice("The transform values are unchanged.");
      return;
    }
    await commitEditorMutation("Apply transform", {
      kind: "transform",
      mesh: mesh.name || mesh.uuid,
      position,
      rotation,
      scale,
    });
    setEditNotice(results.flatMap((result) => result.limitations).join(" "));
  } catch (error) {
    toast((error as Error).message || "Transform could not be applied", "err");
  }
}

async function applyMaterialEditToSelection(): Promise<void> {
  const session = await ensureEditing();
  const mesh = currentEditableMesh();
  if (!session || !mesh) return;
  const metalness = Number($<HTMLInputElement>("edit-metalness").value);
  const roughness = Number($<HTMLInputElement>("edit-roughness").value);
  try {
    if (!sceneEditsModule) throw new Error("Editing helpers are not loaded");
    const root = viewer?.getLoadedRoot() ?? mesh;
    const result = await withEditorOriginalMaterials(root, () => sceneEditsModule!.applyMaterialEdit(mesh, {
      baseColor: $<HTMLInputElement>("edit-base-color").value,
      metalness,
      roughness,
    }));
    if (!result.changed) {
      setEditNotice(result.limitations.join(" ") || "The material values are unchanged.");
      return;
    }
    await commitEditorMutation("Apply material", {
      kind: "material",
      mesh: mesh.name || mesh.uuid,
      baseColor: $<HTMLInputElement>("edit-base-color").value,
      metalness,
      roughness,
    });
    setEditNotice(result.limitations.join(" "));
  } catch (error) {
    toast((error as Error).message || "Material could not be applied", "err");
  }
}

async function deleteSelectedComponent(): Promise<void> {
  const session = await ensureEditing();
  const mesh = currentEditableMesh();
  const componentId = selectedComponentId;
  if (!session || !mesh || !componentId || !componentAnalysis) return;
  if (!editingModule) return;
  const result = editingModule.removeConnectedComponents(mesh.geometry, [componentId], {
    analysis: componentAnalysis,
    recomputeNormals: false,
  });
  if (!result.changed) {
    result.geometry.dispose();
    setEditNotice(result.limitations.join(" "));
    return;
  }
  if (!viewer?.replaceMeshGeometry(mesh, result.geometry)) {
    result.geometry.dispose();
    toast("The selected mesh part is no longer loaded", "err");
    return;
  }
  selectedComponentId = null;
  await commitEditorMutation("Delete connected component", {
    kind: "delete-component",
    mesh: mesh.name || mesh.uuid,
    componentId,
  }, [result.geometry]);
  setEditNotice(result.limitations.join(" "));
}

async function repairSelectedNormals(): Promise<void> {
  const session = await ensureEditing();
  const mesh = currentEditableMesh();
  if (!session || !mesh) return;
  if (!editingModule) return;
  const result = editingModule.recalculateNormals(mesh.geometry);
  if (!result.changed) {
    result.geometry.dispose();
    setEditNotice(result.limitations.join(" "));
    return;
  }
  if (!viewer?.replaceMeshGeometry(mesh, result.geometry)) {
    result.geometry.dispose();
    return;
  }
  await commitEditorMutation("Recompute normals", { kind: "recompute-normals", mesh: mesh.name || mesh.uuid }, [result.geometry]);
  setEditNotice(result.limitations.join(" "));
}

async function reverseSelectedWinding(): Promise<void> {
  const session = await ensureEditing();
  const mesh = currentEditableMesh();
  if (!session || !mesh) return;
  if (!editingModule) return;
  const result = editingModule.reverseTriangleWinding(mesh.geometry, { recomputeNormals: true });
  if (!result.changed) {
    result.geometry.dispose();
    setEditNotice(result.limitations.join(" "));
    return;
  }
  if (!viewer?.replaceMeshGeometry(mesh, result.geometry)) {
    result.geometry.dispose();
    return;
  }
  await commitEditorMutation("Reverse triangle winding", { kind: "reverse-winding", mesh: mesh.name || mesh.uuid }, [result.geometry]);
  setEditNotice(result.limitations.join(" "));
}

async function applyEditorHistory(direction: "undo" | "redo"): Promise<void> {
  const session = editorSession;
  if (!session) return;
  const state = direction === "undo" ? session.history.undo() : session.history.redo();
  await applyEditorState(session.scene.root, state);
  refreshEditorView();
  setEditNotice(direction === "undo" ? "Undid the last edit." : "Redid the last edit.");
}

async function exportEditedBlob(): Promise<Blob> {
  if (!editorSession) throw new Error("Create an edit copy before exporting");
  if ((activeStats?.animations ?? 0) > 0) {
    throw new Error("Edited export is unavailable while animation clips are present");
  }
  const [, , exporter] = await getEditingModules();
  const root = editorSession.scene.root;
  if (viewer?.getLoadedRoot() === root) {
    return viewer.withOriginalMaterials((sourceRoot) => exporter.exportGlb(sourceRoot, { onlyVisible: false }));
  }
  return exporter.exportGlb(root, { onlyVisible: false });
}

async function exportEditedModel(): Promise<void> {
  try {
    const blob = await exportEditedBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base = (activeLabel || inputName).replace(/\.[^.]+$/, "") || "model";
    if (await saveBytes(`${base}_edited.glb`, bytes)) toast("Edited GLB exported", "ok");
  } catch (error) {
    toast((error as Error).message || "Edited GLB export failed", "err");
  }
}

async function saveEditedDerivedVersion(): Promise<void> {
  const session = editorSession;
  if (!session || !activeId) return;
  try {
    const blob = await exportEditedBlob();
    const thumb = viewer ? await viewer.thumbnail() : null;
    const stats = viewer?.getStats() ?? activeStats;
    const metrics = stats ? { ...statsToMetrics(stats), fileSize: blob.size } : { fileSize: blob.size };
    const parentLabel = activeLabel || inputName.replace(/\.[^.]+$/, "") || "Model";
    const derived = await createDerivedVersion(activeId, {
      glb: blob,
      thumb,
      input: inputImage ?? undefined,
      params: activeParams ?? undefined,
      metrics,
      operation: "edited",
      operationParams: {
        commands: session.history.current.operations.map((operation) => ({ ...operation })),
        undoDepth: session.history.undoDepth,
      },
      label: `${parentLabel} (edited)`,
    });
    activeId = derived.id;
    activeLabel = derived.label;
    currentGlb = blob;
    if (viewer) {
      const refreshedStats = viewer.refresh(blob.size, viewer.getStats().animations);
      renderViewerStats(refreshedStats, activeParams);
    }
    session.history.markClean();
    updateViewerCaption();
    await refreshGallery();
    renderEditorActions();
    toast("Derived version saved", "ok");
  } catch (error) {
    toast((error as Error).message || "Could not save derived version", "err");
  }
}

generateModeBtn.addEventListener("click", () => setWorkspaceMode("generate"));
viewModeBtn.addEventListener("click", () => setWorkspaceMode("view"));

document.querySelectorAll<HTMLButtonElement>("[data-display-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.displayMode as DisplayMode;
    runViewer((instance) => instance.setDisplayMode(mode));
    document.querySelectorAll("[data-display-mode]").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === button);
    });
  });
});

$<HTMLInputElement>("view-grid").addEventListener("change", (event) => {
  runViewer((instance) => instance.setGridVisible((event.currentTarget as HTMLInputElement).checked));
});
$<HTMLInputElement>("view-axes").addEventListener("change", (event) => {
  runViewer((instance) => instance.setAxesVisible((event.currentTarget as HTMLInputElement).checked));
});
$<HTMLInputElement>("view-rotate").addEventListener("change", (event) => {
  runViewer((instance) => instance.setAutoRotate((event.currentTarget as HTMLInputElement).checked));
});
$<HTMLInputElement>("view-shadows").addEventListener("change", (event) => {
  runViewer((instance) => instance.setShadows((event.currentTarget as HTMLInputElement).checked));
});
$<HTMLInputElement>("view-exposure").addEventListener("input", (event) => {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  $("view-exposure-value").textContent = value.toFixed(1);
  runViewer((instance) => instance.setExposure(value));
});
$<HTMLSelectElement>("view-background").addEventListener("change", (event) => {
  runViewer((instance) => instance.setBackground((event.currentTarget as HTMLSelectElement).value));
});
document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => {
  button.addEventListener("click", () => runViewer((instance) => instance.setCameraPreset(button.dataset.camera as CameraPreset)));
});
topologyDetailSelect.addEventListener("change", () => {
  runViewer((instance) => instance.setTopologyDetail(topologyDetailSelect.value as TopologyDetail));
});
cameraTypeSelect.addEventListener("change", () => {
  runViewer((instance) => instance.setCameraType(cameraTypeSelect.value as CameraType));
});
meshPartSelect.addEventListener("change", () => {
  const index = Number(meshPartSelect.value);
  runViewer((instance) => instance.selectMesh(instance.getMeshParts()[index] ?? null));
});
editStartBtn.addEventListener("click", () => {
  void startEditing();
});
editComponentSelect.addEventListener("change", () => {
  selectedComponentId = editComponentSelect.value || null;
  renderComponentOptions();
  renderEditorActions();
});
editApplyTransformBtn.addEventListener("click", () => { void applyTransformEdit(); });
editApplyMaterialBtn.addEventListener("click", () => { void applyMaterialEditToSelection(); });
editDeleteComponentBtn.addEventListener("click", () => { void deleteSelectedComponent(); });
editRecomputeNormalsBtn.addEventListener("click", () => { void repairSelectedNormals(); });
editReverseWindingBtn.addEventListener("click", () => { void reverseSelectedWinding(); });
editUndoBtn.addEventListener("click", () => { void applyEditorHistory("undo"); });
editRedoBtn.addEventListener("click", () => { void applyEditorHistory("redo"); });
editExportBtn.addEventListener("click", () => { void exportEditedModel(); });
editSaveDerivedBtn.addEventListener("click", () => { void saveEditedDerivedVersion(); });
$<HTMLInputElement>("edit-metalness").addEventListener("input", (event) => {
  $("edit-metalness-value").textContent = Number((event.currentTarget as HTMLInputElement).value).toFixed(2);
});
$<HTMLInputElement>("edit-roughness").addEventListener("input", (event) => {
  $("edit-roughness-value").textContent = Number((event.currentTarget as HTMLInputElement).value).toFixed(2);
});
selectionFrameBtn.addEventListener("click", () => runViewer((instance) => instance.frameSelection()));
selectionIsolateBtn.addEventListener("click", () => runViewer((instance) => instance.isolateSelection()));
selectionHideBtn.addEventListener("click", () => runViewer((instance) => instance.hideSelection()));
selectionShowAllBtn.addEventListener("click", () => runViewer((instance) => instance.showAll()));

viewerMount.addEventListener("pointerdown", (event) => {
  pointerDownAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
});
viewerMount.addEventListener("pointerup", (event) => {
  if (!pointerDownAt || !viewer || event.button !== 0) return;
  const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) > 5;
  pointerDownAt = null;
  if (!moved && (event.target as HTMLElement).classList.contains("viewer-canvas")) {
    viewer.selectAt(event.clientX, event.clientY);
  }
});

for (const control of [targetFacesMode, atlasSizeMode, remeshBandMode, textureSelect, resolutionSelect, textureResolutionSelect]) {
  control.addEventListener("change", updateCustomParamVisibility);
}
updateCustomParamVisibility();

// ---- controls -> params ----
function readParams(): GenParams {
  const res = parseInt(($("ctl-res") as HTMLSelectElement).value, 10);
  const seed = parseInt(($("ctl-seed") as HTMLInputElement).value, 10);
  return normalizeGenParams({
    resolution: (res === 512 || res === 1536 ? res : 1024) as GenParams["resolution"],
    seed: isNaN(seed) ? DEFAULT_PARAMS.seed : seed,
    bgRemoval: ($("ctl-bg") as HTMLSelectElement).value as GenParams["bgRemoval"],
    uv: ($("ctl-uv") as HTMLSelectElement).value as GenParams["uv"],
    targetFaces: targetFacesMode.value === "custom" ? Number(targetFacesInput.value) : "auto",
    texture: ($<HTMLSelectElement>("ctl-texture").value === "on"),
    atlasSize: atlasSizeMode.value === "custom" ? Number(atlasSizeInput.value) : "auto",
    textureResolution: ($<HTMLSelectElement>("ctl-texture-resolution").value === "auto"
      ? "auto"
      : Number($<HTMLSelectElement>("ctl-texture-resolution").value)) as GenParams["textureResolution"],
    remeshBand: remeshBandMode.value === "custom" ? Number(remeshBandInput.value) : "auto",
    textureEncoding: $<HTMLSelectElement>("ctl-texture-encoding").value as GenParams["textureEncoding"],
  });
}

function applyParams(p: GenParams): void {
  const normalized = normalizeGenParams(p);
  ($("ctl-res") as HTMLSelectElement).value = String(normalized.resolution);
  ($("ctl-seed") as HTMLInputElement).value = String(normalized.seed);
  ($("ctl-bg") as HTMLSelectElement).value = normalized.bgRemoval;
  ($("ctl-uv") as HTMLSelectElement).value = normalized.uv;
  targetFacesMode.value = normalized.targetFaces === "auto" ? "auto" : "custom";
  targetFacesInput.value = normalized.targetFaces === "auto" ? targetFacesInput.value : String(normalized.targetFaces);
  $<HTMLSelectElement>("ctl-texture").value = normalized.texture ? "on" : "off";
  $<HTMLSelectElement>("ctl-texture-resolution").value = String(normalized.textureResolution);
  atlasSizeMode.value = normalized.atlasSize === "auto" ? "auto" : "custom";
  atlasSizeInput.value = normalized.atlasSize === "auto" ? atlasSizeInput.value : String(normalized.atlasSize);
  remeshBandMode.value = normalized.remeshBand === "auto" ? "auto" : "custom";
  remeshBandInput.value = normalized.remeshBand === "auto" ? remeshBandInput.value : String(normalized.remeshBand);
  $<HTMLSelectElement>("ctl-texture-encoding").value = normalized.textureEncoding;
  updateCustomParamVisibility();
}

function clearParamErrors(): void {
  $("generation-param-error").textContent = "";
  document.querySelectorAll<HTMLElement>(".field-error[data-param-error]").forEach((element) => {
    element.textContent = "";
  });
}

function showParamError(error: unknown): void {
  clearParamErrors();
  const message = error instanceof Error ? error.message : "Check the generation settings.";
  const field = error instanceof GenParamsValidationError ? error.field : null;
  const target = field ? document.querySelector<HTMLElement>(`[data-param-error="${field}"]`) : null;
  if (target) target.textContent = message;
  else $("generation-param-error").textContent = message;
}

// ---- toasts ----
function toast(msg: string, kind: "" | "ok" | "err" = ""): void {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4000);
}

// ---- input image ----
function setInputPreviewBlob(blob: Blob): void {
  if (inputObjectUrl) URL.revokeObjectURL(inputObjectUrl);
  inputObjectUrl = URL.createObjectURL(blob);
  inputPreview.src = inputObjectUrl;
  syncViewerReference();
}

function clearInputPreview(): void {
  if (inputObjectUrl) URL.revokeObjectURL(inputObjectUrl);
  inputObjectUrl = null;
  inputPreview.removeAttribute("src");
  viewerReferenceImage.removeAttribute("src");
  inputPreview.classList.add("hidden");
  dropHint.classList.remove("hidden");
  syncViewerReference();
}

function clearCurrentModelState(): void {
  disposeEditorSession();
  activeId = null;
  currentGlb = null;
  activeParams = null;
  activeLabel = "";
  inputImage = null;
  inputName = "input.png";
  clearInputPreview();
  clearMaskPreview();
  renderViewerStats(null);
  setViewerTools(false);
  updateGenerateEnabled();
}

function setInput(blob: Blob, name: string): void {
  inputImage = blob;
  inputName = name || "input.png";
  setInputPreviewBlob(blob);
  inputPreview.classList.remove("hidden");
  dropHint.classList.add("hidden");
  clearMaskPreview();
  showInputPreview("source");
  updateGenerateEnabled();
}

function showInputPreview(which: "source" | "mask"): void {
  const showMask = which === "mask" && Boolean(maskObjectUrl);
  inputPreview.classList.toggle("hidden", showMask || !inputImage);
  maskPreview.classList.toggle("hidden", !showMask);
  sourceTab.classList.toggle("active", !showMask);
  maskTab.classList.toggle("active", showMask);
  sourceTab.setAttribute("aria-selected", String(!showMask));
  maskTab.setAttribute("aria-selected", String(showMask));
}

function clearMaskPreview(): void {
  if (maskObjectUrl) URL.revokeObjectURL(maskObjectUrl);
  maskObjectUrl = null;
  maskPreview.removeAttribute("src");
  maskPreview.classList.add("hidden");
  maskTab.disabled = true;
  sourceTab.classList.add("active");
  maskTab.classList.remove("active");
  sourceTab.setAttribute("aria-selected", "true");
  maskTab.setAttribute("aria-selected", "false");
  previewMaskBtn.disabled = !inputImage || !isTauri();
  previewMaskBtn.textContent = "Preview mask";
  maskHelp.textContent = isTauri()
    ? "Preview the exact background-removed image used for reconstruction."
    : "Exact mask preview is available in the desktop app.";
}

sourceTab.addEventListener("click", () => showInputPreview("source"));
maskTab.addEventListener("click", () => showInputPreview("mask"));
previewMaskBtn.addEventListener("click", async () => {
  if (!inputImage || generating || !isTauri()) return;
  let params: GenParams;
  try {
    params = readParams();
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  previewMaskBtn.disabled = true;
  previewMaskBtn.textContent = "Building mask...";
  maskHelp.textContent = "Running the same background-removal path used by TRELLIS.";
  try {
    const blob = await previewAlpha(inputImage, params.bgRemoval);
    if (maskObjectUrl) URL.revokeObjectURL(maskObjectUrl);
    maskObjectUrl = URL.createObjectURL(blob);
    maskPreview.src = maskObjectUrl;
    maskTab.disabled = false;
    showInputPreview("mask");
    maskHelp.textContent = "This square, black-backed cutout is the image conditioning seen by TRELLIS.";
  } catch (e) {
    maskHelp.textContent = "Mask preview failed. Generation is still available.";
    toast((e as Error).message || "mask preview failed", "err");
  } finally {
    previewMaskBtn.textContent = "Refresh mask";
    previewMaskBtn.disabled = !inputImage || generating;
  }
});

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  const event = e as KeyboardEvent;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) setInput(f, f.name);
});
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")) setInput(f, f.name);
});
void listenForNativeFileDrops(async (event) => {
  if (event.type === "enter" || event.type === "over") {
    dropzone.classList.add("drag");
    return;
  }
  dropzone.classList.remove("drag");
  if (event.type !== "drop" || !event.paths.length) return;
  try {
    const image = await readDroppedImage(event.paths[0]);
    setInput(image.blob, image.name);
  } catch (error) {
    toast((error as Error).message || "Could not open the dropped image", "err");
  }
}).catch((error) => {
  console.warn("Could not subscribe to native file drops", error);
});
window.addEventListener("paste", async (e: ClipboardEvent) => {
  for (const item of e.clipboardData?.items ?? []) {
    const image = item.type.startsWith("image/") && item.getAsFile();
    if (image) return setInput(image, image.name || "pasted.png");
  }
  // WebKitGTK can omit image data from ClipboardEvent. Since paste was
  // user-triggered, try reading the clipboard item list for an image.
  const items = await navigator.clipboard.read().catch(() => []);
  for (const item of items) {
    const type = item.types.find((type) => type.startsWith("image/"));
    if (type) {
      const image = await item.getType(type).catch(() => null);
      if (image) return setInput(image, "pasted.png");
    }
  }
});

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.matches("input, textarea, select, button, [contenteditable='true']")
  );
}

window.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    isEditableShortcutTarget(event.target)
  ) return;
  if (event.key.toLowerCase() === "g") {
    event.preventDefault();
    setWorkspaceMode("generate");
  } else if (event.key.toLowerCase() === "v") {
    event.preventDefault();
    setWorkspaceMode("view");
  }
});

// ---- generate ----
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateGenerateEnabled(): void {
  const enabled = Boolean(serverOnline && inputImage);
  generateBtn.disabled = !enabled;
  sweepBtn.disabled = !enabled;
  previewMaskBtn.disabled = !inputImage || generating || !isTauri();
  clearGalleryBtn.disabled = generating;
  clearCandidatesBtn.disabled = generating;
  generateBtn.textContent = generating || generationQueue.length ? "Add to queue" : "Generate 3D";
  clearQueueBtn.disabled = generationQueue.length === 0;
}

function setProgress(percent: number, label: string): void {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  progressStage.textContent = label;
  progressBarFill.style.width = `${value}%`;
  progressBar.setAttribute("aria-valuenow", String(value));
}

function setProgressStage(label: string, start: number, end: number): void {
  progressStageLabel = label;
  progressStageStart = start;
  progressStageEnd = end;
  setProgress(start, label);
}

function updateProgressFromServerLog(line: string): void {
  const text = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (/^\[trellis-server\]\s+generate:/i.test(text)) {
    progressHasServerStart = true;
    setProgressStage("Preparing the job", 2, 5);
    return;
  }
  if (!progressHasServerStart) return;
  const stageMatch = text.match(/^\[(\d+)\/(\d+)\]\s*(.*)$/);
  if (stageMatch) {
    const stage = Number(stageMatch[1]);
    const stages: Record<number, [string, number, number]> = {
      1: ["Preparing the image", 5, 14],
      2: ["Understanding the image", 14, 25],
      3: ["Building the coarse shape", 25, 40],
      4: ["Refining the 3D structure", 40, 63],
      5: ["Building the mesh", 63, 75],
      6: ["Generating materials", 75, 92],
      7: ["Packing the 3D model", 92, 98],
    };
    const mapped = stages[stage];
    if (mapped) setProgressStage(...mapped);
    return;
  }

  const flowMatch = text.match(/\[flow\]\s+\[[^\]]*\]\s*(\d+)\/(\d+)/);
  if (flowMatch) {
    const done = Number(flowMatch[1]);
    const total = Math.max(1, Number(flowMatch[2]));
    const percent = progressStageStart + (progressStageEnd - progressStageStart) * (done / total);
    const etaMatch = text.match(/~\d+s left/);
    const eta = etaMatch ? ` · ${etaMatch[0]}` : "";
    setProgress(percent, `${progressStageLabel} · Step ${done} of ${total}${eta}`);
    return;
  }

  if (/^done in\s/i.test(text)) setProgress(100, "Model ready");
}

function updateQueueStatus(): void {
  const queued = generationQueue.length;
  progressQueue.textContent = queued
    ? `1 running · ${queued} queued`
    : "1 running";
  clearQueueBtn.disabled = queued === 0;
  updateGenerateEnabled();
}

function startRun(job: GenerationJob): void {
  generating = true;
  progressHasServerStart = !isTauri();
  progressTitle.textContent = job.label;
  viewerReferencePopover.classList.add("hidden");
  viewerReferenceToggle.setAttribute("aria-expanded", "false");
  progress.classList.remove("hidden");
  setProgressStage("Preparing the job", 2, 5);
  const started = Date.now();
  progressElapsed.textContent = "0:00";
  elapsedTimer = window.setInterval(() => {
    progressElapsed.textContent = fmtElapsed(Date.now() - started);
  }, 1000);
  abort = new AbortController();
  updateQueueStatus();
}

function finishRun(): void {
  generating = false;
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (!generationQueue.length) progress.classList.add("hidden");
}

function queueJob(job: GenerationJob): void {
  const waiting = Boolean(currentJob || generationQueue.length);
  generationQueue.push(job);
  updateQueueStatus();
  if (waiting) toast(`${job.label} added to the queue`, "ok");
  void runGenerationQueue();
}

async function generateRecord(
  params: GenParams,
  sourceImage: Blob,
  sourceName: string,
  signal: AbortSignal,
  autoOpen: boolean,
  announce = true,
  sweep?: SweepMembership,
): Promise<VersionRecord> {
  const normalizedParams = normalizeGenParams(params);
  const { glb } = await generate(sourceImage, normalizedParams, signal);
  const inspection = await inspectGeneratedGlb(glb).catch(() => ({ dimensions: null, warning: null }));

  const recordId = newId();
  const createdAt = Date.now();
  const rec: VersionRecord = {
    id: recordId,
    ts: createdAt,
    name: sourceName,
    params: normalizedParams,
    input: sourceImage,
    glb,
    thumb: null,
    sweepGroupId: sweep?.id,
    sweepIndex: sweep?.index,
    sweepCount: sweep?.count,
    assetId: sweep?.id ?? recordId,
    versionId: recordId,
    parentVersionId: undefined,
    operation: "generated",
    operationParams: {},
    createdAt,
    label: sourceName,
    favorite: false,
    metrics: { fileSize: glb.size, ...(inspection.dimensions ? { dimensions: inspection.dimensions } : {}) },
    qualityWarning: inspection.warning ?? undefined,
  };

  let savedPath: string | null = null;
  if (isTauri()) {
    try {
      const bytes = new Uint8Array(await glb.arrayBuffer());
      const base = sourceName.replace(/\.[^.]+$/, "") || "model";
      const fname = `${base}_${normalizedParams.resolution}_seed${normalizedParams.seed}_${rec.id}.glb`;
      savedPath = await saveToOutputDir(fname, bytes);
    } catch (e) {
      toast(`Auto-save to output folder failed: ${(e as Error).message}`, "err");
    }
  }
  if (announce) {
    if (rec.qualityWarning) {
      toast(`Collapsed into a plane. ${REFERENCE_GUIDANCE} The GLB was still saved.`, "err");
    } else {
      toast(savedPath ? `Saved to ${savedPath}` : "Generation complete", "ok");
    }
  }

  await put(rec);
  if (isEphemeral() && !warnedEphemeral) {
    warnedEphemeral = true;
    toast(
      "Gallery will not persist across restarts (IndexedDB unavailable), but every generation is saved to the output folder.",
      "err",
    );
  }
  await refreshGallery();

  if (autoOpen && !activeId && !currentGlb) try {
    const instance = await getViewer();
    disposeEditorSession();
    const stats = await instance.load(glb);
    rec.metrics = statsToMetrics(stats);
    currentGlb = glb;
    activeId = rec.id;
    activeParams = normalizedParams;
    activeLabel = rec.label;
    setViewerTools(true);
    updateViewerCaption();
    renderViewerStats(stats, normalizedParams);
    renderMeshParts(instance);
    await put(rec);
    setWorkspaceMode("view");
    const thumb = await instance.thumbnail();
    if (thumb) {
      rec.thumb = thumb;
      await put(rec);
      await refreshGallery();
    }
  } catch (e) {
    toast(`3D preview could not render (the result is still saved): ${(e as Error).message}`, "err");
  }
  return rec;
}

const announcedSweeps = new Set<string>();
const sweepCandidates = new Map<string, CandidateSlot[]>();

function announceSweepWhenComplete(sweepId: string): void {
  if (announcedSweeps.has(sweepId)) return;
  const slots = sweepCandidates.get(sweepId);
  if (!slots || slots.some((slot) => slot.status === "queued" || slot.status === "generating")) return;
  announcedSweeps.add(sweepId);
  sweepCandidates.delete(sweepId);
  const ready = slots.filter((slot) => slot.status === "ready").length;
  const collapsed = slots.filter((slot) => slot.record?.qualityWarning).length;
  toast(
    collapsed
      ? `Seed sweep complete: ${ready}/${slots.length} candidates; ${collapsed} collapsed into a plane. ${REFERENCE_GUIDANCE}`
      : `Seed sweep complete: ${ready}/${slots.length} candidates`,
    ready && !collapsed ? "ok" : "err",
  );
}

async function runGenerationQueue(): Promise<void> {
  if (currentJob) return;
  const job = generationQueue.shift();
  if (!job) {
    progress.classList.add("hidden");
    updateGenerateEnabled();
    return;
  }
  currentJob = job;
  if (job.candidate) {
    job.candidate.status = "generating";
    renderCandidates();
  }
  startRun(job);
  try {
    const rec = await generateRecord(
      job.params,
      job.image,
      job.name,
      abort!.signal,
      job.autoOpen,
      !job.sweep,
      job.sweep,
    );
    if (job.candidate) {
      job.candidate.record = rec;
      job.candidate.status = "ready";
    }
  } catch (error) {
    const cancelled = Boolean(abort?.signal.aborted);
    if (job.candidate) {
      job.candidate.status = cancelled ? "cancelled" : "failed";
      job.candidate.error = cancelled ? undefined : (error as Error).message || "generation failed";
    }
    toast(cancelled ? `${job.label} cancelled` : (error as Error).message || "generation failed", cancelled ? "" : "err");
  } finally {
    finishRun();
    currentJob = null;
    abort = null;
    renderCandidates();
    if (job.sweep) announceSweepWhenComplete(job.sweep.id);
    updateQueueStatus();
    void runGenerationQueue();
  }
}

function doGenerate(): void {
  if (!inputImage) return;
  let params: GenParams;
  try {
    params = readParams();
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  const noModelYet = !activeId && !currentGlb && !currentJob && generationQueue.length === 0;
  queueJob({
    image: inputImage,
    name: inputName,
    params,
    label: `${inputName.replace(/\.[^.]+$/, "") || "Model"} · seed ${params.seed}`,
    autoOpen: noModelYet,
  });
}

generateBtn.addEventListener("click", doGenerate);
progressCollapseBtn.addEventListener("click", () => {
  const collapsed = progressCard.classList.toggle("collapsed");
  progressCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  progressCollapseBtn.setAttribute("aria-label", collapsed ? "Expand job progress" : "Minimize job progress");
  progressCollapseBtn.title = collapsed ? "Expand job progress" : "Minimize job progress";
  const icon = progressCollapseBtn.querySelector(".button-icon");
  icon?.classList.toggle("icon-minus", !collapsed);
  icon?.classList.toggle("icon-plus", collapsed);
});
cancelBtn.addEventListener("click", () => abort?.abort());
clearQueueBtn.addEventListener("click", () => {
  if (!generationQueue.length) return;
  const removed = generationQueue.splice(0);
  const affectedSweeps = new Set<string>();
  for (const job of removed) {
    if (job.candidate?.status === "queued") job.candidate.status = "cancelled";
    if (job.sweep) affectedSweeps.add(job.sweep.id);
  }
  renderCandidates();
  affectedSweeps.forEach(announceSweepWhenComplete);
  updateQueueStatus();
  toast(`${removed.length} queued job${removed.length === 1 ? "" : "s"} removed`);
});

function doSweep(): void {
  if (!inputImage) return;
  let baseParams: GenParams;
  try {
    baseParams = readParams();
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  const count = Math.max(2, Math.min(8, parseInt($<HTMLSelectElement>("ctl-sweep-count").value, 10) || 4));
  const firstSeed = Math.max(1, baseParams.seed || 1);
  const sweepGroupId = newId();
  candidates = Array.from({ length: count }, (_, index) => ({
    seed: firstSeed + index,
    status: "queued" as CandidateStatus,
  }));
  sweepCandidates.set(sweepGroupId, candidates);
  candidateWrap.classList.remove("hidden");
  renderCandidates();
  const sweepImage = inputImage;
  const sweepName = inputName;
  const canOpenFirst = !activeId && !currentGlb && !currentJob && generationQueue.length === 0;
  candidates.forEach((slot, index) => {
    queueJob({
      image: sweepImage,
      name: sweepName,
      params: {
        ...baseParams,
        resolution: 512,
        seed: slot.seed,
        textureResolution: baseParams.textureResolution === 1024 ? "auto" : baseParams.textureResolution,
      },
      label: `Candidate ${index + 1}/${count} · seed ${slot.seed}`,
      autoOpen: canOpenFirst && index === 0,
      sweep: { id: sweepGroupId, index, count },
      candidate: slot,
    });
  });
}

sweepBtn.addEventListener("click", doSweep);

// ---- viewer tools ----
function setViewerTools(on: boolean): void {
  resetViewBtn.disabled = !on;
  saveGlbBtn.disabled = !on;
  if (!on) renderSelection(null);
  syncViewerReference();
}
viewerReferenceToggle.addEventListener("click", () => {
  const expanded = viewerReferencePopover.classList.contains("hidden");
  viewerReferencePopover.classList.toggle("hidden", !expanded);
  viewerReferenceToggle.setAttribute("aria-expanded", String(expanded));
});
resetViewBtn.addEventListener("click", () => runViewer((instance) => instance.resetView()));
saveGlbBtn.addEventListener("click", async () => {
  try {
    const blob = editorSession ? await exportEditedBlob() : currentGlb;
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const base = (activeLabel || inputName).replace(/\.[^.]+$/, "") || "model";
    const ok = await saveBytes(`${base}${editorSession ? "_edited" : ""}.glb`, bytes);
    if (ok) toast(editorSession ? "Edited GLB exported" : "Saved", "ok");
  } catch (error) {
    toast((error as Error).message || "GLB export failed", "err");
  }
});

// ---- gallery ----
async function loadRecordData(rec: VersionRecord): Promise<void> {
  let stats: ViewerStats;
  let instance: Viewer;
  try {
    instance = await getViewer();
    disposeEditorSession();
    stats = await instance.load(rec.glb);
  } catch (e) {
    toast((e as Error).message, "err");
    return;
  }
  activeParams = normalizeGenParams(rec.params);
  renderViewerStats(stats, activeParams);
  renderMeshParts(instance);
  setWorkspaceMode("view");
  inputImage = rec.input;
  inputName = rec.name;
  clearMaskPreview();
  setInputPreviewBlob(rec.input);
  inputPreview.classList.remove("hidden");
  dropHint.classList.add("hidden");
  showInputPreview("source");
  applyParams(rec.params);
  currentGlb = rec.glb;
  activeId = rec.id;
  activeLabel = rec.label;
  setViewerTools(true);
  updateViewerCaption();
  updateGenerateEnabled();
  let recordChanged = false;
  const measuredMetrics = statsToMetrics(stats);
  if (!rec.metrics || !rec.metrics.dimensions) {
    rec.metrics = measuredMetrics;
    recordChanged = true;
  }
  const measuredWarning = detectPlaneCollapse(measuredMetrics.dimensions);
  if (measuredWarning && !rec.qualityWarning) {
    rec.qualityWarning = measuredWarning;
    recordChanged = true;
    toast(`Collapsed into a plane. ${REFERENCE_GUIDANCE}`, "err");
  }
  if (!rec.thumb) {
    const thumb = await instance.thumbnail().catch(() => null);
    if (thumb) {
      rec.thumb = thumb;
      recordChanged = true;
    }
  }
  if (recordChanged) await put(rec);
  await refreshGallery();
  renderCandidates();
}

function renderCandidates(): void {
  candidateUrls.forEach((url) => URL.revokeObjectURL(url));
  candidateUrls = [];
  candidateGallery.innerHTML = "";
  candidateWrap.classList.toggle("hidden", candidates.length === 0);
  if (!candidates.length) return;

  const complete = candidates.filter((slot) => slot.status === "ready" || slot.status === "failed").length;
  candidateSummary.textContent = `${complete}/${candidates.length} complete. Click a result to select its seed.`;

  for (const slot of candidates) {
    const item = createButton({
      label: `Seed ${slot.seed}`,
      variant: "secondary",
      className: `candidate ${slot.status}${slot.record?.id === activeId ? " active" : ""}${slot.record?.qualityWarning ? " quality-warning" : ""}`,
    });
    item.disabled = !slot.record;
    item.title = slot.error || `Seed ${slot.seed}`;

    const preview = document.createElement("div");
    preview.className = "candidate-preview";
    if (slot.record) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(slot.record.thumb ?? slot.record.input);
      candidateUrls.push(url);
      img.src = url;
      img.alt = `3D candidate generated with seed ${slot.seed}`;
      preview.appendChild(img);
    } else {
      const state = document.createElement("span");
      state.textContent = slot.status === "generating" ? "Generating" : slot.status;
      preview.appendChild(state);
    }
    item.appendChild(preview);

    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    const seed = document.createElement("strong");
    seed.textContent = `Seed ${slot.seed}`;
    const status = document.createElement("span");
    status.textContent = slot.record?.qualityWarning
      ? "Plane collapse"
      : slot.record?.id === activeId
      ? "Selected"
      : slot.status === "ready" ? "Select" : slot.status;
    meta.append(seed, status);
    item.appendChild(meta);

    if (slot.record) {
      item.addEventListener("click", async () => {
        $<HTMLInputElement>("ctl-seed").value = String(slot.seed);
        await loadRecordData(slot.record!);
      });
    }
    candidateGallery.appendChild(item);
  }
}

clearCandidatesBtn.addEventListener("click", () => {
  if (generating) {
    toast("Wait for generation to finish before clearing candidates", "err");
    return;
  }
  candidates = [];
  renderCandidates();
});

async function refreshGallery(): Promise<void> {
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls = [];
  const recs = await all();
  galleryEl.innerHTML = "";
  if (!recs.length) {
    gallerySummary.textContent = "";
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "No assets yet. Generate a model to start a version history.";
    galleryEl.appendChild(empty);
    return;
  }
  const assetIds = [...new Set(recs.map((record) => record.assetId))];
  const assetGroups = await Promise.all(assetIds.map(async (assetId) => ({
    assetId,
    records: (await listAssetVersions(assetId)).sort((a, b) => b.createdAt - a.createdAt),
  })));
  gallerySummary.textContent = `${assetGroups.length} assets, ${recs.length} versions`;

  for (const asset of assetGroups) {
    const records = asset.records;
    if (!records.length) continue;
    const assetGroup = document.createElement("section");
    assetGroup.className = "asset-group";

    const versions = document.createElement("div");
    versions.className = "asset-versions";
    const renderedSweeps = new Set<string>();
    for (const record of records) {
      const sweepId = record.sweepGroupId;
      if (sweepId && renderedSweeps.has(sweepId)) continue;
      const versionRecords = sweepId
        ? records
            .filter((candidate) => candidate.sweepGroupId === sweepId)
            .sort((a, b) => (a.sweepIndex ?? a.params.seed) - (b.sweepIndex ?? b.params.seed))
        : [record];
      if (sweepId) renderedSweeps.add(sweepId);
      const representative = versionRecords.find((candidate) => candidate.id === activeId) ?? versionRecords[0];
      const isSweep = versionRecords.length > 1 || Boolean(sweepId);
      const warnings = versionRecords
        .map((candidate) => candidate.qualityWarning ?? detectPlaneCollapse(candidate.metrics?.dimensions))
        .filter((warning) => warning !== null && warning !== undefined);
      const item = document.createElement("article");
      item.className = `version-item${versionRecords.some((candidate) => candidate.id === activeId) ? " active" : ""}${warnings.length ? " quality-warning" : ""}`;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.title = warnings.length
        ? `${representative.label} | collapsed into a plane | ${REFERENCE_GUIDANCE}`
        : isSweep
        ? `${representative.label} | seed sweep with ${versionRecords.length} candidates`
        : `${representative.label} | ${new Date(representative.createdAt).toLocaleString()}`;

      const itemHead = document.createElement("div");
      itemHead.className = "version-item-head";
      const itemIdentity = document.createElement("div");
      itemIdentity.className = "version-item-identity";
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = representative.label || representative.name;
      const versionCount = document.createElement("span");
      versionCount.className = "version-count";
      versionCount.title = `${versionRecords.length} version${versionRecords.length === 1 ? "" : "s"}`;
      versionCount.setAttribute("aria-label", versionCount.title);
      const versionCountIcon = document.createElement("span");
      versionCountIcon.className = "button-icon icon-stack";
      versionCountIcon.setAttribute("aria-hidden", "true");
      versionCount.append(versionCountIcon, String(versionRecords.length));
      itemIdentity.append(itemTitle, versionCount);
      itemHead.appendChild(itemIdentity);
      item.appendChild(itemHead);

      const img = document.createElement("img");
      const url = URL.createObjectURL(representative.thumb ?? representative.input);
      galleryUrls.push(url);
      img.src = url;
      img.alt = `${representative.label} preview`;
      item.appendChild(img);

      const versionMeta = document.createElement("div");
      versionMeta.className = "version-meta";
      const versionDetails = document.createElement("span");
      const actualFaces = representative.metrics?.triangles;
      const parent = representative.parentVersionId
        ? records.find((candidate) => candidate.versionId === representative.parentVersionId)
        : undefined;
      const comparison = parentComparisonText(representative, parent);
      versionDetails.textContent = warnings.length
        ? isSweep
          ? `Seed sweep, ${versionRecords.length} candidates | ${warnings.length} plane collapse${warnings.length === 1 ? "" : "s"}`
          : "Collapsed into a plane | use a three-quarter reference"
        : isSweep
        ? `Seed sweep, ${versionRecords.length} candidates`
        : `${representative.operation} | ${actualFaces !== undefined ? compactNumber(actualFaces) + " triangles" : "metrics pending"}${comparison ? ` | ${comparison}` : ""}`;
      versionMeta.append(versionDetails);
      item.appendChild(versionMeta);

      const actions = document.createElement("div");
      actions.className = "version-actions";
      const favoriteBtn = createButton({
        label: representative.favorite ? "Remove from favorites" : "Add to favorites",
        variant: "icon",
        size: "sm",
        icon: "star",
        className: `g-action favorite-action${representative.favorite ? " active" : ""}`,
      });
      favoriteBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await setVersionFavorite(representative.versionId, !representative.favorite);
          await refreshGallery();
        } catch (error) {
          toast((error as Error).message || "Could not update favorite", "err");
        }
      });
      actions.appendChild(favoriteBtn);

      const renameBtn = createButton({
        label: "Rename version",
        variant: "icon",
        size: "sm",
        icon: "pencil-simple",
        className: "g-action rename-action",
      });
      renameBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const nextLabel = window.prompt("Version name", representative.label);
        if (nextLabel === null) return;
        try {
          const renamed = await renameVersion(representative.versionId, nextLabel);
          if (renamed.id === activeId || renamed.versionId === activeId) {
            activeLabel = renamed.label;
            updateViewerCaption();
          }
          await refreshGallery();
        } catch (error) {
          toast((error as Error).message || "Could not rename version", "err");
        }
      });
      actions.appendChild(renameBtn);

      const removeBtn = createButton({
        label: "Remove version",
        variant: "icon",
        size: "sm",
        icon: "trash",
        className: "g-action remove-action danger",
      });
      removeBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (generating) {
          toast("Wait for generation to finish before removing versions", "err");
          return;
        }
        try {
          // Preflight the whole sweep before deleting anything. A derived
          // child makes the branch unsafe to remove with the non-cascading
          // store API; checking all records first prevents partial sweeps.
          const recordsBeforeDelete = await all();
          const targetIds = new Set(versionRecords.flatMap((version) => [version.id, version.versionId]));
          const dependent = recordsBeforeDelete.find(
            (record) => record.parentVersionId && targetIds.has(record.parentVersionId),
          );
          if (dependent) {
            toast("Remove derived versions before removing this sweep", "err");
            return;
          }
          for (const version of versionRecords) await removeRecord(version.id);
          if (versionRecords.some((version) => version.id === activeId)) {
            clearCurrentModelState();
            viewer?.clear();
            if (viewer) renderMeshParts(viewer);
          }
          await refreshGallery();
        } catch (error) {
          toast((error as Error).message || "Could not remove version", "err");
        }
      });
      actions.appendChild(removeBtn);
      itemHead.appendChild(actions);

      const openVersion = async (): Promise<void> => {
        if (isSweep) {
          candidates = versionRecords.map((candidate) => ({
            seed: candidate.params.seed,
            status: "ready",
            record: candidate,
          }));
        }
        await loadRecordData(representative);
      };
      item.addEventListener("click", () => void openVersion());
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openVersion();
        }
      });
      versions.appendChild(item);
    }
    assetGroup.appendChild(versions);
    galleryEl.appendChild(assetGroup);
  }
}

let automationSync: Promise<number> | null = null;
let automationJobsCache: { apiUrl: string; fetchedAt: number; jobs: AutomationJob[] } | null = null;

async function loadAutomationJobs(apiUrl: string, force = false): Promise<AutomationJob[]> {
  const now = Date.now();
  if (
    !force &&
    automationJobsCache &&
    automationJobsCache.apiUrl === apiUrl &&
    now - automationJobsCache.fetchedAt < 1000
  ) {
    return automationJobsCache.jobs;
  }
  const jobs = await automationJobs(apiUrl);
  automationJobsCache = { apiUrl, fetchedAt: now, jobs };
  return jobs;
}

function syncAutomationResults(): Promise<number> {
  if (!isTauri()) return Promise.resolve(0);
  if (automationSync) return automationSync;
  automationSync = (async () => {
    try {
      const api = await automationInfo();
      if (!api?.running) return 0;
      const [jobs, existing] = await Promise.all([loadAutomationJobs(api.url), all()]);
      const existingIds = new Set(existing.map((record) => record.id));
      let imported = 0;
      let importedWarnings = 0;

      for (const job of jobs) {
        if (job.status !== "succeeded") continue;
        const recordId = `automation-${job.id}`;
        if (existingIds.has(recordId)) continue;
        try {
          const { glb, input } = await automationJobFiles(api.url, job.id);
          const inspection = await inspectGeneratedGlb(glb).catch(() => ({ dimensions: null, warning: null }));
          const createdAt = job.submittedAt || Date.now();
          const params = normalizeGenParams(job.params);
          const record: VersionRecord = {
            id: recordId,
            ts: createdAt,
            name: job.sourceName || "Automation source",
            params,
            input,
            glb,
            thumb: null,
            assetId: recordId,
            versionId: recordId,
            operation: "generated",
            operationParams: { automationJobId: job.id },
            createdAt,
            label: job.sourceName || `Automation ${job.id}`,
            favorite: false,
            metrics: { fileSize: glb.size, ...(inspection.dimensions ? { dimensions: inspection.dimensions } : {}) },
            qualityWarning: job.qualityWarning ?? inspection.warning ?? undefined,
          };
          await put(record);
          if (record.qualityWarning) importedWarnings += 1;
          existingIds.add(recordId);
          imported += 1;
        } catch (error) {
          console.warn(`Could not import automation job ${job.id}`, error);
        }
      }
      if (imported > 0) {
        await refreshGallery();
        toast(
          importedWarnings
            ? `${imported} automation model${imported === 1 ? "" : "s"} added to Assets; ${importedWarnings} collapsed into a plane. ${REFERENCE_GUIDANCE}`
            : `${imported} automation model${imported === 1 ? "" : "s"} added to Assets`,
          importedWarnings ? "err" : "ok",
        );
      }
      return imported;
    } catch (error) {
      console.warn("Could not sync automation results; keeping the local gallery available", error);
      return 0;
    }
  })().finally(() => {
    automationSync = null;
  });
  return automationSync;
}

clearGalleryBtn.addEventListener("click", async () => {
  if (generating) {
    toast("Wait for generation to finish before clearing the gallery", "err");
    return;
  }
  if (!confirm("Delete all saved generations?")) return;
  try {
    await clearStore();
    candidates = [];
    renderCandidates();
    clearCurrentModelState();
    viewer?.clear();
    if (viewer) renderMeshParts(viewer);
    await refreshGallery();
  } catch (error) {
    toast((error as Error).message || "Could not clear the gallery", "err");
  }
});

// ---- settings modal ----
const modal = $("settings-modal");
async function openSettings(): Promise<void> {
  await renderSettings($("settings-body"), () => {
    pollHealth();
    modal.classList.add("hidden");
    toast("Settings applied");
  });
  modal.classList.remove("hidden");
}
$("settings-btn").addEventListener("click", openSettings);
$("banner-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

// ---- server status ----
async function pollHealthInternal(): Promise<void> {
  const cfg = await loadConfig(true);
  backendBadge.textContent = cfg.backend !== "unknown" ? cfg.backend : "-";
  const ok = await health();
  serverOnline = ok;
  serverDot.className = "dot " + (ok ? "ok" : "err");
  serverLabel.textContent = ok ? "ready" : cfg.configured ? "offline" : "setup needed";
  const needSetup = !ok && !cfg.configured;
  setupBanner.classList.toggle("hidden", !needSetup);
  if (needSetup) {
    (setupBanner.querySelector("span") as HTMLElement).textContent =
      "Trellis Studio is not set up yet. Run the installer or point it at your models directory.";
  } else if (!ok && cfg.configured) {
    setupBanner.classList.remove("hidden");
    (setupBanner.querySelector("span") as HTMLElement).textContent =
      "Server is offline. It may still be loading; check the models directory in settings.";
  }
  updateGenerateEnabled();
  if (isTauri()) {
    try {
      const api = await automationInfo();
      if (!api?.running) automationJobsCache = null;
      const jobs = api?.running ? await loadAutomationJobs(api.url) : [];
      const runningJobs = jobs.filter((job) => job.status === "running").length;
      const queuedJobs = jobs.filter((job) => job.status === "queued").length;
      const queueLabel = runningJobs || queuedJobs
        ? ` · ${runningJobs} running · ${queuedJobs} queued`
        : " · queue idle";
      automationBadge.textContent = api?.running
        ? `API :${api.port}${queueLabel}`
        : "API offline";
      automationBadge.classList.toggle("ok", Boolean(api?.running));
      automationBadge.title = api
        ? `${api.url}\nConcurrency ${api.maxConcurrency}: ${api.reason}`
        : "Local automation API unavailable";
    } catch {
      automationBadge.textContent = "API offline";
      automationBadge.classList.remove("ok");
    }
  } else {
    automationBadge.classList.add("hidden");
  }
}

async function pollHealth(): Promise<void> {
  try {
    await pollHealthInternal();
  } catch (error) {
    console.warn("Could not refresh Trellis server status", error);
    serverOnline = false;
    serverDot.className = "dot err";
    serverLabel.textContent = "offline";
    automationBadge.textContent = "API offline";
    automationBadge.classList.remove("ok");
    updateGenerateEnabled();
  }
}

// ---- server log -> progress (Tauri only) ----
function listenSafely<T>(event: string, handler: (payload: T) => void): void {
  void listen<T>(event, handler).catch((error) => {
    console.warn(`Could not subscribe to ${event}`, error);
  });
}

listenSafely<string>("server-log", (line) => {
  if (generating) updateProgressFromServerLog(String(line));
});
listenSafely<string>("tray-action-blocked", (message) => {
  toast(String(message), "err");
});
listenSafely("studio-shown", () => {
  void syncAutomationResults();
});
listenSafely("server-restarted", () => {
  automationJobsCache = null;
  void pollHealth();
});

window.addEventListener("focus", () => {
  void syncAutomationResults();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncAutomationResults();
});

// ---- boot ----
async function boot(): Promise<void> {
  setViewerTools(false);
  renderViewerStats(null);
  setWorkspaceMode("generate");
  await pollHealth();
  await syncAutomationResults();
  await refreshGallery();
  window.setInterval(pollHealth, 4000);
  if (!isTauri()) {
    // Browser mode: no shell to report a backend.
    backendBadge.textContent = "browser";
  }
}
void boot().catch((error) => {
  console.error("Trellis Studio boot failed", error);
});
