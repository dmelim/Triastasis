import "./ui.css";
import type { BufferGeometry, Mesh, Object3D } from "three";
import { generate, health } from "./api";
import { loadConfig } from "./config";
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
import { automationInfo, isTauri, listen, previewAlpha, saveBytes, saveToOutputDir } from "./tauri";
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
const progressStage = $("progress-stage");
const progressElapsed = $("progress-elapsed");
const cancelBtn = $<HTMLButtonElement>("cancel-btn");
const resetViewBtn = $<HTMLButtonElement>("reset-view");
const openViewBtn = $<HTMLButtonElement>("open-view");
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
const clearGalleryBtn = $("clear-gallery");
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
let progressPrefix = "";
let activeLabel = "";

type WorkspaceMode = "generate" | "view";

type CandidateStatus = "queued" | "generating" | "ready" | "failed" | "cancelled";
interface CandidateSlot {
  seed: number;
  status: CandidateStatus;
  record?: VersionRecord;
  error?: string;
}
let candidates: CandidateSlot[] = [];

// ---- workspace modes and viewer inspector ----
function setWorkspaceMode(mode: WorkspaceMode): void {
  const generatingMode = mode === "generate";
  generateModeBtn.classList.toggle("active", generatingMode);
  viewModeBtn.classList.toggle("active", !generatingMode);
  generateModeBtn.setAttribute("aria-selected", String(generatingMode));
  viewModeBtn.setAttribute("aria-selected", String(!generatingMode));
  generateModePanel.classList.toggle("hidden", !generatingMode);
  viewModePanel.classList.toggle("hidden", generatingMode);
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
  targetFacesWrap.classList.toggle("hidden", targetFacesMode.value !== "custom");
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

function captureEditorState(root: Object3D, operations: Array<Record<string, unknown>> = []): EditorState {
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
  return {
    geometryByUuid,
    transforms,
    materials: sceneEditsModule.captureMaterialSnapshots(root),
    operations: operations.map((operation) => ({ ...operation })),
  };
}

function disposeEditorState(state: EditorState): void {
  const geometries = new Set(state.geometryByUuid.values());
  for (const geometry of geometries) geometry.dispose();
}

function applyEditorState(root: Object3D, state: EditorState): void {
  if (!sceneEditsModule) throw new Error("Editing helpers are not loaded");
  const objects = new Map<string, Object3D>();
  root.traverse((object) => objects.set(object.uuid, object));
  for (const [uuid, geometry] of state.geometryByUuid) {
    const object = objects.get(uuid) as (Mesh & { geometry?: BufferGeometry }) | undefined;
    if (object?.geometry) object.geometry = geometry;
  }
  for (const snapshot of state.transforms.values()) {
    const object = objects.get(snapshot.objectUuid);
    if (object) sceneEditsModule.restoreTransformSnapshot(object, snapshot);
  }
  sceneEditsModule.restoreMaterialSnapshots(root, state.materials);
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

function renderMaterialFields(mesh: Mesh | null): void {
  const color = $<HTMLInputElement>("edit-base-color");
  const metalness = $<HTMLInputElement>("edit-metalness");
  const roughness = $<HTMLInputElement>("edit-roughness");
  if (!mesh) {
    color.value = "#ffffff";
    metalness.value = "0";
    roughness.value = "0.5";
  } else {
    const snapshots = sceneEditsModule
      ? sceneEditsModule.captureMaterialSnapshots(mesh).filter((snapshot) => snapshot.objectUuid === mesh.uuid)
      : [];
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
  renderMaterialFields(mesh);
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
    scene = sceneEdits.cloneEditableScene(sourceRoot);
    const stats = instance.loadRoot(scene.root, currentGlb?.size ?? activeStats?.fileSize ?? 0, activeStats?.animations ?? 0);
    const initial = captureEditorState(scene.root);
    editorSession = {
      scene,
      history: new editing.EditHistory(initial, {
        maxEntries: 12,
        disposeSnapshot: disposeEditorState,
      }),
    };
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0) {
      instance.selectMesh(instance.getMeshParts()[selectedIndex] ?? null);
    }
    renderViewerStats(stats, activeParams);
    renderMeshParts(instance);
    renderSelection(instance.getSelection());
    setEditNotice("Edits are held in memory until you export or save a derived version.");
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

function commitEditorMutation(
  label: string,
  operation: Record<string, unknown>,
  transientGeometries: BufferGeometry[] = [],
): void {
  const session = editorSession;
  if (!session) return;
  const root = session.scene.root;
  const next = captureEditorState(root, [...session.history.current.operations, operation]);
  session.history.execute({ label, apply: () => next });
  applyEditorState(root, next);
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
    commitEditorMutation("Apply transform", {
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
    const result = sceneEditsModule.applyMaterialEdit(mesh, {
      baseColor: $<HTMLInputElement>("edit-base-color").value,
      metalness,
      roughness,
    });
    if (!result.changed) {
      setEditNotice(result.limitations.join(" ") || "The material values are unchanged.");
      return;
    }
    commitEditorMutation("Apply material", {
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
  commitEditorMutation("Delete connected component", {
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
  commitEditorMutation("Recompute normals", { kind: "recompute-normals", mesh: mesh.name || mesh.uuid }, [result.geometry]);
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
  commitEditorMutation("Reverse triangle winding", { kind: "reverse-winding", mesh: mesh.name || mesh.uuid }, [result.geometry]);
  setEditNotice(result.limitations.join(" "));
}

function applyEditorHistory(direction: "undo" | "redo"): void {
  const session = editorSession;
  if (!session) return;
  const state = direction === "undo" ? session.history.undo() : session.history.redo();
  applyEditorState(session.scene.root, state);
  refreshEditorView();
  setEditNotice(direction === "undo" ? "Undid the last edit." : "Redid the last edit.");
}

async function exportEditedBlob(): Promise<Blob> {
  if (!editorSession) throw new Error("Create an edit copy before exporting");
  if ((activeStats?.animations ?? 0) > 0) {
    throw new Error("Edited export is unavailable while animation clips are present");
  }
  const [, , exporter] = await getEditingModules();
  return exporter.exportGlb(editorSession.scene.root, { onlyVisible: false });
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
    viewerCaption.textContent = `${derived.label} | ${activeParams?.resolution ?? "model"}`;
    await refreshGallery();
    renderEditorActions();
    toast("Derived version saved", "ok");
  } catch (error) {
    toast((error as Error).message || "Could not save derived version", "err");
  }
}

generateModeBtn.addEventListener("click", () => setWorkspaceMode("generate"));
viewModeBtn.addEventListener("click", () => setWorkspaceMode("view"));
openViewBtn.addEventListener("click", () => setWorkspaceMode("view"));

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
editUndoBtn.addEventListener("click", () => applyEditorHistory("undo"));
editRedoBtn.addEventListener("click", () => applyEditorHistory("redo"));
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

for (const control of [targetFacesMode, atlasSizeMode, remeshBandMode]) {
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
}

function clearInputPreview(): void {
  if (inputObjectUrl) URL.revokeObjectURL(inputObjectUrl);
  inputObjectUrl = null;
  inputPreview.removeAttribute("src");
  inputPreview.classList.add("hidden");
  dropHint.classList.remove("hidden");
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
  maskTab.disabled = true;
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
  if ((e as KeyboardEvent).key === "Enter") fileInput.click();
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

// ---- generate ----
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateGenerateEnabled(): void {
  const enabled = Boolean(serverOnline && inputImage && !generating);
  generateBtn.disabled = !enabled;
  sweepBtn.disabled = !enabled;
  previewMaskBtn.disabled = !inputImage || generating || !isTauri();
}

function startRun(prefix = ""): void {
  generating = true;
  progressPrefix = prefix;
  updateGenerateEnabled();
  progress.classList.remove("hidden");
  progressStage.textContent = prefix ? `${prefix}: starting` : "starting";
  const started = Date.now();
  progressElapsed.textContent = "0:00";
  elapsedTimer = window.setInterval(() => {
    progressElapsed.textContent = fmtElapsed(Date.now() - started);
  }, 1000);
  abort = new AbortController();
}

function finishRun(): void {
  generating = false;
  progressPrefix = "";
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  progress.classList.add("hidden");
  updateGenerateEnabled();
}

interface SweepMembership {
  id: string;
  index: number;
  count: number;
}

async function generateRecord(
  params: GenParams,
  announce = true,
  sweep?: SweepMembership,
): Promise<VersionRecord> {
  if (!inputImage) throw new Error("choose an input image first");
  const normalizedParams = normalizeGenParams(params);
  const sourceImage = inputImage;
  const sourceName = inputName;
  const { glb } = await generate(sourceImage, normalizedParams, abort?.signal);
  currentGlb = glb;

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
    metrics: null,
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
  if (announce) toast(savedPath ? `Saved to ${savedPath}` : "Generation complete", "ok");

  await put(rec);
  if (isEphemeral() && !warnedEphemeral) {
    warnedEphemeral = true;
    toast(
      "Gallery will not persist across restarts (IndexedDB unavailable), but every generation is saved to the output folder.",
      "err",
    );
  }
  activeId = rec.id;
  activeParams = normalizedParams;
  activeLabel = rec.label;
  setViewerTools(true);
  viewerCaption.textContent = `${normalizedParams.resolution} | seed ${normalizedParams.seed} | ${(glb.size / 1e6).toFixed(1)} MB`;
  await refreshGallery();

  try {
    const instance = await getViewer();
    disposeEditorSession();
    const stats = await instance.load(glb);
    rec.metrics = statsToMetrics(stats);
    activeParams = normalizedParams;
    renderViewerStats(stats, normalizedParams);
    renderMeshParts(instance);
    await put(rec);
    if (announce) setWorkspaceMode("view");
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

async function doGenerate(): Promise<void> {
  if (!inputImage || generating) return;
  let params: GenParams;
  try {
    params = readParams();
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  startRun();
  try {
    await generateRecord(params);
  } catch (e) {
    if (abort?.signal.aborted) toast("Generation cancelled");
    else toast((e as Error).message || "generation failed", "err");
  } finally {
    finishRun();
  }
}

generateBtn.addEventListener("click", doGenerate);
cancelBtn.addEventListener("click", () => abort?.abort());

async function doSweep(): Promise<void> {
  if (!inputImage || generating) return;
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
  candidateWrap.classList.remove("hidden");
  renderCandidates();
  startRun(`Candidate 1/${count}`);
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      if (abort?.signal.aborted) break;
      const slot = candidates[index];
      slot.status = "generating";
      progressPrefix = `Candidate ${index + 1}/${count}, seed ${slot.seed}`;
      progressStage.textContent = `${progressPrefix}: starting`;
      renderCandidates();
      try {
        slot.record = await generateRecord(
          { ...baseParams, resolution: 512, seed: slot.seed },
          false,
          { id: sweepGroupId, index, count },
        );
        slot.status = "ready";
      } catch (e) {
        if (abort?.signal.aborted) {
          slot.status = "cancelled";
          break;
        }
        slot.status = "failed";
        slot.error = (e as Error).message || "generation failed";
      }
      renderCandidates();
    }
    if (abort?.signal.aborted) {
      for (const slot of candidates) {
        if (slot.status === "queued") slot.status = "cancelled";
      }
      toast("Seed sweep cancelled");
    } else {
      const ready = candidates.filter((slot) => slot.status === "ready").length;
      toast(`Seed sweep complete: ${ready}/${count} candidates`, ready ? "ok" : "err");
    }
  } finally {
    renderCandidates();
    finishRun();
  }
}

sweepBtn.addEventListener("click", doSweep);

// ---- viewer tools ----
function setViewerTools(on: boolean): void {
  resetViewBtn.disabled = !on;
  openViewBtn.disabled = !on;
  saveGlbBtn.disabled = !on;
  if (!on) renderSelection(null);
}
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
  setInputPreviewBlob(rec.input);
  inputPreview.classList.remove("hidden");
  dropHint.classList.add("hidden");
  applyParams(rec.params);
  currentGlb = rec.glb;
  activeId = rec.id;
  activeLabel = rec.label;
  setViewerTools(true);
  viewerCaption.textContent = `${rec.label} | ${activeParams.resolution} | seed ${activeParams.seed}`;
  updateGenerateEnabled();
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = `candidate ${slot.status}${slot.record?.id === activeId ? " active" : ""}`;
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
    status.textContent = slot.record?.id === activeId
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

    const assetHead = document.createElement("div");
    assetHead.className = "asset-head";
    const assetTitle = document.createElement("strong");
    assetTitle.textContent = records[0].label || records[0].name;
    const assetMeta = document.createElement("span");
    assetMeta.textContent = `${records.length} version${records.length === 1 ? "" : "s"}`;
    assetHead.append(assetTitle, assetMeta);
    assetGroup.appendChild(assetHead);

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
      const item = document.createElement("article");
      item.className = `version-item${versionRecords.some((candidate) => candidate.id === activeId) ? " active" : ""}`;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.title = isSweep
        ? `${representative.label} | seed sweep with ${versionRecords.length} candidates`
        : `${representative.label} | ${new Date(representative.createdAt).toLocaleString()}`;

      const img = document.createElement("img");
      const url = URL.createObjectURL(representative.thumb ?? representative.input);
      galleryUrls.push(url);
      img.src = url;
      img.alt = `${representative.label} preview`;
      item.appendChild(img);

      const versionMeta = document.createElement("div");
      versionMeta.className = "version-meta";
      const versionLabel = document.createElement("strong");
      versionLabel.textContent = representative.label;
      const versionDetails = document.createElement("span");
      const actualFaces = representative.metrics?.triangles;
      const parent = representative.parentVersionId
        ? records.find((candidate) => candidate.versionId === representative.parentVersionId)
        : undefined;
      const comparison = parentComparisonText(representative, parent);
      versionDetails.textContent = isSweep
        ? `Seed sweep, ${versionRecords.length} candidates`
        : `${representative.operation} | ${actualFaces !== undefined ? compactNumber(actualFaces) + " triangles" : "metrics pending"}${comparison ? ` | ${comparison}` : ""}`;
      versionMeta.append(versionLabel, versionDetails);
      item.appendChild(versionMeta);

      const actions = document.createElement("div");
      actions.className = "version-actions";
      const favoriteBtn = document.createElement("button");
      favoriteBtn.type = "button";
      favoriteBtn.className = "g-action";
      favoriteBtn.textContent = representative.favorite ? "Unfavorite" : "Favorite";
      favoriteBtn.setAttribute("aria-label", favoriteBtn.textContent + " version");
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

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "g-action";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const nextLabel = window.prompt("Version name", representative.label);
        if (nextLabel === null) return;
        try {
          await renameVersion(representative.versionId, nextLabel);
          await refreshGallery();
        } catch (error) {
          toast((error as Error).message || "Could not rename version", "err");
        }
      });
      actions.appendChild(renameBtn);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "g-action danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
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
      item.appendChild(actions);

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

clearGalleryBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved generations?")) return;
  await clearStore();
  clearCurrentModelState();
  viewer?.clear();
  if (viewer) renderMeshParts(viewer);
  await refreshGallery();
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
async function pollHealth(): Promise<void> {
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
      automationBadge.textContent = api?.running ? `API :${api.port} · queue only` : "API offline";
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

// ---- server log -> progress (Tauri only) ----
listen<string>("server-log", (line) => {
  const t = String(line).trim();
  if (generating && t) progressStage.textContent = progressPrefix ? `${progressPrefix}: ${t}` : t;
});

// ---- boot ----
async function boot(): Promise<void> {
  setViewerTools(false);
  renderViewerStats(null);
  setWorkspaceMode("generate");
  await refreshGallery();
  await pollHealth();
  window.setInterval(pollHealth, 4000);
  if (!isTauri()) {
    // Browser mode: no shell to report a backend.
    backendBadge.textContent = "browser";
  }
}
boot();
