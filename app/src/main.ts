import "./ui.css";
import type { BufferGeometry, Mesh, Object3D } from "three";
import { generate, getGenerationProgress, health, type NativeProgress } from "./api";
import { loadConfig } from "./config";
import { createButton } from "./design-system/button";
import { destroySelect, enhanceSelect, refreshSelect } from "./design-system/select";
import {
  busyContentFor,
  canCloseModal,
  captureControls,
  classifyImportFailure,
  manifestWriteFailureMessage,
  restoreControls,
  type BusyControlState,
  type ManifestWriteFailureContext,
} from "./modal-busy";
import {
  cancelCandidateManifest,
  finishGenerationManifest,
  finishResumedManifest,
  hasDurableGeneratedArtifact,
  manifestRecordedParams,
  manifestStoresAdvancedSettings,
  metricsFromModelMetrics,
  prepareSweepManifests,
  safeStem,
  setCandidateManifestState,
  startGenerationManifest,
  type ManifestContext,
} from "./generation-manifest";
import {
  executeRecoveryPlan,
  planRecoveryQueue,
  queueableCandidates,
  recoveryEligibility,
  requiresTerminalFinalization,
  sortBySweepIndex,
  summarizeWarnings,
  type RecoveryCandidate,
} from "./sweep-recovery";
import { escapeHtml, hasBlockingCoreIssue, manifestIssueText } from "./manifest-ui";
import { initModelDownloadState } from "./model-download-state";
import { initModelSetup, openModelSetup } from "./model-setup";
import { subscribeModelStorageRefresh } from "./model-settings";
import type { ManifestMetrics, ManifestQualityWarning } from "./types";
import {
  detectPlaneCollapse,
  inspectGeneratedGlb,
  REFERENCE_GUIDANCE,
} from "./generation-quality";
import {
  GENERATION_PRESETS,
  matchingGenerationPreset,
  type GenerationPreset,
} from "./generation-presets";
import { filterLibraryEntries, type LibraryFilter, type LibrarySort } from "./library-filter";
import {
  allowsGenerationAboveRecommendation,
  describeHardware,
  detectGenerationHardware,
  resolutionAllowed,
  type GenerationHardwareProfile,
} from "./hardware-profile";
import type { ComponentAnalysis, EditHistory } from "./editing";
import { progressDisplayMode, renderSettings, type ProgressDisplayMode } from "./settings";
import { readMigratedPreference } from "./storage-migration";
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
  galleryLoadFailed,
  galleryRecoveryCount,
  isEphemeral,
  listAssetVersions,
  newId,
  put,
  renameVersion,
  setVersionFavorite,
} from "./store";
import {
  automationInfo,
  automationImportRequests,
  automationJobFiles,
  automationJobs,
  claimAutomationImport,
  completeAutomationImport,
  discoverGenerationManifests,
  findLinkedManifest,
  importGenerationManifest,
  isTauri,
  listen,
  listenForNativeFileDrops,
  listSiblingManifests,
  previewAlpha,
  readDroppedImage,
  readGenerationManifest,
  readManifestAsset,
  relinkManifestFile,
  saveBytes,
  saveToOutputDir,
  scanInterruptedManifests,
} from "./tauri";
import type {
  AutomationImportCompletion,
  AutomationImportRequest,
  AutomationJob,
  ImportedGeneration,
} from "./tauri";
import type { GenerationManifest, GenerationQualityWarning } from "./types";
import type { CameraPreset, CameraType, DisplayMode, TopologyDetail, Viewer, ViewerSelection, ViewerStats } from "./viewer";
import {
  DEFAULT_PARAMS,
  GenParamsValidationError,
  normalizeGenParams,
  type GenParams,
  type ModelMetrics,
  type NormalizedGenParams,
  type VersionRecord,
} from "./types";
import { SWEEP_MAX_CANDIDATES, SWEEP_MIN_CANDIDATES, createSweepSeeds } from "./sweep-seeds";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

document.querySelectorAll<HTMLSelectElement>("select").forEach((element) => enhanceSelect(element));

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
const progressCard = $<HTMLElement>("progress-card");
const progressMinimizeBtn = $<HTMLButtonElement>("progress-minimize-btn");
const progressActions = $("progress-actions");
const progressChip = $<HTMLButtonElement>("progress-chip");
const progressChipTitle = $("progress-chip-title");
const progressChipPercent = $("progress-chip-percent");
const progressChipElapsed = $("progress-chip-elapsed");
const progressChipQueued = $("progress-chip-queued");
const chipBarFill = $<HTMLElement>("progress-chip-bar-fill");
const cancelBtn = $<HTMLButtonElement>("cancel-btn");
const clearQueueBtn = $<HTMLButtonElement>("clear-queue-btn");
const viewerCaption = $("viewer-caption");
const viewerEmpty = $("viewer-empty");
const workspace = $("workspace");
const panelLeft = document.querySelector<HTMLElement>(".panel-left")!;
const viewerPanel = document.querySelector<HTMLElement>(".viewer-panel")!;
const generateModeBtn = $<HTMLButtonElement>("mode-generate");
const viewModeBtn = $<HTMLButtonElement>("mode-view");
const libraryModeBtn = $<HTMLButtonElement>("mode-library");
const settingsModeBtn = $<HTMLButtonElement>("settings-btn");
const generateModePanel = $("generate-mode-panel");
const viewModePanel = $("view-mode-panel");
const libraryModePanel = $("library-mode-panel");
const settingsModePanel = $("settings-mode-panel");
const settingsBody = $("settings-body");
const assetDock = $("asset-dock");
const libraryModeSummary = $("library-mode-summary");
const librarySearch = $<HTMLInputElement>("library-search");
const libraryFilter = $<HTMLSelectElement>("library-filter");
const librarySort = $<HTMLSelectElement>("library-sort");
const libraryResultsSummary = $("library-results-summary");
const libraryGrid = $("library-grid");
const inspectEmpty = $("inspect-empty");
const inspectContent = $("inspect-content");
const gallerySummary = $("dock-counts");
const assetLevel = $("assets-level");
const versionLevel = $("versions-level");
const dockToggle = $<HTMLButtonElement>("asset-dock-toggle");
const versionDockToggle = $<HTMLButtonElement>("version-dock-toggle");
const assetLevelCount = $("asset-level-count");
const versionLevelCount = $("version-level-count");
const galleryEl = $("gallery");
const versionGalleryEl = $("version-gallery");
const dockFavoritesToggle = $<HTMLButtonElement>("dock-favorites-toggle");
const clearGalleryBtn = $<HTMLButtonElement>("clear-gallery");
const backendBadge = $("backend-badge");
const automationBadge = $("automation-badge");
const serverDot = $("server-dot");
const serverLabel = $("server-label");
const setupBanner = $("setup-banner");
const galleryRecoveryBanner = $("gallery-recovery-banner");
const galleryRecoveryImport = $<HTMLButtonElement>("gallery-recovery-import");
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
const meshPartsSection = $("mesh-parts-section");
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
const renameModal = $("rename-modal");
const renameTitle = $("rename-title");
const renameLabel = $("rename-label");
const renameForm = $<HTMLFormElement>("rename-form");
const renameInput = $<HTMLInputElement>("rename-input");
const renameError = $("rename-error");
const renameCloseBtn = $<HTMLButtonElement>("rename-close");
const renameCancelBtn = $<HTMLButtonElement>("rename-cancel");

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
const advancedSettings = $<HTMLDetailsElement>("advanced-settings");
const advancedSettingsState = $("advanced-settings-state");
const qualityPresetDescription = $("quality-preset-description");
const hardwareQualityNote = $("hardware-quality-note");
const hardwareResolutionNote = $("hardware-resolution-note");
const qualityPresetInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="generation-quality"]'),
);
const inlineTips = Array.from(document.querySelectorAll<HTMLDetailsElement>(".inline-tip"));

function applyProgressDisplayMode(mode: ProgressDisplayMode): void {
  progress.classList.toggle("progress-mode-sidebar", mode === "sidebar");
}

applyProgressDisplayMode(progressDisplayMode());
window.addEventListener("triastasis-progress-display", (event) => {
  applyProgressDisplayMode((event as CustomEvent<ProgressDisplayMode>).detail);
});

for (const tip of inlineTips) {
  tip.addEventListener("toggle", () => {
    if (!tip.open) return;
    for (const other of inlineTips) if (other !== tip) other.open = false;
  });
}
document.addEventListener("pointerdown", (event) => {
  if ((event.target as HTMLElement).closest(".inline-tip")) return;
  for (const tip of inlineTips) tip.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") for (const tip of inlineTips) tip.open = false;
});

type RenameKind = "asset" | "version";
let resolveRename: ((value: string | null) => void) | null = null;
let renameOpener: HTMLElement | null = null;
let initialRenameValue = "";

function closeRenameModal(value: string | null): void {
  if (!resolveRename) return;
  const resolve = resolveRename;
  resolveRename = null;
  renameModal.classList.add("hidden");
  renameInput.removeAttribute("aria-invalid");
  renameError.textContent = "";
  const opener = renameOpener;
  renameOpener = null;
  resolve(value);
  if (opener && document.contains(opener)) opener.focus();
}

function requestRename(kind: RenameKind, currentValue: string): Promise<string | null> {
  if (resolveRename) closeRenameModal(null);
  renameOpener = document.activeElement as HTMLElement | null;
  initialRenameValue = currentValue.trim();
  const noun = kind === "asset" ? "asset" : "version";
  renameTitle.textContent = `Rename ${noun}`;
  renameLabel.textContent = `${noun[0].toUpperCase()}${noun.slice(1)} name`;
  renameInput.value = currentValue;
  renameInput.removeAttribute("aria-invalid");
  renameError.textContent = "";
  renameModal.classList.remove("hidden");
  requestAnimationFrame(() => {
    renameInput.focus();
    renameInput.select();
  });
  return new Promise((resolve) => {
    resolveRename = resolve;
  });
}

renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextValue = renameInput.value.trim();
  if (!nextValue) {
    renameInput.setAttribute("aria-invalid", "true");
    renameError.textContent = "Enter a name.";
    renameInput.focus();
    return;
  }
  closeRenameModal(nextValue === initialRenameValue ? null : nextValue);
});
renameInput.addEventListener("input", () => {
  if (!renameError.textContent) return;
  renameInput.removeAttribute("aria-invalid");
  renameError.textContent = "";
});
renameCloseBtn.addEventListener("click", () => closeRenameModal(null));
renameCancelBtn.addEventListener("click", () => closeRenameModal(null));
renameModal.addEventListener("click", (event) => {
  if (event.target === renameModal) closeRenameModal(null);
});
renameModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeRenameModal(null);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    renameModal.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])'),
  ).filter((element) => !(element as HTMLButtonElement).disabled && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

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
let serverConfigured = false;
let generating = false;
let abort: AbortController | null = null;
let elapsedTimer: number | null = null;
let galleryUrls: string[] = [];
let libraryUrls: string[] = [];
let candidateUrls: string[] = [];
let warnedEphemeral = false;
let maskObjectUrl: string | null = null;
let inputObjectUrl: string | null = null;
let activeLabel = "";
let generationHardware: GenerationHardwareProfile = {
  backend: "unknown",
  gpuIndex: 0,
  gpuName: null,
  vramMb: null,
  recommendedMaxResolution: 1024,
};

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

type WorkspaceMode = "generate" | "view" | "library" | "settings";

type CandidateStatus = "queued" | "generating" | "ready" | "failed" | "cancelled";
interface CandidateSlot {
  seed: number;
  status: CandidateStatus;
  record?: VersionRecord;
  error?: string;
  /** Durable manifest context persisted before the sweep starts. */
  manifest?: ManifestContext;
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
  /** Set when requeueing an interrupted manifest: lineage is retained. */
  resumeManifest?: ResumeManifest;
}

interface ResumeManifest {
  path: string;
  assetId: string;
  versionId: string;
}

let generationQueue: GenerationJob[] = [];
let currentJob: GenerationJob | null = null;
/**
 * Set when a terminal manifest write failed during the most recent
 * generateRecord run. Recovery scanning is only refreshed after genuinely
 * successful terminal writes — a stale interrupted manifest must stay listed.
 */
let lastManifestWriteFailed = false;

function noteManifestWriteFailure(
  error: unknown,
  context: ManifestWriteFailureContext,
): void {
  lastManifestWriteFailed = true;
  const message = (error as Error).message || String(error);
  toast(manifestWriteFailureMessage(context, message), "err");
}

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
  const viewingMode = mode === "view";
  const libraryMode = mode === "library";
  const settingsMode = mode === "settings";
  const fullPageMode = libraryMode || settingsMode;
  generateModeBtn.classList.toggle("active", generatingMode);
  viewModeBtn.classList.toggle("active", viewingMode);
  libraryModeBtn.classList.toggle("active", libraryMode);
  settingsModeBtn.classList.toggle("active", settingsMode);
  generateModeBtn.setAttribute("aria-selected", String(generatingMode));
  viewModeBtn.setAttribute("aria-selected", String(viewingMode));
  libraryModeBtn.setAttribute("aria-selected", String(libraryMode));
  settingsModeBtn.setAttribute("aria-selected", String(settingsMode));
  generateModeBtn.tabIndex = generatingMode ? 0 : -1;
  viewModeBtn.tabIndex = viewingMode ? 0 : -1;
  libraryModeBtn.tabIndex = libraryMode ? 0 : -1;
  settingsModeBtn.tabIndex = settingsMode ? 0 : -1;
  generateModePanel.classList.toggle("hidden", !generatingMode);
  viewModePanel.classList.toggle("hidden", !viewingMode);
  panelLeft.classList.toggle("hidden", fullPageMode);
  viewerPanel.classList.toggle("hidden", fullPageMode);
  libraryModePanel.classList.toggle("hidden", !libraryMode);
  settingsModePanel.classList.toggle("hidden", !settingsMode);
  assetDock.classList.toggle("hidden", settingsMode);
  workspace.classList.toggle("is-library-mode", libraryMode);
  workspace.classList.toggle("is-settings-mode", settingsMode);
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
  meshPartsSection.classList.toggle("hidden", parts.length <= 1);
  if (parts.length === 1 && !instance.getSelection()) {
    instance.selectMesh(parts[0]);
  }
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
  refreshSelect(meshPartSelect);
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
  refreshSelect(editComponentSelect);
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
libraryModeBtn.addEventListener("click", () => setWorkspaceMode("library"));

const workspaceTabs = [generateModeBtn, viewModeBtn, libraryModeBtn, settingsModeBtn];
workspaceTabs.forEach((tab, index) => {
  tab.addEventListener("keydown", (event) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % workspaceTabs.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + workspaceTabs.length) % workspaceTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = workspaceTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    workspaceTabs[nextIndex].click();
    workspaceTabs[nextIndex].focus();
  });
});

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
  button.addEventListener("click", () => {
    if (button.dataset.camera === "reset") {
      runViewer((instance) => instance.resetView());
      return;
    }
    runViewer((instance) => instance.setCameraPreset(button.dataset.camera as CameraPreset));
  });
});
topologyDetailSelect.addEventListener("change", () => {
  const activeMode = document.querySelector<HTMLButtonElement>("[data-display-mode].active")?.dataset.displayMode;
  const needsTopologyView = activeMode !== "wireframe" && activeMode !== "overlay";
  runViewer((instance) => {
    instance.setTopologyDetail(topologyDetailSelect.value as TopologyDetail);
    if (needsTopologyView) instance.setDisplayMode("overlay");
  });
  if (needsTopologyView) {
    document.querySelectorAll<HTMLButtonElement>("[data-display-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.displayMode === "overlay");
    });
    $("view-topology-detail-help").textContent = "Overlay enabled so the topology change is visible.";
  } else {
    $("view-topology-detail-help").textContent = "Topology density updated.";
  }
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
  syncQualityPreset();
  applyHardwareGuardrails();
}

function syncQualityPreset(): void {
  let preset: GenerationPreset | null = null;
  try {
    preset = matchingGenerationPreset(normalizeGenParams(readParams()));
  } catch {
    preset = null;
  }

  for (const input of qualityPresetInputs) input.checked = input.value === preset;
  if (preset) {
    const definition = GENERATION_PRESETS[preset];
    qualityPresetDescription.textContent = definition.description;
    advancedSettingsState.textContent = definition.label;
    advancedSettingsState.classList.remove("is-custom");
  } else {
    qualityPresetDescription.textContent =
      "Advanced settings have been adjusted. Choose a quality level to reset them.";
    advancedSettingsState.textContent = "Custom";
    advancedSettingsState.classList.add("is-custom");
  }
}

function applyQualityPreset(preset: GenerationPreset): void {
  const seedValue = Number($<HTMLInputElement>("ctl-seed").value);
  const seed = Number.isSafeInteger(seedValue) ? seedValue : DEFAULT_PARAMS.seed!;
  const previousBackgroundRemoval = $<HTMLSelectElement>("ctl-bg").value;
  applyParams({ ...GENERATION_PRESETS[preset].settings, seed });
  clearParamErrors();
  if ($<HTMLSelectElement>("ctl-bg").value !== previousBackgroundRemoval) clearMaskPreview();
}

function applyHardwareGuardrails(normalizeSelection = true): void {
  const override = allowsGenerationAboveRecommendation();
  const maximum = generationHardware.recommendedMaxResolution;
  let selectedPreset: GenerationPreset | null = null;
  try {
    selectedPreset = matchingGenerationPreset(normalizeGenParams(readParams()));
  } catch {
    /* Invalid custom values are reported by the normal form validation. */
  }

  for (const input of qualityPresetInputs) {
    const preset = input.value as GenerationPreset;
    input.disabled = !resolutionAllowed(
      GENERATION_PRESETS[preset].settings.resolution,
      generationHardware,
      override,
    );
  }

  for (const option of Array.from(resolutionSelect.options)) {
    const resolution = Number(option.value) as 512 | 1024 | 1536;
    option.disabled = !resolutionAllowed(resolution, generationHardware, override);
  }

  if (normalizeSelection && !override) {
    if (selectedPreset && GENERATION_PRESETS[selectedPreset].settings.resolution > maximum) {
      applyQualityPreset("low");
    } else if (Number(resolutionSelect.value) > maximum) {
      resolutionSelect.value = String(maximum);
      updateCustomParamVisibility();
      syncQualityPreset();
    }
  }
  refreshSelect(resolutionSelect);

  const hardwareLabel = describeHardware(generationHardware);
  const presetsLocked = qualityPresetInputs.some((input) => input.disabled);
  hardwareQualityNote.classList.toggle("hidden", !presetsLocked);
  hardwareQualityNote.querySelector("span")!.textContent = presetsLocked
    ? `${hardwareLabel}. Higher quality levels are limited to ${maximum}.`
    : "";

  const resolutionLocked = !override && maximum < 1536;
  hardwareResolutionNote.classList.toggle("hidden", !resolutionLocked);
  hardwareResolutionNote.querySelector("span")!.textContent = resolutionLocked
    ? `1536 is disabled: it is experimental and recommended only for GPUs with 16 GB+ VRAM. Detected ${hardwareLabel}; recommended max ${maximum}.`
    : "";
}

async function refreshHardwareGuardrails(): Promise<void> {
  generationHardware = await detectGenerationHardware();
  applyHardwareGuardrails();
}

function hardwareRestriction(params: GenParams): string | null {
  const normalized = normalizeGenParams(params);
  if (resolutionAllowed(normalized.resolution, generationHardware)) return null;
  return `${normalized.resolution} is above the ${generationHardware.recommendedMaxResolution} hardware recommendation. Enable the override in Settings to continue.`;
}

window.addEventListener("triastasis-hardware-policy", () => applyHardwareGuardrails());
$<HTMLButtonElement>("hardware-quality-settings").addEventListener("click", () => void openSettings());
$<HTMLButtonElement>("hardware-resolution-settings").addEventListener("click", () => void openSettings());

for (const input of qualityPresetInputs) {
  input.addEventListener("change", () => {
    if (input.checked) applyQualityPreset(input.value as GenerationPreset);
  });
}

advancedSettings.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")
  .forEach((control) => {
    control.addEventListener("change", syncQualityPreset);
    if (control instanceof HTMLInputElement) control.addEventListener("input", syncQualityPreset);
  });
syncQualityPreset();

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
  clearStandaloneView();
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
  sourceTab.tabIndex = showMask ? -1 : 0;
  maskTab.tabIndex = showMask ? 0 : -1;
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
  sourceTab.tabIndex = 0;
  maskTab.tabIndex = -1;
  previewMaskBtn.disabled = !inputImage || !isTauri();
  previewMaskBtn.textContent = "Preview mask";
  maskHelp.textContent = "";
  maskHelp.classList.add("hidden");
}

sourceTab.addEventListener("click", () => showInputPreview("source"));
maskTab.addEventListener("click", () => showInputPreview("mask"));
[sourceTab, maskTab].forEach((tab) => {
  tab.addEventListener("keydown", (event) => {
    const availableTabs = [sourceTab, maskTab].filter((candidate) => !candidate.disabled);
    const currentIndex = availableTabs.indexOf(tab);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % availableTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = availableTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = availableTabs[nextIndex];
    showInputPreview(nextTab === maskTab ? "mask" : "source");
    nextTab.focus();
  });
});
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
  maskHelp.classList.remove("hidden");
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
    const droppedPath = event.paths[0];
    const lowered = droppedPath.toLowerCase();
    // Manifests and models get dedicated flows before the image path.
    if (lowered.endsWith(".triastasis.json") || lowered.endsWith(".polyloom.json")) {
      void openManifestPreview(droppedPath);
      return;
    }
    if (lowered.endsWith(".glb") || lowered.endsWith(".gltf")) {
      void viewGlbFile(droppedPath);
      return;
    }
    const image = await readDroppedImage(droppedPath);
    setInput(image.blob, image.name);
  } catch (error) {
    toast((error as Error).message || "Could not open the dropped file", "err");
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
  const enabled = Boolean(inputImage);
  generateBtn.disabled = !enabled;
  sweepBtn.disabled = !enabled;
  previewMaskBtn.disabled = !inputImage || generating || !isTauri();
  clearGalleryBtn.disabled = generating;
  clearCandidatesBtn.disabled = generating;
  generateBtn.textContent = generating || generationQueue.length ? "Add to queue" : "Generate 3D";
  clearQueueBtn.disabled = generationQueue.length === 0;
}

function generationBackendReady(): boolean {
  if (serverOnline) return true;
  if (!serverConfigured) {
    const message = "No model bundle is ready. Complete onboarding to choose or download one.";
    toast(message, "err");
    void openModelSetup(message);
    return false;
  }
  toast("The model server is offline. Wait for it to finish starting, or review Models in Settings.", "err");
  return false;
}

// ---- canonical job progress ----
// One state object drives BOTH the expanded card and the minimized chip, so
// they can never disagree. percent === null means indeterminate: the backend
// has no sampler data yet (or is an older server), and we never invent a
// number from elapsed time.
interface JobProgressState {
  stageLabel: string;
  etaText: string;
  percent: number | null;
}
let jobProgress: JobProgressState = { stageLabel: "Preparing the job", etaText: "", percent: null };
let structuredProgressSeen = false;

function renderJobProgress(): void {
  const { stageLabel, etaText, percent } = jobProgress;
  progressStage.textContent = etaText ? `${stageLabel} · ${etaText}` : stageLabel;

  const bars: Array<HTMLElement> = [progressBarFill, chipBarFill];
  for (const bar of bars) bar.classList.toggle("indeterminate", percent === null);
  if (percent === null) {
    progressBar.removeAttribute("aria-valuenow");
    progressBar.setAttribute("aria-valuetext", "In progress");
    for (const bar of bars) bar.style.width = "100%";
    progressChipPercent.textContent = "";
  } else {
    // 100 is reserved for the succeeded snapshot; running values are already
    // capped at 99 by the server and by applyNativeProgress.
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    progressBar.setAttribute("aria-valuenow", String(value));
    progressBar.setAttribute("aria-valuetext", `${value}%`);
    for (const bar of bars) bar.style.width = `${value}%`;
    progressChipPercent.textContent = `${value}%`;
  }
}

function setJobStage(label: string): void {
  jobProgress.stageLabel = label;
  renderJobProgress();
}

function applyNativeProgress(snapshot: NativeProgress): void {
  structuredProgressSeen = true;
  if (snapshot.status === "succeeded") {
    jobProgress.percent = 100;
    jobProgress.stageLabel = snapshot.stageLabel || "Model ready";
    jobProgress.etaText = "";
    renderJobProgress();
    return;
  }
  if (snapshot.stageLabel) jobProgress.stageLabel = snapshot.stageLabel;
  jobProgress.etaText =
    snapshot.stageEtaSeconds !== null && snapshot.status === "running"
      ? `~${Math.round(snapshot.stageEtaSeconds)}s left`
      : "";
  // Monotonic on the client too; null keeps the previous value.
  if (snapshot.percent !== null) {
    jobProgress.percent = Math.max(jobProgress.percent ?? -1, Math.min(99, snapshot.percent));
  }
  renderJobProgress();
}

/**
 * Polls GET /progress/{request_id} while a direct /generate request runs.
 * Returns a stop function. 404s are expected before registration and with
 * older servers; failures leave the last known state untouched.
 */
function startProgressPolling(requestId: string, signal?: AbortSignal): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    while (!stopped && !signal?.aborted) {
      const snapshot = await getGenerationProgress(requestId);
      if (stopped || signal?.aborted) return;
      if (snapshot) applyNativeProgress(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function updateProgressFromServerLog(line: string): void {
  const text = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const stageMatch = text.match(/^\[(\d+)\/(\d+)\]\s*(.*)$/);
  if (stageMatch) {
    const stage = Number(stageMatch[1]);
    const stages: Record<number, string> = {
      1: "Preparing the image",
      2: "Understanding the image",
      3: "Building the coarse shape",
      4: "Refining the 3D structure",
      5: "Building the mesh",
      6: "Generating materials",
      7: "Packing the 3D model",
    };
    const mapped = stages[stage];
    if (mapped) setJobStage(mapped);
    return;
  }

  // The log exposes per-sampler steps only, so there is no truthful whole-job
  // percentage to derive: keep the bar indeterminate and surface the step
  // count as text instead of inventing one from stage weights or time.
  const flowMatch = text.match(/\[flow\]\s+\[[^\]]*\]\s*(\d+)\/(\d+)/);
  if (flowMatch) {
    const done = Number(flowMatch[1]);
    const total = Math.max(1, Number(flowMatch[2]));
    jobProgress.etaText = /~\d+s left/.test(text) ? `~${text.match(/~(\d+)s left/)![1]}s left` : "";
    jobProgress.stageLabel = `${jobProgress.stageLabel.split(" · ")[0]} · Step ${done} of ${total}`;
    renderJobProgress();
    return;
  }

  if (/^done in\s/i.test(text)) {
    jobProgress.etaText = "";
    jobProgress.stageLabel = "Model ready";
    renderJobProgress();
  }
}

function updateQueueStatus(): void {
  const queued = generationQueue.length;
  progressQueue.textContent = queued
    ? `1 running · ${queued} queued`
    : "1 running";
  progressChipQueued.classList.toggle("hidden", queued === 0);
  progressChipQueued.textContent = `+${queued}`;
  syncChipTooltip();
  clearQueueBtn.disabled = queued === 0;
  updateGenerateEnabled();
}

// ---- job card minimized state ----
const JOB_CARD_COLLAPSED_KEY = "triastasis.job-card.collapsed";
const LEGACY_JOB_CARD_COLLAPSED_KEY = "polyloom.job-card.collapsed";
let jobCardCollapsed = false;
let tempExpandTimer: number | null = null;

function syncChipTooltip(): void {
  const queued = generationQueue.length;
  const queuePart = queued ? ` | ${queued} queued` : "";
  progressChip.title = `${progressTitle.textContent || "Generating"}${queuePart} | Expand job card.`;
}

function setJobCardCollapsed(collapsed: boolean, persist = true): void {
  jobCardCollapsed = collapsed;
  if (tempExpandTimer !== null && !collapsed) {
    window.clearTimeout(tempExpandTimer);
    tempExpandTimer = null;
  }
  progressCard.classList.toggle("hidden", collapsed);
  progressChip.classList.toggle("hidden", !collapsed);
  chipBtnState(collapsed);
  if (persist) localStorage.setItem(JOB_CARD_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function chipBtnState(collapsed: boolean): void {
  progressChip.setAttribute("aria-expanded", String(!collapsed));
}

function revealJobCardTemporarily(): void {
  if (!jobCardCollapsed) return;
  setJobCardCollapsed(false, false);
  if (tempExpandTimer !== null) window.clearTimeout(tempExpandTimer);
  tempExpandTimer = window.setTimeout(() => {
    tempExpandTimer = null;
    if (generating && readMigratedPreference(JOB_CARD_COLLAPSED_KEY, LEGACY_JOB_CARD_COLLAPSED_KEY) === "1") {
      setJobCardCollapsed(true, false);
    }
  }, 6000);
}

progressMinimizeBtn.addEventListener("click", () => setJobCardCollapsed(true));
progressChip.addEventListener("click", () => setJobCardCollapsed(false));

// ---- external job monitor ----
// When the UI reopens while a skill-submitted automation job is still queued
// or running, mirror its canonical status. The UI does not own that job, so
// cancel/clear actions stay hidden and polling never touches the GPU worker.
let externalMonitor: { apiUrl: string; jobId: string; timer: number } | null = null;

function stopExternalMonitoring(): void {
  if (externalMonitor) {
    window.clearInterval(externalMonitor.timer);
    externalMonitor = null;
  }
  if (!generating && !currentJob) progressActions.classList.remove("hidden");
}

async function restoreActiveJobDisplay(): Promise<void> {
  if (!isTauri() || generating || currentJob || externalMonitor) return;
  try {
    const api = await automationInfo();
    if (!api?.running) return;
    const jobs = await automationJobs(api.url);
    const active = jobs
      .filter((job) => job.status === "queued" || job.status === "running")
      .sort((a, b) => a.submittedAt - b.submittedAt)[0];
    if (active) monitorExternalJob(api.url, active);
  } catch {
    /* status polling is best-effort */
  }
}

function monitorExternalJob(apiUrl: string, initial: AutomationJob): void {
  stopExternalMonitoring();
  externalMonitor = { apiUrl, jobId: initial.id, timer: 0 };
  structuredProgressSeen = false;
  jobProgress = { stageLabel: "Checking queue", etaText: "", percent: null };
  progressTitle.textContent = initial.sourceName || "Queued model";
  progressChipTitle.textContent = progressTitle.textContent;
  progress.classList.remove("hidden");
  setJobCardCollapsed(
    readMigratedPreference(JOB_CARD_COLLAPSED_KEY, LEGACY_JOB_CARD_COLLAPSED_KEY) === "1",
    false,
  );
  renderJobProgress();
  const startedAt = initial.startedAt ?? initial.submittedAt;
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = window.setInterval(() => {
    const text = fmtElapsed(Date.now() - startedAt);
    progressElapsed.textContent = text;
    progressChipElapsed.textContent = text;
  }, 1000);

  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(`${apiUrl}/jobs/${encodeURIComponent(initial.id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const job = (await res.json()) as AutomationJob;
      if (!externalMonitor || externalMonitor.jobId !== initial.id) return;
      if (job.status !== "queued" && job.status !== "running") {
        stopExternalMonitoring();
        progress.classList.add("hidden");
        if (elapsedTimer) window.clearInterval(elapsedTimer);
        elapsedTimer = null;
        if (job.status === "succeeded") {
          automationJobsCache = null;
          void syncAutomationResults();
        }
        return;
      }
      jobProgress.percent = job.progress?.percent ?? null;
      jobProgress.stageLabel =
        job.status === "queued"
          ? "Waiting in queue"
          : job.progress?.stageLabel || "Generating model";
      jobProgress.etaText = "";
      renderJobProgress();
      const positionText =
        job.status === "queued"
          ? `${job.jobsAhead} ahead of you${job.queuePosition ? ` · position ${job.queuePosition}` : ""}`
          : "running";
      progressQueue.textContent = positionText.charAt(0).toUpperCase() + positionText.slice(1);
      syncChipTooltip();
    } catch {
      /* transient network errors: keep last known state */
    }
  };
  void poll();
  externalMonitor.timer = window.setInterval(() => void poll(), 800);
}

function startRun(job: GenerationJob): void {
  stopExternalMonitoring();
  generating = true;
  structuredProgressSeen = false;
  jobProgress = { stageLabel: "Preparing the job", etaText: "", percent: null };
  progressTitle.textContent = job.label;
  progressChipTitle.textContent = job.label;
  viewerReferencePopover.classList.add("hidden");
  viewerReferenceToggle.setAttribute("aria-expanded", "false");
  progress.classList.remove("hidden");
  progressActions.classList.remove("hidden");
  setJobCardCollapsed(
    readMigratedPreference(JOB_CARD_COLLAPSED_KEY, LEGACY_JOB_CARD_COLLAPSED_KEY) === "1",
    false,
  );
  renderJobProgress();
  updateQueueStatus();
  const started = Date.now();
  progressElapsed.textContent = "0:00";
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = window.setInterval(() => {
    const text = fmtElapsed(Date.now() - started);
    progressElapsed.textContent = text;
    progressChipElapsed.textContent = text;
  }, 1000);
  abort = new AbortController();
}

function finishRun(): void {
  generating = false;
  if (elapsedTimer) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (!generationQueue.length) progress.classList.add("hidden");
}

function queueJob(job: GenerationJob): void {
  const restriction = hardwareRestriction(job.params);
  if (restriction) throw new Error(restriction);
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
  resume?: ResumeManifest,
  candidateManifest?: ManifestContext,
): Promise<VersionRecord> {
  const normalizedParams = normalizeGenParams(params);
  const requestId = candidateManifest?.requestId ?? newRequestId();
  const recordId = resume?.versionId ?? candidateManifest?.jobId ?? newId();
  const base = safeStem(sourceName);
  const startedAtMs = Date.now();

  // Manifest lifecycle (desktop only, warn-only): interrupted on submit so a
  // crash leaves a resumable record; completed/failed/cancelled below. A
  // resumed job updates its original manifest in place; a sweep candidate
  // reuses its pre-persisted context (shared source image, queued state).
  const manifestContext =
    resume || candidateManifest
      ? null
      : await startGenerationManifest({
          base,
          jobId: recordId,
          requestId,
          label: sourceName.replace(/\.[^.]+$/, "") || "Model",
          params: normalizedParams,
          sourceBlob: sourceImage,
        });
  const activeContext = manifestContext ?? candidateManifest;
  const hasManifest = requiresTerminalFinalization({
    manifestContext,
    resume,
    candidateManifest,
  });
  interface TerminalPatch {
    status: "completed" | "failed" | "cancelled";
    error?: string;
    metrics?: ManifestMetrics | null;
    qualityWarning?: ManifestQualityWarning | null;
    durationSeconds?: number;
    modelName?: string;
  }
  const finishManifest = async (patch: TerminalPatch): Promise<void> => {
    if (resume) {
      await finishResumedManifest(resume.path, {
        ...patch,
        newJobId: recordId,
        newRequestId: requestId,
      });
    } else if (activeContext) {
      await finishGenerationManifest(activeContext, patch);
    }
  };

  const stopPolling = startProgressPolling(requestId, signal);
  let glb: Blob;
  try {
    ({ glb } = await generate(sourceImage, normalizedParams, signal, requestId));
  } catch (error) {
    stopPolling();
    // Cancellation is a distinct terminal state, never a failure. A manifest
    // finalization problem here must not mask the generation outcome.
    const cancelled = signal.aborted;
    try {
      await finishManifest({
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Generation cancelled" : (error as Error).message || "generation failed",
      });
    } catch (manifestError) {
      noteManifestWriteFailure(
        manifestError,
        cancelled ? "generation-cancelled" : "generation-failed",
      );
    }
    throw error;
  }
  stopPolling();
  const durationSeconds = (Date.now() - startedAtMs) / 1000;
  const inspection = await inspectGeneratedGlb(glb).catch(() => ({ dimensions: null, warning: null }));

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

  const modelName = `${base}_${normalizedParams.resolution}_seed${normalizedParams.seed}_${rec.id}.glb`;
  // Persist the GLB first so a completed manifest can never point at a file
  // that does not exist (the Rust writer computes its SHA-256 on write).
  let savedPath: string | null = null;
  let autosaveError: string | null = null;
  if (isTauri()) {
    try {
      const bytes = new Uint8Array(await glb.arrayBuffer());
      savedPath = await saveToOutputDir(modelName, bytes);
      if (!savedPath) autosaveError = "the model could not be written to the output folder";
    } catch (e) {
      autosaveError = (e as Error).message || "autosave failed";
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
  revealAssetDock();
  await refreshGallery();

  // Awaited terminal write so later recovery scans cannot observe stale state.
  // A model that never reached disk must not be recorded as completed.
  if (hasManifest) {
    try {
      await finishManifest(
        hasDurableGeneratedArtifact(isTauri(), savedPath)
          ? {
              status: "completed",
              durationSeconds,
              metrics: rec.metrics ? metricsFromModelMetrics(rec.metrics) : null,
              qualityWarning: rec.qualityWarning ?? null,
              modelName,
            }
          : {
              status: "failed",
              error: `Generated model kept in the app gallery only; ${autosaveError ?? "output-folder save was unavailable"}`,
            },
      );
    } catch (manifestError) {
      noteManifestWriteFailure(manifestError, "asset-persisted");
    }
  }

  if (announce) {
    // Completion message built from the actual outcome: warning presence,
    // autosave success, and autosave failure never contradict each other.
    const parts: string[] = [];
    let severity: "" | "ok" | "err" = "ok";
    if (rec.qualityWarning) {
      parts.push(`${rec.qualityWarning.message}.`, REFERENCE_GUIDANCE);
      severity = "err";
    }
    if (savedPath) {
      parts.push(`Saved to ${savedPath}.`);
    } else if (autosaveError) {
      parts.push(`Output-folder saving failed (${autosaveError}); the model remains in the app gallery.`);
      severity = "err";
    } else if (!rec.qualityWarning) {
      parts.push("Generation complete");
    }
    toast(parts.join(" "), severity);
  }

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
    clearStandaloneView();
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
  const warningSummary = summarizeWarnings(
    slots.map((slot) => slot.record?.qualityWarning?.message ?? "").filter(Boolean),
  );
  toast(
    warningSummary
      ? `Seed sweep complete: ${ready}/${slots.length} candidates; ${warningSummary}. ${REFERENCE_GUIDANCE}`
      : `Seed sweep complete: ${ready}/${slots.length} candidates`,
    ready && !warningSummary ? "ok" : "err",
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
  lastManifestWriteFailed = false;
  if (job.candidate) {
    job.candidate.status = "generating";
    renderCandidates();
  }
  // Persist the queued -> running transition BEFORE native generation begins
  // so a crash during generation cannot leave the candidate marked queued.
  if (job.candidate?.manifest) {
    await setCandidateManifestState(job.candidate.manifest, "running");
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
      job.resumeManifest,
      job.candidate?.manifest,
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
    if (!cancelled) revealJobCardTemporarily();
  } finally {
    finishRun();
    currentJob = null;
    abort = null;
    renderCandidates();
    if (job.sweep) announceSweepWhenComplete(job.sweep.id);
    updateQueueStatus();
    // A resumed job just resolved its manifest out of the interrupted list —
    // but only refresh when the terminal write genuinely succeeded.
    if (!lastManifestWriteFailed) void checkInterruptedManifests();
    void runGenerationQueue();
  }
}

function doGenerate(): void {
  if (!inputImage) return;
  if (!generationBackendReady()) return;
  let params: GenParams;
  try {
    params = readParams();
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  const noModelYet = !activeId && !currentGlb && !currentJob && generationQueue.length === 0;
  try {
    queueJob({
      image: inputImage,
      name: inputName,
      params,
      label: `${inputName.replace(/\.[^.]+$/, "") || "Model"} · seed ${params.seed}`,
      autoOpen: noModelYet,
    });
  } catch (error) {
    toast((error as Error).message, "err");
  }
}

generateBtn.addEventListener("click", doGenerate);
cancelBtn.addEventListener("click", () => abort?.abort());
clearQueueBtn.addEventListener("click", () => {
  if (!generationQueue.length) return;
  const removed = generationQueue.splice(0);
  const affectedSweeps = new Set<string>();
  for (const job of removed) {
    if (job.candidate?.status === "queued") job.candidate.status = "cancelled";
    // Persist the cancelled state so recovery never requeues it.
    if (job.candidate?.manifest) void cancelCandidateManifest(job.candidate.manifest);
    if (job.sweep) affectedSweeps.add(job.sweep.id);
  }
  renderCandidates();
  affectedSweeps.forEach(announceSweepWhenComplete);
  updateQueueStatus();
  toast(`${removed.length} queued job${removed.length === 1 ? "" : "s"} removed`);
});

async function doSweep(): Promise<void> {
  if (!inputImage) return;
  if (!generationBackendReady()) return;
  let baseParams: NormalizedGenParams;
  try {
    baseParams = normalizeGenParams(readParams());
    clearParamErrors();
  } catch (error) {
    showParamError(error);
    return;
  }
  const count = Math.max(
    SWEEP_MIN_CANDIDATES,
    Math.min(SWEEP_MAX_CANDIDATES, parseInt($<HTMLSelectElement>("ctl-sweep-count").value, 10) || 4),
  );
  // Every seed is validated BEFORE anything durable or visible is created:
  // seed 0 stays 0, and a sweep that would run past the maximum seed is
  // refused instead of partially enqueuing.
  let sweepSeeds: number[];
  try {
    sweepSeeds = createSweepSeeds(baseParams.seed, count);
  } catch (error) {
    toast((error as Error).message, "err");
    return;
  }
  // Sweeps always render at 512; a forced 1024 px texture decode would
  // mismatch the geometry, so it collapses to auto here — before manifests
  // are written, so records describe what will actually run.
  const sweepParams = normalizeGenParams({
    ...baseParams,
    resolution: 512,
    textureResolution: baseParams.textureResolution === 1024 ? "auto" : baseParams.textureResolution,
  });
  const restriction = hardwareRestriction(sweepParams);
  if (restriction) {
    toast(restriction, "err");
    return;
  }
  const sweepGroupId = newId();

  // Persist every candidate manifest (plus one shared source image) BEFORE
  // the first generation runs. If persistence fails, refuse to queue a
  // half-recorded sweep.
  let preparedContexts: Array<ManifestContext | null> | null = null;
  if (isTauri()) {
    try {
      const { seed: _seed, ...manifestParams } = sweepParams;
      preparedContexts = await prepareSweepManifests({
        base: safeStem(inputName),
        groupId: sweepGroupId,
        labelBase: inputName.replace(/\.[^.]+$/, "") || "Model",
        params: manifestParams,
        seeds: sweepSeeds,
        sourceBlob: inputImage,
      });
      if (preparedContexts.some((context) => context === null)) {
        throw new Error("one or more candidate records could not be written");
      }
    } catch (error) {
      toast(
        `Sweep was not started: candidate records could not be persisted (${(error as Error).message})`,
        "err",
      );
      return;
    }
  }

  candidates = sweepSeeds.map((seed, index) => ({
    seed,
    status: "queued" as CandidateStatus,
    manifest: preparedContexts?.[index] ?? undefined,
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
        ...sweepParams,
        seed: slot.seed,
      },
      label: `Candidate ${index + 1}/${count} · seed ${slot.seed}`,
      autoOpen: canOpenFirst && index === 0,
      sweep: { id: sweepGroupId, index, count },
      candidate: slot,
    });
  });
}

sweepBtn.addEventListener("click", () => {
  void doSweep();
});

// ---- viewer tools ----
function setViewerTools(on: boolean): void {
  if (!on) renderSelection(null);
  syncViewerReference();
}
viewerReferenceToggle.addEventListener("click", () => {
  const expanded = viewerReferencePopover.classList.contains("hidden");
  viewerReferencePopover.classList.toggle("hidden", !expanded);
  viewerReferenceToggle.setAttribute("aria-expanded", String(expanded));
});

// ---- gallery ----
const ASSETS_COLLAPSED_KEY = "triastasis.assets-level.collapsed";
const LEGACY_ASSETS_COLLAPSED_KEY = "polyloom.assets-level.collapsed";
const VERSIONS_COLLAPSED_KEY = "triastasis.versions-level.collapsed";
const LEGACY_VERSIONS_COLLAPSED_KEY = "polyloom.versions-level.collapsed";
let userCollapsedAssetsThisSession = false;
let userCollapsedVersionsThisSession = false;

function applyLevelCollapsed(level: HTMLElement, toggle: HTMLButtonElement, collapsed: boolean): void {
  level.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const contentId = toggle.getAttribute("aria-controls");
  const content = contentId ? document.getElementById(contentId) : null;
  if (content) content.hidden = collapsed;
}

function initDockPreference(): void {
  applyLevelCollapsed(
    assetLevel,
    dockToggle,
    readMigratedPreference(ASSETS_COLLAPSED_KEY, LEGACY_ASSETS_COLLAPSED_KEY) === "1",
  );
  applyLevelCollapsed(
    versionLevel,
    versionDockToggle,
    readMigratedPreference(VERSIONS_COLLAPSED_KEY, LEGACY_VERSIONS_COLLAPSED_KEY) === "1",
  );
}

function revealAssetDock(): void {
  if (!userCollapsedAssetsThisSession) applyLevelCollapsed(assetLevel, dockToggle, false);
  if (!userCollapsedVersionsThisSession) applyLevelCollapsed(versionLevel, versionDockToggle, false);
}

dockToggle.addEventListener("click", () => {
  const collapsed = !assetLevel.classList.contains("is-collapsed");
  applyLevelCollapsed(assetLevel, dockToggle, collapsed);
  localStorage.setItem(ASSETS_COLLAPSED_KEY, collapsed ? "1" : "0");
  if (collapsed) userCollapsedAssetsThisSession = true;
});

versionDockToggle.addEventListener("click", () => {
  const collapsed = !versionLevel.classList.contains("is-collapsed");
  applyLevelCollapsed(versionLevel, versionDockToggle, collapsed);
  localStorage.setItem(VERSIONS_COLLAPSED_KEY, collapsed ? "1" : "0");
  if (collapsed) userCollapsedVersionsThisSession = true;
});

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
  clearStandaloneView();
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
    toast(`${measuredWarning.message}. ${REFERENCE_GUIDANCE}`, "err");
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
  const hasPendingOrFailedCandidate = candidates.some((slot) => slot.status !== "ready");
  candidateWrap.classList.toggle("hidden", candidates.length === 0 || !hasPendingOrFailedCandidate);
  if (!candidates.length || !hasPendingOrFailedCandidate) return;

  const complete = candidates.filter((slot) => slot.status === "ready" || slot.status === "failed").length;
  candidateSummary.textContent = `${complete}/${candidates.length} complete. Click a result to select its seed.`;

  for (const slot of candidates) {
    const item = createButton({
      label: `Seed ${slot.seed}`,
      labelMode: "aria-only",
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
      ? slot.record?.qualityWarning?.message ?? "Quality issue"
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

let selectedAssetId: string | null = null;

interface AssetGroup {
  assetId: string;
  records: VersionRecord[];
}

let currentAssetGroups: AssetGroup[] = [];
let dockFavoritesOnly = false;

function assetDisplayName(records: VersionRecord[]): string {
  for (const record of records) {
    const label = record.operationParams.assetLabel;
    if (typeof label === "string" && label.trim()) return label.trim();
  }
  const representative = records[0];
  return representative?.name.replace(/\.[^.]+$/, "") || representative?.label || "Untitled asset";
}

function assetIsFavorite(records: VersionRecord[]): boolean {
  return records.length > 0 && records.every((record) => record.favorite);
}

function renderLibraryAsset(asset: AssetGroup): HTMLElement {
  const records = asset.records;
  const representative = records.find((record) => record.id === activeId) ?? records[0];
  const assetName = assetDisplayName(records);
  const item = document.createElement("article");
  item.className = `asset-item library-asset-item${asset.assetId === selectedAssetId ? " active" : ""}`;
  item.tabIndex = 0;
  item.setAttribute("role", "button");

  const itemHead = document.createElement("div");
  itemHead.className = "asset-item-head";
  const name = document.createElement("strong");
  name.textContent = assetName;
  const actions = document.createElement("div");
  actions.className = "asset-actions";

  const exportBtn = createButton({
    label: `Export ${assetName} as GLB`,
    variant: "icon",
    size: "sm",
    icon: "download-simple",
    className: "g-action export-action",
  });
  exportBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const bytes = new Uint8Array(await representative.glb.arrayBuffer());
      const ok = await saveBytes(`${safeStem(assetName)}.glb`, bytes);
      if (ok) toast("GLB exported", "ok");
    } catch (error) {
      toast((error as Error).message || "GLB export failed", "err");
    }
  });
  actions.appendChild(exportBtn);

  const favorite = assetIsFavorite(records);
  const favoriteBtn = createButton({
    label: favorite ? "Remove asset from favourites" : "Add asset to favourites",
    variant: "icon",
    size: "sm",
    icon: "star",
    className: `g-action favorite-action${favorite ? " active" : ""}`,
  });
  favoriteBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      for (const record of records) await setVersionFavorite(record.versionId, !favorite);
      await refreshGallery();
    } catch (error) {
      toast((error as Error).message || "Could not update favourite", "err");
    }
  });
  actions.appendChild(favoriteBtn);

  const renameBtn = createButton({
    label: "Rename asset",
    variant: "icon",
    size: "sm",
    icon: "pencil-simple",
    className: "g-action rename-action",
  });
  renameBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const nextLabel = await requestRename("asset", assetName);
    if (nextLabel === null) return;
    try {
      for (const record of records) {
        await put({
          ...record,
          operationParams: { ...record.operationParams, assetLabel: nextLabel },
        });
      }
      await refreshGallery();
    } catch (error) {
      toast((error as Error).message || "Could not rename asset", "err");
    }
  });
  actions.appendChild(renameBtn);

  const removeBtn = createButton({
    label: "Remove asset",
    variant: "icon",
    size: "sm",
    icon: "trash",
    className: "g-action remove-action danger",
  });
  removeBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (generating) {
      toast("Wait for generation to finish before removing assets", "err");
      return;
    }
    if (!confirm(`Remove this asset and its ${records.length} version${records.length === 1 ? "" : "s"}?`)) return;
    try {
      const recordsBeforeDelete = await all();
      const targetIds = new Set(records.flatMap((record) => [record.id, record.versionId]));
      const externalDependent = recordsBeforeDelete.find(
        (record) => !targetIds.has(record.id) && record.parentVersionId && targetIds.has(record.parentVersionId),
      );
      if (externalDependent) {
        toast("Remove dependent versions before removing this asset", "err");
        return;
      }
      for (const record of records) await removeRecord(record.id);
      if (records.some((record) => record.id === activeId)) {
        clearCurrentModelState();
        viewer?.clear();
        if (viewer) renderMeshParts(viewer);
      }
      selectedAssetId = null;
      await refreshGallery();
    } catch (error) {
      toast((error as Error).message || "Could not remove asset", "err");
    }
  });
  actions.appendChild(removeBtn);
  itemHead.append(name, actions);
  item.appendChild(itemHead);

  const img = document.createElement("img");
  const url = URL.createObjectURL(representative.thumb ?? representative.input);
  libraryUrls.push(url);
  img.src = url;
  img.alt = `${representative.name} asset preview`;
  const text = document.createElement("div");
  text.className = "asset-item-meta";
  const count = document.createElement("span");
  count.textContent = `${records.length} version${records.length === 1 ? "" : "s"}`;
  const latest = document.createElement("span");
  latest.textContent = `Latest: ${representative.label}`;
  text.append(count, latest);
  item.append(img, text);

  const openAsset = async (): Promise<void> => {
    selectedAssetId = asset.assetId;
    await loadRecordData(representative);
  };
  item.addEventListener("click", () => void openAsset());
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openAsset();
    }
  });
  return item;
}

function renderLibraryView(): void {
  libraryUrls.forEach((url) => URL.revokeObjectURL(url));
  libraryUrls = [];
  libraryGrid.innerHTML = "";
  const filtered = filterLibraryEntries(
    currentAssetGroups.map((asset) => ({
      ...asset,
      name: assetDisplayName(asset.records),
      searchText: [
        assetDisplayName(asset.records),
        ...asset.records.flatMap((record) => [record.label, record.name, record.operation]),
      ].join(" "),
      favorite: assetIsFavorite(asset.records),
      versionCount: asset.records.length,
      createdAt: asset.records[0]?.createdAt ?? 0,
    })),
    {
      query: librarySearch.value,
      filter: libraryFilter.value as LibraryFilter,
      sort: librarySort.value as LibrarySort,
    },
  );

  const totalVersions = currentAssetGroups.reduce((sum, asset) => sum + asset.records.length, 0);
  libraryModeSummary.textContent = `${currentAssetGroups.length} asset${currentAssetGroups.length === 1 ? "" : "s"}, ${totalVersions} version${totalVersions === 1 ? "" : "s"}`;
  libraryResultsSummary.textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "library-grid-empty";
    empty.textContent = currentAssetGroups.length
      ? "No assets match the current search and filters."
      : "No assets yet. Generate a model to start your library.";
    libraryGrid.appendChild(empty);
    return;
  }
  for (const asset of filtered) libraryGrid.appendChild(renderLibraryAsset(asset));
}

librarySearch.addEventListener("input", renderLibraryView);
libraryFilter.addEventListener("change", renderLibraryView);
librarySort.addEventListener("change", renderLibraryView);
dockFavoritesToggle.addEventListener("click", () => {
  dockFavoritesOnly = !dockFavoritesOnly;
  dockFavoritesToggle.setAttribute("aria-pressed", String(dockFavoritesOnly));
  void refreshGallery();
});

async function refreshGallery(): Promise<void> {
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls = [];
  const recs = await all();
  const recoveryCount = galleryRecoveryCount();
  galleryRecoveryBanner.classList.toggle("hidden", recoveryCount === 0);
  if (recoveryCount > 0) {
    galleryRecoveryBanner.querySelector("span")!.textContent =
      `${recoveryCount} saved ${recoveryCount === 1 ? "record could" : "records could"} not be loaded. The files remain on disk and can be reimported.`;
  }
  galleryEl.innerHTML = "";
  versionGalleryEl.innerHTML = "";
  if (!recs.length) {
    currentAssetGroups = [];
    renderLibraryView();
    gallerySummary.textContent = "";
    assetLevelCount.textContent = "";
    versionLevelCount.textContent = "";
    versionLevel.classList.add("hidden");
    dockFavoritesToggle.disabled = true;
    clearGalleryBtn.disabled = true;
    selectedAssetId = null;
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = galleryLoadFailed()
      ? "Saved assets could not be loaded. Your files remain on disk. Restart Triastasis and try again."
      : "No assets yet. Generate a model to start a version history.";
    galleryEl.appendChild(empty);
    return;
  }
  dockFavoritesToggle.disabled = false;
  clearGalleryBtn.disabled = generating;
  const assetIds = [...new Set(recs.map((record) => record.assetId))];
  const assetGroups: AssetGroup[] = await Promise.all(assetIds.map(async (assetId) => ({
    assetId,
    records: (await listAssetVersions(assetId)).sort((a, b) => b.createdAt - a.createdAt),
  })));
  currentAssetGroups = assetGroups;
  const dockAssetGroups = dockFavoritesOnly
    ? assetGroups.filter((asset) => assetIsFavorite(asset.records))
    : assetGroups;
  gallerySummary.textContent = `${assetGroups.length} assets, ${recs.length} versions`;
  assetLevelCount.textContent = dockFavoritesOnly
    ? `${dockAssetGroups.length} of ${assetGroups.length}`
    : String(assetGroups.length);

  const activeAsset = activeId
    ? assetGroups.find((asset) => asset.records.some((record) => record.id === activeId))
    : undefined;
  if (activeAsset) selectedAssetId = activeAsset.assetId;
  if (!selectedAssetId || !dockAssetGroups.some((asset) => asset.assetId === selectedAssetId)) {
    selectedAssetId = dockAssetGroups[0]?.assetId ?? null;
  }
  renderLibraryView();

  for (const asset of dockAssetGroups) {
    const records = asset.records;
    if (!records.length) continue;
    const representative = records.find((record) => record.id === activeId) ?? records[0];
    const item = document.createElement("article");
    item.className = `asset-item${asset.assetId === selectedAssetId ? " active" : ""}`;
    item.tabIndex = 0;
    item.setAttribute("role", "button");

    const itemHead = document.createElement("div");
    itemHead.className = "asset-item-head";
    const name = document.createElement("strong");
    const assetName = assetDisplayName(records);
    name.textContent = assetName;
    const actions = document.createElement("div");
    actions.className = "asset-actions";
    const exportBtn = createButton({
      label: `Export ${assetName} as GLB`,
      variant: "icon",
      size: "sm",
      icon: "download-simple",
      className: "g-action export-action",
    });
    exportBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const bytes = new Uint8Array(await representative.glb.arrayBuffer());
        const ok = await saveBytes(`${safeStem(assetName)}.glb`, bytes);
        if (ok) toast("GLB exported", "ok");
      } catch (error) {
        toast((error as Error).message || "GLB export failed", "err");
      }
    });
    actions.appendChild(exportBtn);

    const assetIsFavorite = records.every((record) => record.favorite);
    const favoriteBtn = createButton({
      label: assetIsFavorite ? "Remove asset from favorites" : "Add asset to favorites",
      variant: "icon",
      size: "sm",
      icon: "star",
      className: `g-action favorite-action${assetIsFavorite ? " active" : ""}`,
    });
    favoriteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        for (const record of records) await setVersionFavorite(record.versionId, !assetIsFavorite);
        await refreshGallery();
      } catch (error) {
        toast((error as Error).message || "Could not update favorite", "err");
      }
    });
    actions.appendChild(favoriteBtn);

    const renameBtn = createButton({
      label: "Rename asset",
      variant: "icon",
      size: "sm",
      icon: "pencil-simple",
      className: "g-action rename-action",
    });
    renameBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const nextLabel = await requestRename("asset", assetName);
      if (nextLabel === null) return;
      try {
        for (const record of records) {
          await put({
            ...record,
            operationParams: { ...record.operationParams, assetLabel: nextLabel },
          });
        }
        await refreshGallery();
      } catch (error) {
        toast((error as Error).message || "Could not rename asset", "err");
      }
    });
    actions.appendChild(renameBtn);

    const removeBtn = createButton({
      label: "Remove asset",
      variant: "icon",
      size: "sm",
      icon: "trash",
      className: "g-action remove-action danger",
    });
    removeBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (generating) {
        toast("Wait for generation to finish before removing assets", "err");
        return;
      }
      if (!confirm(`Remove this asset and its ${records.length} version${records.length === 1 ? "" : "s"}?`)) return;
      try {
        const recordsBeforeDelete = await all();
        const targetIds = new Set(records.flatMap((record) => [record.id, record.versionId]));
        const externalDependent = recordsBeforeDelete.find(
          (record) => !targetIds.has(record.id) && record.parentVersionId && targetIds.has(record.parentVersionId),
        );
        if (externalDependent) {
          toast("Remove dependent versions before removing this asset", "err");
          return;
        }
        for (const record of records) await removeRecord(record.id);
        if (records.some((record) => record.id === activeId)) {
          clearCurrentModelState();
          viewer?.clear();
          if (viewer) renderMeshParts(viewer);
        }
        selectedAssetId = null;
        await refreshGallery();
      } catch (error) {
        toast((error as Error).message || "Could not remove asset", "err");
      }
    });
    actions.appendChild(removeBtn);
    itemHead.append(name, actions);
    item.appendChild(itemHead);

    const img = document.createElement("img");
    const url = URL.createObjectURL(representative.thumb ?? representative.input);
    galleryUrls.push(url);
    img.src = url;
    img.alt = `${representative.name} asset preview`;
    const text = document.createElement("div");
    text.className = "asset-item-meta";
    const count = document.createElement("span");
    count.textContent = `${records.length} version${records.length === 1 ? "" : "s"}`;
    const latest = document.createElement("span");
    latest.textContent = `Latest: ${representative.label}`;
    text.append(count, latest);
    item.append(img, text);
    const openAsset = async (): Promise<void> => {
      selectedAssetId = asset.assetId;
      await loadRecordData(representative);
    };
    item.addEventListener("click", () => void openAsset());
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openAsset();
      }
    });
    galleryEl.appendChild(item);
  }

  if (!dockAssetGroups.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "No favourite assets yet.";
    galleryEl.appendChild(empty);
  }

  const selectedAsset = dockAssetGroups.find((asset) => asset.assetId === selectedAssetId);
  const records = selectedAsset?.records ?? [];
  versionLevel.classList.toggle("hidden", records.length <= 1);
  versionLevelCount.textContent = String(records.length);
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "Choose an asset to see its versions.";
    versionGalleryEl.appendChild(empty);
    return;
  }

  for (const record of records) {
      const sweepId = record.sweepGroupId;
      const versionRecords = [record];
      const representative = record;
      const isSweep = Boolean(sweepId);
      const warnings = versionRecords
        .map((candidate) => candidate.qualityWarning ?? detectPlaneCollapse(candidate.metrics?.dimensions))
        .filter((warning) => warning !== null && warning !== undefined);
      const item = document.createElement("article");
      item.className = `version-item${versionRecords.some((candidate) => candidate.id === activeId) ? " active" : ""}${warnings.length ? " quality-warning" : ""}`;
      item.tabIndex = 0;
      item.setAttribute("role", "button");

      const itemHead = document.createElement("div");
      itemHead.className = "version-item-head";
      const itemIdentity = document.createElement("div");
      itemIdentity.className = "version-item-identity";
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = representative.label || representative.name;
      itemIdentity.append(itemTitle);
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
      const warningSummary = summarizeWarnings(
        versionRecords.map((candidate) => candidate.qualityWarning?.message ?? "").filter(Boolean),
      ) ?? `${warnings.length} quality issue${warnings.length === 1 ? "" : "s"}`;
      versionDetails.textContent = warnings.length
        ? isSweep
          ? `Seed ${representative.params.seed} | ${warningSummary}`
          : `${representative.qualityWarning?.message ?? "Quality issue"} | use a three-quarter reference`
        : isSweep
        ? `Seed ${representative.params.seed} | ${actualFaces !== undefined ? compactNumber(actualFaces) + " triangles" : "metrics pending"}`
        : `${representative.operation} | ${actualFaces !== undefined ? compactNumber(actualFaces) + " triangles" : "metrics pending"}${comparison ? ` | ${comparison}` : ""}`;
      item.title = [
        representative.label || representative.name,
        versionDetails.textContent,
        new Date(representative.createdAt).toLocaleString(),
        ...(warnings.length ? [REFERENCE_GUIDANCE] : []),
      ].filter(Boolean).join(" | ");
      versionMeta.append(versionDetails);
      item.appendChild(versionMeta);

      const actions = document.createElement("div");
      actions.className = "version-actions";
      const exportBtn = createButton({
        label: `Export ${representative.label || representative.name} as GLB`,
        variant: "icon",
        size: "sm",
        icon: "download-simple",
        className: "g-action export-action",
      });
      exportBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          const bytes = new Uint8Array(await representative.glb.arrayBuffer());
          const base = safeStem(representative.label || representative.name);
          const ok = await saveBytes(`${base}.glb`, bytes);
          if (ok) toast("GLB exported", "ok");
        } catch (error) {
          toast((error as Error).message || "GLB export failed", "err");
        }
      });
      actions.appendChild(exportBtn);

      const renameBtn = createButton({
        label: "Rename version",
        variant: "icon",
        size: "sm",
        icon: "pencil-simple",
        className: "g-action rename-action",
      });
      renameBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const nextLabel = await requestRename("version", representative.label);
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
      itemHead.appendChild(actions);

      const openVersion = async (): Promise<void> => {
        await loadRecordData(representative);
      };
      item.addEventListener("click", () => void openVersion());
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openVersion();
        }
      });
      versionGalleryEl.appendChild(item);
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
      const automationWarningMessages: string[] = [];

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
          if (record.qualityWarning) automationWarningMessages.push(record.qualityWarning.message);
          existingIds.add(recordId);
          imported += 1;
        } catch (error) {
          console.warn(`Could not import automation job ${job.id}`, error);
        }
      }
      if (imported > 0) {
        await refreshGallery();
        revealAssetDock();
        const warningSummary = summarizeWarnings(automationWarningMessages);
        toast(
          warningSummary
            ? `${imported} automation model${imported === 1 ? "" : "s"} added to Assets; ${warningSummary}. ${REFERENCE_GUIDANCE}`
            : `${imported} automation model${imported === 1 ? "" : "s"} added to Assets`,
          warningSummary ? "err" : "ok",
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

let automationImportSync: Promise<number> | null = null;

function failedAutomationImport(
  request: AutomationImportRequest,
  error: unknown,
): AutomationImportCompletion {
  const message = (error as Error).message || String(error);
  return {
    imported: 0,
    skipped: 0,
    failures: request.manifestPaths.map((path) => ({ path, error: message })),
  };
}

function syncAutomationImportRequests(apiUrl?: string): Promise<number> {
  if (!isTauri()) return Promise.resolve(0);
  if (automationImportSync) return automationImportSync;
  automationImportSync = (async () => {
    const resolvedApi =
      apiUrl ?? (await automationInfo().then((info) => info?.running ? info.url : ""));
    if (!resolvedApi) return 0;
    const requests = await automationImportRequests(resolvedApi);
    let completed = 0;
    for (const pending of requests.filter((request) => request.status !== "completed")) {
      let request: AutomationImportRequest;
      try {
        request = await claimAutomationImport(resolvedApi, pending.id);
      } catch (error) {
        console.warn(`Could not claim automation import ${pending.id}`, error);
        continue;
      }
      let result: AutomationImportCompletion;
      try {
        result = await importManifestPaths(request.manifestPaths, request.warnings);
      } catch (error) {
        result = failedAutomationImport(request, error);
      }
      try {
        await completeAutomationImport(resolvedApi, request.id, result);
        reportManifestImport(result, request.warnings, "Automation: ");
        completed += 1;
      } catch (error) {
        console.warn(`Could not publish automation import result ${request.id}`, error);
      }
    }
    return completed;
  })()
    .catch((error) => {
      console.warn("Could not synchronize automation imports", error);
      return 0;
    })
    .finally(() => {
      automationImportSync = null;
    });
  return automationImportSync;
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

// ---- settings page ----
async function renderSettingsPage(): Promise<void> {
  settingsBody.setAttribute("aria-busy", "true");
  try {
    await renderSettings(settingsBody, () => {
      pollHealth();
      void refreshHardwareGuardrails();
      toast("Settings applied");
      void renderSettingsPage();
    });
  } catch (error) {
    const runtimeStatus = settingsBody.querySelector<HTMLElement>(".settings-runtime");
    settingsBody.querySelectorAll<HTMLSelectElement>("select").forEach(destroySelect);
    settingsBody.innerHTML = `<div class="settings-error">${escapeHtml((error as Error).message || "Could not load settings")}</div>`;
    if (runtimeStatus) {
      runtimeStatus.classList.add("hidden");
      settingsBody.append(runtimeStatus);
    }
  } finally {
    settingsBody.setAttribute("aria-busy", "false");
  }
}

async function openSettings(): Promise<void> {
  setWorkspaceMode("settings");
  await renderSettingsPage();
}
settingsModeBtn.addEventListener("click", openSettings);
$("banner-settings").addEventListener("click", () => {
  if (setupBanner.dataset.action === "onboarding") {
    void openModelSetup();
    return;
  }
  void openSettings();
});

// ---- server status ----
async function pollHealthInternal(): Promise<void> {
  const cfg = await loadConfig(true);
  serverConfigured = cfg.configured;
  backendBadge.textContent = cfg.backend !== "unknown" ? cfg.backend : "-";
  const ok = await health();
  serverOnline = ok;
  serverDot.className = "dot " + (ok ? "ok" : "err");
  serverLabel.textContent = ok ? "ready" : cfg.configured ? "offline" : "setup needed";
  const needSetup = !ok && !cfg.configured;
  setupBanner.classList.toggle("hidden", !needSetup);
  if (needSetup) {
    (setupBanner.querySelector("span") as HTMLElement).textContent =
      "No model bundle is ready. Complete onboarding before generating.";
    $("banner-settings").textContent = "Complete onboarding";
    setupBanner.dataset.action = "onboarding";
  } else if (!ok && cfg.configured) {
    setupBanner.classList.remove("hidden");
    (setupBanner.querySelector("span") as HTMLElement).textContent =
      "Server is offline. It may still be loading; check the models directory in settings.";
    $("banner-settings").textContent = "Open settings";
    setupBanner.dataset.action = "settings";
  }
  updateGenerateEnabled();
  if (isTauri()) {
    try {
      const api = await automationInfo();
      if (!api?.running) automationJobsCache = null;
      const jobs = api?.running ? await loadAutomationJobs(api.url) : [];
      if (api?.running) void syncAutomationImportRequests(api.url);
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
    serverConfigured = false;
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
  // Compatibility fallback only: used while the app owns an older server
  // binary that has no /progress endpoint (no structured snapshot yet).
  if (generating && !structuredProgressSeen) updateProgressFromServerLog(String(line));
});
listenSafely<string>("tray-action-blocked", (message) => {
  toast(String(message), "err");
});
listenSafely("studio-shown", () => {
  void syncAutomationResults();
  void syncAutomationImportRequests();
  void restoreActiveJobDisplay();
});
listenSafely<string>("automation-import-requested", () => {
  void syncAutomationImportRequests();
});
listenSafely("server-restarted", () => {
  automationJobsCache = null;
  void pollHealth();
});

window.addEventListener("focus", () => {
  void syncAutomationResults();
  void syncAutomationImportRequests();
  void restoreActiveJobDisplay();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void syncAutomationResults();
    void syncAutomationImportRequests();
    void restoreActiveJobDisplay();
  }
});

// ---- Triastasis manifest import / standalone GLB / recovery ----
const manifestModal = $("manifest-modal");
const manifestTitle = $("manifest-title");
const manifestBody = $("manifest-body");
const recoveryBanner = $("recovery-banner");
let previewUrlCleanup: (() => void) | null = null;
let standaloneView: { glbPath: string | null; linkedPath: string | null } | null = null;
let manifestOpener: HTMLElement | null = null;

function manifestFocusables(): HTMLElement[] {
  return Array.from(
    manifestModal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter(
    (element) =>
      !(element as HTMLButtonElement).disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.offsetParent !== null,
  );
}

// Focus trap + Escape; initial focus and restore-on-close live in
// openManifestPreview/closeManifestModal.
manifestModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeManifestModal();
    return;
  }
  if (event.key !== "Tab") return;
  const items = manifestFocusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || !manifestModal.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
});

// 1x1 transparent PNG placeholder for assets imported without a source image.
const PLACEHOLDER_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function placeholderImage(): Blob {
  const bytes = Uint8Array.from(atob(PLACEHOLDER_PNG_B64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

function closeManifestModal(): void {
  // Every user close path (Escape, backdrop, header, footer) is blocked while
  // an import/requeue is in flight. Success uses completeManifestSuccess().
  if (!canCloseModal(manifestBusy)) return;
  manifestModal.classList.add("hidden");
  cleanupManifestModal();
  const opener = manifestOpener;
  manifestOpener = null;
  if (opener && document.contains(opener)) opener.focus();
}

/** Success-only completion: un-busy first, then close and clean up. */
function completeManifestSuccess(): void {
  endManifestBusy();
  manifestModal.classList.add("hidden");
  cleanupManifestModal();
  const opener = manifestOpener;
  manifestOpener = null;
  if (opener && document.contains(opener)) opener.focus();
  else manifestBody.querySelector<HTMLButtonElement>("button")?.focus();
}

function cleanupManifestModal(): void {
  if (previewUrlCleanup) {
    previewUrlCleanup();
    previewUrlCleanup = null;
  }
}

$("manifest-close").addEventListener("click", closeManifestModal);
manifestModal.addEventListener("click", (e) => {
  if (e.target === manifestModal) closeManifestModal();
});

function renderManifestFacts(m: GenerationManifest): string {
  const facts: string[] = [
    `Status <b>${escapeHtml(m.status)}</b>`,
    `Resolution <b>${escapeHtml(m.resolution)}</b> · seed <b>${escapeHtml(m.seed)}</b>`,
    `Background <b>${escapeHtml(m.bgRemoval)}</b> · UV <b>${escapeHtml(m.uv)}</b> · texture <b>${m.texture ? "on" : "off"}</b>`,
  ];
  if (m.metrics?.dimensions) {
    const d = m.metrics.dimensions;
    facts.push(
      `Dimensions <b>${[d.x, d.y, d.z].map((v) => v.toFixed(2)).join(" x ")}</b>` +
        (m.metrics.triangles ? ` · ${compactNumber(m.metrics.triangles)} triangles` : ""),
    );
  }
  if (m.submittedAtUtc) {
    facts.push(`Submitted <b>${new Date(m.submittedAtUtc).toLocaleString()}</b>`);
  }
  if (m.durationSeconds) facts.push(`Duration <b>${fmtElapsed(m.durationSeconds * 1000)}</b>`);
  if (m.qualityWarning) {
    facts.push(
      `<b class="field-error">${escapeHtml(m.qualityWarning.message)}</b> · ${REFERENCE_GUIDANCE}`,
    );
  }
  if (m.error) facts.push(`Error: <b>${escapeHtml(m.error)}</b>`);
  return facts.map((fact) => `<div class="manifest-facts">${fact}</div>`).join("");
}

async function openManifestPreview(path: string): Promise<void> {
  let preview;
  try {
    preview = await readGenerationManifest(path);
  } catch (error) {
    toast((error as Error).message || "Could not read the generation manifest", "err");
    return;
  }
  const m = preview.manifest;
  manifestTitle.textContent = m.label || "Generation";

  const imageHtml = await (async () => {
    try {
      const bytes = await readManifestAsset(path, "sourceImage");
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      if (previewUrlCleanup) previewUrlCleanup();
      previewUrlCleanup = () => URL.revokeObjectURL(url);
      return `<img src="${url}" alt="Reference image" />`;
    } catch {
      return `<img alt="" />`;
    }
  })();

  const issuesHtml = preview.issues.length
    ? `<div class="manifest-issues">${preview.issues
        .filter((issue) => issue.role === "sourceImage" || issue.role === "glb")
        .map(
          (issue) =>
            `<div class="manifest-issue"><span>${escapeHtml(manifestIssueText(issue))}</span>` +
            `<button class="button button--secondary button--sm" data-relink="${issue.role}">Relink…</button></div>`,
        )
        .join("")}</div>`
    : "";

  const canImport = !hasBlockingCoreIssue(preview.issues);
  const actions: string[] = [];
  if (canImport && m.status === "completed") {
    actions.push(`<button id="manifest-import" class="button button--primary" type="button">Import into Assets</button>`);
  }
  if (canImport && m.status === "interrupted") {
    actions.push(
      `<button id="manifest-requeue" class="button button--primary" type="button">Requeue generation</button>`,
    );
  }
  manifestBody.innerHTML = `
    <div class="manifest-preview">
      ${imageHtml}
      <div>
        ${renderManifestFacts(m)}
        ${issuesHtml}
        <div class="modal-actions">
          <button id="manifest-cancel" class="button button--secondary" type="button">Close</button>
          ${actions.join("")}
        </div>
      </div>
    </div>`;
  manifestOpener = (document.activeElement as HTMLElement) ?? null;
  manifestModal.classList.remove("hidden");
  const initialFocus =
    manifestBody.querySelector<HTMLElement>("#manifest-import, #manifest-requeue") ??
    manifestFocusables()[0];
  initialFocus?.focus();

  manifestBody.querySelectorAll<HTMLButtonElement>("[data-relink]").forEach((button) => {
    button.addEventListener("click", async () => {
      const role = button.dataset.relink!;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({
          multiple: false,
          filters:
            role === "glb"
              ? [{ name: "GLB model", extensions: ["glb"] }]
              : [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
        });
        if (typeof picked !== "string") return;
        await relinkManifestFile(path, role, picked);
        toast(`Relinked ${role}`, "ok");
        void openManifestPreview(path);
      } catch (error) {
        toast((error as Error).message || "Could not relink file", "err");
      }
    });
  });
  manifestBody.querySelector("#manifest-cancel")?.addEventListener("click", closeManifestModal);
  manifestBody.querySelector("#manifest-import")?.addEventListener("click", async () => {
    if (!beginManifestBusy()) return;
    const importButton = manifestBody.querySelector<HTMLButtonElement>("#manifest-import");
    setActionBusy(importButton, "Importing model");
    const timings = startStageTiming();
    let persisted = false;
    try {
      const record = await importManifestFlow(path, timings, () => {
        persisted = true;
      });
      timings.report("import");
      completeManifestSuccess();
      toast(`Imported "${record.label}"`, "ok");
    } catch (error) {
      const classification = classifyImportFailure(persisted);
      if (classification === "post-persistence") {
        // The asset exists; only preview/refresh failed afterwards. Never
        // offer an import retry — that would duplicate the asset.
        timings.report("import");
        completeManifestSuccess();
        toast(
          "The asset was imported into Assets, but it could not be previewed in the viewer.",
          "err",
        );
      } else {
        // Pre-persistence failure: the modal stays fully retryable.
        toast((error as Error).message || "Import failed", "err");
        endManifestBusy();
        importButton?.focus();
      }
    }
  });
  manifestBody.querySelector("#manifest-requeue")?.addEventListener("click", async () => {
    if (!beginManifestBusy()) return;
    const button = manifestBody.querySelector<HTMLButtonElement>("#manifest-requeue");
    setActionBusy(button, "Queueing…");
    try {
      await requeueFromManifest(path, m);
      completeManifestSuccess();
    } catch (error) {
      toast((error as Error).message || "Could not requeue generation", "err");
      endManifestBusy();
      button?.focus();
    }
  });
}

// ---- modal busy state ----
let manifestBusy = false;

function beginManifestBusy(): boolean {
  // Refuse re-entrant imports while one is in flight (second layer after the
  // close-blocking below).
  if (manifestBusy) return false;
  manifestBusy = true;
  // Capture the exact state of every interactive control so failure restores
  // precisely what was there before — not "everything enabled".
  const elements = manifestFocusables().map((element) => element as HTMLButtonElement);
  const states = captureControls(elements);
  manifestModal.dataset.busyControls = JSON.stringify(states);
  (manifestModal as unknown as { busyControlEls?: HTMLButtonElement[] }).busyControlEls =
    elements;
  manifestModal.setAttribute("aria-busy", "true");
  // Everything is disabled while busy — including the action button hosting
  // the spinner (a disabled button still renders its content).
  for (const element of elements) element.disabled = true;
  return true;
}

function setActionBusy(button: HTMLButtonElement | null, label: string): void {
  if (!button) return;
  // Assign the generated busy content back onto the live element.
  const { html, minWidth } = busyContentFor(button.getBoundingClientRect().width);
  button.innerHTML = html;
  button.style.minWidth = minWidth;
  button.querySelector<HTMLElement>(".spinner-label")!.textContent = label;
}

function endManifestBusy(): void {
  const stored = manifestModal.dataset.busyControls;
  const elements = (manifestModal as unknown as { busyControlEls?: HTMLButtonElement[] })
    .busyControlEls ?? [];
  if (stored && elements.length) {
    try {
      restoreControls(elements, JSON.parse(stored) as BusyControlState[]);
    } catch {
      /* leave controls as-is on malformed snapshots */
    }
  }
  delete manifestModal.dataset.busyControls;
  delete (manifestModal as unknown as { busyControlEls?: HTMLButtonElement[] }).busyControlEls;
  manifestModal.removeAttribute("aria-busy");
  manifestBusy = false;
}

interface StageTiming {
  mark: (stage: string) => void;
  report: (label: string) => void;
}

function startStageTiming(): StageTiming {
  const started = performance.now();
  let lastBoundary = started;
  const durations: Record<string, number> = {};
  return {
    mark(stage: string) {
      const now = performance.now();
      durations[stage] = Math.round(now - lastBoundary);
      lastBoundary = now;
    },
    report(label: string) {
      const total = Math.round(performance.now() - started);
      console.info(`[${label}] stage timings (ms)`, { ...durations, total });
    },
  };
}

/** Narrows a manifest's warning to the known public codes; unknown codes from
 * newer producers are surfaced as generic text rather than mislabeled. */
function asGenerationWarning(
  warning: ManifestQualityWarning | null | undefined,
): GenerationQualityWarning | undefined {
  if (!warning) return undefined;
  if (warning.code !== "collapsed-plane" && warning.code !== "background-plane-attached") {
    return undefined;
  }
  return { ...warning, code: warning.code };
}

/** Applies a freshly loaded record to the viewer and workspace state. */
function activateLoadedRecord(
  instance: Viewer,
  stats: ViewerStats,
  rec: VersionRecord,
): void {
  currentGlb = rec.glb;
  activeId = rec.id;
  activeParams = normalizeGenParams(rec.params);
  activeLabel = rec.label;
  inputImage = rec.input;
  inputName = rec.name;
  setInputPreviewBlob(rec.input);
  inputPreview.classList.remove("hidden");
  dropHint.classList.add("hidden");
  showInputPreview("source");
  clearMaskPreview();
  applyParams(rec.params);
  renderViewerStats(stats, activeParams);
  renderMeshParts(instance);
  setViewerTools(true);
  updateViewerCaption();
  setWorkspaceMode("view");
  clearStandaloneView();
}

/**
 * Staged manifest import:
 *   read+validate → build record → render GLB → persist → refresh gallery.
 *
 * Rendering happens BEFORE persistence, so a GLB that cannot open never
 * creates an asset and the action stays safely retryable. `onPersisted`
 * fires the moment the gallery record exists — afterwards the import can no
 * longer fail "cleanly", and the caller treats later errors as preview
 * problems rather than offering an import retry.
 */
async function importManifestFlow(
  path: string,
  timings: StageTiming,
  onPersisted: () => void,
  refreshAfterImport = true,
  preloaded?: ImportedGeneration,
): Promise<VersionRecord> {
  const imported = preloaded ?? (await importGenerationManifest(path));
  timings.mark("invoke-import");
  const m = imported.manifest;
  if (m.status !== "completed") {
    throw new Error(`Cannot import a generation with status "${m.status}"`);
  }
  const label = m.label || "Imported model";
  const assetId = newId();
  const versionId = newId();
  const params = normalizeGenParams(manifestRecordedParams(m));
  const rec: VersionRecord = {
    id: versionId,
    ts: Date.now(),
    name: `${label}.png`,
    params,
    input: new Blob([new Uint8Array(imported.imageBytes)], { type: "image/png" }),
    glb: new Blob([new Uint8Array(imported.glbBytes)], { type: "model/gltf-binary" }),
    thumb: null,
    assetId,
    versionId,
    parentVersionId: undefined,
    operation: "imported",
    operationParams: {
      manifestPath: path,
      originalIds: {
        jobId: m.jobId ?? null,
        nativeRequestId: m.nativeRequestId ?? null,
        assetId: m.assetId ?? null,
        versionId: m.versionId ?? null,
        parentVersionId: m.parentVersionId ?? null,
      },
    },
    createdAt: Date.now(),
    label,
    favorite: false,
    metrics: m.metrics
      ? {
          fileSize: m.metrics.fileSizeBytes ?? undefined,
          triangles: m.metrics.triangles ?? undefined,
          dimensions: m.metrics.dimensions ?? undefined,
        }
      : null,
    qualityWarning: asGenerationWarning(m.qualityWarning),
  };
  timings.mark("to-blob");

  const instance = await getViewer();
  disposeEditorSession();
  const stats = await instance.load(rec.glb);
  timings.mark("viewer-render");
  activateLoadedRecord(instance, stats, rec);

  await put(rec);
  onPersisted();
  timings.mark("persist-record");
  if (refreshAfterImport) {
    revealAssetDock();
    await refreshGallery();
    timings.mark("refresh-gallery");
  }
  return rec;
}

function normalizedManifestPath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function importedJobId(record: VersionRecord): string | null {
  const automationJobId = record.operationParams.automationJobId;
  if (typeof automationJobId === "string" && automationJobId) return automationJobId;
  const originalIds = record.operationParams.originalIds;
  if (!originalIds || typeof originalIds !== "object") return null;
  const jobId = (originalIds as Record<string, unknown>).jobId;
  return typeof jobId === "string" && jobId ? jobId : null;
}

async function importManifestPaths(
  paths: string[],
  warnings: string[],
): Promise<AutomationImportCompletion> {
  const existing = await all();
  const importedPaths = new Set(
    existing
      .map((record) => record.operationParams.manifestPath)
      .filter((path): path is string => typeof path === "string")
      .map(normalizedManifestPath),
  );
  const importedJobIds = new Set(
    existing.map(importedJobId).filter((jobId): jobId is string => Boolean(jobId)),
  );
  const failures: Array<{ path: string; error: string }> = [];
  let importedCount = 0;
  let skippedCount = 0;

  for (const path of paths) {
    const normalized = normalizedManifestPath(path);
    if (importedPaths.has(normalized)) {
      skippedCount += 1;
      continue;
    }
    const timings = startStageTiming();
    let persisted = false;
    try {
      const imported = await importGenerationManifest(path);
      const jobId = imported.manifest.jobId;
      if (jobId && importedJobIds.has(jobId)) {
        skippedCount += 1;
        importedPaths.add(normalized);
        continue;
      }
      await importManifestFlow(
        path,
        timings,
        () => {
          persisted = true;
        },
        false,
        imported,
      );
      importedPaths.add(normalized);
      if (jobId) importedJobIds.add(jobId);
      importedCount += 1;
    } catch (error) {
      if (persisted) {
        importedPaths.add(normalized);
        importedCount += 1;
      } else {
        failures.push({
          path,
          error: (error as Error).message || String(error),
        });
      }
    }
  }

  if (importedCount) {
    revealAssetDock();
    try {
      await refreshGallery();
    } catch (error) {
      console.warn("Imported manifests were saved, but the gallery could not refresh", error);
    }
  }
  if (warnings.length) console.warn("Manifest discovery warnings", warnings);
  if (failures.length) console.warn("Manifest folder import failures", failures);

  return { imported: importedCount, skipped: skippedCount, failures };
}

function reportManifestImport(
  result: AutomationImportCompletion,
  warnings: string[],
  prefix = "",
): void {
  const summary = [
    `${prefix}Imported ${result.imported}`,
    result.skipped ? `skipped ${result.skipped} already imported` : "",
    result.failures.length ? `failed ${result.failures.length}` : "",
    warnings.length ? `${warnings.length} scan warning${warnings.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  toast(summary.join(", "), result.failures.length || warnings.length ? "err" : "ok");
}

async function importManifestFolder(root: string): Promise<void> {
  const discovery = await discoverGenerationManifests(root);
  if (!discovery.paths.length) {
    toast("No .triastasis.json files were found in that folder", "err");
    if (discovery.warnings.length) console.warn("Manifest discovery warnings", discovery.warnings);
    return;
  }
  const result = await importManifestPaths(discovery.paths, discovery.warnings);
  reportManifestImport(result, discovery.warnings);
}

async function requeueFromManifest(path: string, m?: GenerationManifest): Promise<void> {
  const manifest = m ?? (await readGenerationManifest(path)).manifest;
  if (!manifest.assetId || !manifest.versionId) {
    throw new Error("This manifest predates lineage tracking and cannot be resumed in place");
  }
  const bytes = await readManifestAsset(path, "sourceImage");
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  const name = `${safeStem(manifest.label || "resumed")}.png`;
  queueJob({
    image: blob,
    name,
    params: normalizeGenParams(manifestRecordedParams(manifest)),
    label: `${manifest.label || "Resumed"} · seed ${manifest.seed}`,
    autoOpen: false,
    resumeManifest: {
      path,
      assetId: manifest.assetId,
      versionId: manifest.versionId,
    },
  });
  toast(
    manifestStoresAdvancedSettings(manifest)
      ? "Requeued with the original settings"
      : "Requeued; this older record did not store advanced settings, so defaults were applied",
    "ok",
  );
}

// ---- standalone GLB viewing ----
function updateStandaloneActions(): void {
  const show = Boolean(standaloneView);
  $("standalone-actions").classList.toggle("hidden", !show);
  if (!show) return;
  const linked = $("import-linked-manifest");
  linked.classList.add("hidden");
  findLinkedManifest(standaloneView!.glbPath ?? "")
    .then((path) => {
      if (!standaloneView) return;
      standaloneView.linkedPath = path;
      linked.classList.toggle("hidden", !path);
    })
    .catch(() => {});
}

function clearStandaloneView(): void {
  standaloneView = null;
  updateStandaloneActions();
}

async function viewGlbFile(glbPath: string): Promise<void> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(glbPath);
    const blob = new Blob([bytes], { type: "model/gltf-binary" });
    const instance = await getViewer();
    disposeEditorSession();
    const stats = await instance.load(blob);
    setWorkspaceMode("view");
    activeParams = null;
    activeLabel = "";
    currentGlb = blob;
    activeId = null;
    renderViewerStats(stats, null);
    setViewerTools(true);
    viewerCaption.textContent = `Unimported model · ${(blob.size / 1e6).toFixed(1)} MB`;
    standaloneView = { glbPath, linkedPath: null };
    updateStandaloneActions();
  } catch (error) {
    toast((error as Error).message || "Could not open the GLB", "err");
  }
}

$("open-glb-btn").addEventListener("click", async () => {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "GLB model", extensions: ["glb"] }],
    });
    if (typeof picked === "string") void viewGlbFile(picked);
  } catch (error) {
    toast((error as Error).message || "Could not open a GLB", "err");
  }
});
$("add-viewed-to-assets").addEventListener("click", async () => {
  if (!currentGlb || !viewer || !standaloneView) return;
  try {
    const stats = viewer.getStats();
    const thumb = await viewer.thumbnail().catch(() => null);
    const id = newId();
    const rec: VersionRecord = {
      id,
      ts: Date.now(),
      name: standaloneView.glbPath?.split(/[\\/]/).pop() || "viewed.glb",
      params: DEFAULT_PARAMS,
      input: placeholderImage(),
      glb: currentGlb,
      thumb,
      assetId: id,
      versionId: id,
      operation: "imported",
      operationParams: { importedFrom: standaloneView.glbPath },
      createdAt: Date.now(),
      label: standaloneView.glbPath?.split(/[\\/]/).pop()?.replace(/\.glb$/i, "") || "Viewed model",
      favorite: false,
      metrics: statsToMetrics(stats),
      qualityWarning: detectPlaneCollapse(stats.dimensions) ?? undefined,
    };
    await put(rec);
    activeId = rec.id;
    activeLabel = rec.label;
    clearStandaloneView();
    updateViewerCaption();
    revealAssetDock();
    await refreshGallery();
    toast("Added to Assets", "ok");
  } catch (error) {
    toast((error as Error).message || "Could not add to Assets", "err");
  }
});
$("import-linked-manifest").addEventListener("click", () => {
  const path = standaloneView?.linkedPath;
  if (path) void openManifestPreview(path);
});

// ---- interrupted-generation recovery ----
interface InterruptedEntry extends RecoveryCandidate {}
let interruptedManifests: InterruptedEntry[] = [];

function groupInterrupted(
  entries: InterruptedEntry[],
): { singles: InterruptedEntry[]; sweeps: Map<string, InterruptedEntry[]> } {
  const singles: InterruptedEntry[] = [];
  const sweeps = new Map<string, InterruptedEntry[]>();
  for (const entry of entries) {
    const groupId = entry.manifest.sweep?.groupId;
    if (!groupId) singles.push(entry);
    else {
      const group = sweeps.get(groupId) ?? [];
      group.push(entry);
      sweeps.set(groupId, group);
    }
  }
  return { singles, sweeps };
}

async function loadSweepCandidates(anyCandidatePath: string, groupId: string): Promise<RecoveryCandidate[]> {
  const siblings = await listSiblingManifests(anyCandidatePath);
  const loaded: Array<RecoveryCandidate | null> = await Promise.all(
    siblings.map(async (path) => {
      try {
        const preview = await readGenerationManifest(path);
        if (preview.manifest.sweep?.groupId !== groupId) return null;
        return { path, manifest: preview.manifest, issues: preview.issues };
      } catch {
        return null;
      }
    }),
  );
  return loaded.filter((entry): entry is RecoveryCandidate => entry !== null);
}

function describeState(state: string | undefined): string {
  switch (state) {
    case "completed":
      return "completed";
    case "running":
      return "was running";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "queued, never started";
  }
}

async function checkInterruptedManifests(): Promise<void> {
  if (!isTauri()) return;
  try {
    const found = await scanInterruptedManifests();
    interruptedManifests = found.map(([path, manifest]) => ({ path, manifest }));
    recoveryBanner.classList.toggle("hidden", interruptedManifests.length === 0);
    if (interruptedManifests.length) {
      const { singles, sweeps } = groupInterrupted(interruptedManifests);
      const parts: string[] = [];
      if (singles.length) {
        parts.push(`${singles.length} unfinished generation${singles.length === 1 ? "" : "s"}`);
      }
      if (sweeps.size) {
        parts.push(`${sweeps.size} unfinished seed sweep${sweeps.size === 1 ? "" : "s"}`);
      }
      (recoveryBanner.querySelector("span") as HTMLElement).textContent = parts.join(" and ");
    }
  } catch {
    /* scanning is best-effort */
  }
}

/** One recovery summary per sweep group instead of unrelated dialogs. */
async function openSweepRecoveryView(groupId: string, anchorPath: string): Promise<void> {
  let candidates: InterruptedEntry[];
  try {
    candidates = await loadSweepCandidates(anchorPath, groupId);
  } catch (error) {
    toast((error as Error).message || "Could not inspect the sweep records", "err");
    return;
  }
  const ordered = sortBySweepIndex(candidates);
  const total = ordered[0]?.manifest.sweep?.count ?? ordered.length;
  const queueable = queueableCandidates(ordered);

  manifestTitle.textContent = "Interrupted seed sweep";
  const rows = ordered
    .map((candidate, position) => {
      const m = candidate.manifest;
      const eligibility = recoveryEligibility(m, candidate.issues);
      const stateText =
        m.status === "interrupted" ? describeState(m.sweep?.state) : describeState(m.status);
      const suffix = eligibility.eligible
        ? ""
        : ` · will not re-queue: ${escapeHtml(eligibility.reason ?? "unknown reason")}`;
      return `<div class="manifest-facts"><b>Candidate ${position + 1}</b> · seed ${escapeHtml(m.seed)} · ${escapeHtml(stateText)}${suffix}</div>`;
    })
    .join("");
  manifestBody.innerHTML = `
    <div>
      <div class="manifest-facts">
        <b>${total - queueable.length}/${total}</b> candidates already finished or excluded ·
        <b>${queueable.length}</b> will be re-queued.
        Original order and seeds are preserved; finished candidates are not regenerated.
        Failed candidates are retryable; cancelled ones are never restored.
      </div>
      ${rows}
      <div class="modal-actions">
        <button id="manifest-cancel" class="button button--secondary" type="button">Close</button>
        ${
          queueable.length
            ? `<button id="sweep-requeue" class="button button--primary" type="button">Requeue sweep</button>`
            : ""
        }
      </div>
    </div>`;
  manifestOpener = (document.activeElement as HTMLElement) ?? null;
  manifestModal.classList.remove("hidden");
  (
    manifestBody.querySelector<HTMLElement>("#sweep-requeue") ??
    manifestBody.querySelector<HTMLElement>("#manifest-cancel")
  )?.focus();

  manifestBody.querySelector("#manifest-cancel")?.addEventListener("click", closeManifestModal);
  manifestBody.querySelector("#sweep-requeue")?.addEventListener("click", async () => {
    const button = manifestBody.querySelector<HTMLButtonElement>("#sweep-requeue")!;
    button.disabled = true;
    button.textContent = "Queueing…";
    try {
      // Pure preflight: eligible candidates in original sweep.index order,
      // each with its normalized source identity.
      const planned = planRecoveryQueue(candidates);
      if (!planned.length) {
        toast("Nothing to restore: every candidate is already finished or excluded", "err");
        closeManifestModal();
        return;
      }

      // Hardware eligibility is part of preflight so a mixed sweep cannot be
      // partially queued before a later candidate is rejected.
      for (const candidate of planned) {
        const m = candidate.candidate.manifest;
        const restriction = hardwareRestriction(normalizeGenParams(manifestRecordedParams(m)));
        if (restriction) throw new Error(`${m.label || `Seed ${m.seed}`}: ${restriction}`);
      }

      // The production orchestration helper reads all distinct sources before
      // this callback can enqueue the first job.
      await executeRecoveryPlan(
        planned,
        async (candidate) => {
          const bytes = await readManifestAsset(candidate.path, "sourceImage");
          return new Blob([new Uint8Array(bytes)], { type: "image/png" });
        },
        (candidate, source) => {
          const m = candidate.manifest;
          queueJob({
            image: source,
            name: `${safeStem(m.label || "resumed")}.png`,
            params: normalizeGenParams(manifestRecordedParams(m)),
            label: m.label || `Candidate · seed ${m.seed}`,
            autoOpen: false,
            sweep: {
              id: m.sweep!.groupId,
              index: m.sweep!.index,
              count: m.sweep!.count,
            },
            resumeManifest: {
              path: candidate.path,
              assetId: m.assetId!,
              versionId: m.versionId!,
            },
          });
        },
      );
      // Report the number actually queued, not the original list size.
      toast(
        `Restoring sweep: ${planned.length} candidate${planned.length === 1 ? "" : "s"} re-queued`,
        "ok",
      );
      closeManifestModal();
      void checkInterruptedManifests();
    } catch (error) {
      // Zero jobs were queued: keep the recovery modal open and actionable.
      toast(`Sweep was not restored (nothing queued): ${(error as Error).message || error}`, "err");
      button.disabled = false;
      button.textContent = "Requeue sweep";
    }
  });
}


$("recovery-review").addEventListener("click", () => {
  const { singles, sweeps } = groupInterrupted(interruptedManifests);
  const firstSweep = [...sweeps.entries()][0];
  if (firstSweep && !singles.length) {
    void openSweepRecoveryView(firstSweep[0], firstSweep[1][0].path);
    return;
  }
  const [firstPath] = singles[0] ? [singles[0].path] : [];
  if (firstPath) void openManifestPreview(firstPath);
});

$("import-generation-btn").addEventListener("click", async () => {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Triastasis generation", extensions: ["json"] }],
    });
    if (typeof picked === "string") void openManifestPreview(picked);
  } catch (error) {
    toast((error as Error).message || "Could not pick a manifest", "err");
  }
});

galleryRecoveryImport.addEventListener("click", () => $("import-generation-folder-btn").click());

$("import-generation-folder-btn").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("import-generation-folder-btn");
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    button.disabled = true;
    button.textContent = "Importing…";
    await importManifestFolder(picked);
  } catch (error) {
    toast((error as Error).message || "Could not import the folder", "err");
  } finally {
    button.disabled = false;
    button.textContent = "Import folder…";
  }
});


// ---- boot ----
async function boot(): Promise<void> {
  setViewerTools(false);
  renderViewerStats(null);
  setWorkspaceMode("generate");
  initDockPreference();
  await initModelDownloadState(isTauri());
  await initModelSetup();
  await refreshHardwareGuardrails();
  subscribeModelStorageRefresh();
  await pollHealth();
  await syncAutomationResults();
  await syncAutomationImportRequests();
  await checkInterruptedManifests();
  await refreshGallery();
  window.setInterval(pollHealth, 4000);
  if (!isTauri()) {
    // Browser mode: no shell to report a backend.
    backendBadge.textContent = "browser";
  }
}
void boot().catch((error) => {
  console.error("Triastasis boot failed", error);
});
