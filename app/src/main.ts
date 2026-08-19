import "./ui.css";
import { generate, health } from "./api";
import { loadConfig } from "./config";
import { renderSettings } from "./settings";
import { all, clear as clearStore, del as removeRecord, get as getRecord, isEphemeral, newId, put } from "./store";
import { automationInfo, isTauri, listen, previewAlpha, saveBytes, saveToOutputDir } from "./tauri";
import { Viewer, type CameraPreset, type DisplayMode, type ViewerStats } from "./viewer";
import { DEFAULT_PARAMS, type GenParams, type GenRecord } from "./types";

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

// ---- state ----
const viewer = new Viewer($("viewer-mount"));
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
let progressPrefix = "";

type WorkspaceMode = "generate" | "view";

type CandidateStatus = "queued" | "generating" | "ready" | "failed" | "cancelled";
interface CandidateSlot {
  seed: number;
  status: CandidateStatus;
  record?: GenRecord;
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

function renderViewerStats(stats: ViewerStats | null): void {
  const ready = Boolean(stats);
  inspectEmpty.classList.toggle("hidden", ready);
  inspectContent.classList.toggle("hidden", !ready);
  viewerEmpty.classList.toggle("hidden", ready);
  if (!stats) return;

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
}

generateModeBtn.addEventListener("click", () => setWorkspaceMode("generate"));
viewModeBtn.addEventListener("click", () => setWorkspaceMode("view"));
openViewBtn.addEventListener("click", () => setWorkspaceMode("view"));

document.querySelectorAll<HTMLButtonElement>("[data-display-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.displayMode as DisplayMode;
    viewer.setDisplayMode(mode);
    document.querySelectorAll("[data-display-mode]").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === button);
    });
  });
});

$<HTMLInputElement>("view-grid").addEventListener("change", (event) => {
  viewer.setGridVisible((event.currentTarget as HTMLInputElement).checked);
});
$<HTMLInputElement>("view-axes").addEventListener("change", (event) => {
  viewer.setAxesVisible((event.currentTarget as HTMLInputElement).checked);
});
$<HTMLInputElement>("view-rotate").addEventListener("change", (event) => {
  viewer.setAutoRotate((event.currentTarget as HTMLInputElement).checked);
});
$<HTMLInputElement>("view-shadows").addEventListener("change", (event) => {
  viewer.setShadows((event.currentTarget as HTMLInputElement).checked);
});
$<HTMLInputElement>("view-exposure").addEventListener("input", (event) => {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  $("view-exposure-value").textContent = value.toFixed(1);
  viewer.setExposure(value);
});
$<HTMLSelectElement>("view-background").addEventListener("change", (event) => {
  viewer.setBackground((event.currentTarget as HTMLSelectElement).value);
});
document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach((button) => {
  button.addEventListener("click", () => viewer.setCameraPreset(button.dataset.camera as CameraPreset));
});

// ---- controls -> params ----
function readParams(): GenParams {
  const res = parseInt(($("ctl-res") as HTMLSelectElement).value, 10);
  const seed = parseInt(($("ctl-seed") as HTMLInputElement).value, 10);
  return {
    resolution: (res === 512 || res === 1536 ? res : 1024) as GenParams["resolution"],
    seed: isNaN(seed) ? DEFAULT_PARAMS.seed : seed,
    bgRemoval: ($("ctl-bg") as HTMLSelectElement).value as GenParams["bgRemoval"],
    uv: ($("ctl-uv") as HTMLSelectElement).value as GenParams["uv"],
  };
}

function applyParams(p: GenParams): void {
  ($("ctl-res") as HTMLSelectElement).value = String(p.resolution);
  ($("ctl-seed") as HTMLInputElement).value = String(p.seed);
  ($("ctl-bg") as HTMLSelectElement).value = p.bgRemoval;
  ($("ctl-uv") as HTMLSelectElement).value = p.uv;
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
function setInput(blob: Blob, name: string): void {
  inputImage = blob;
  inputName = name || "input.png";
  inputPreview.src = URL.createObjectURL(blob);
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
  previewMaskBtn.disabled = true;
  previewMaskBtn.textContent = "Building mask...";
  maskHelp.textContent = "Running the same background-removal path used by TRELLIS.";
  try {
    const blob = await previewAlpha(inputImage, readParams().bgRemoval);
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
): Promise<GenRecord> {
  if (!inputImage) throw new Error("choose an input image first");
  const sourceImage = inputImage;
  const sourceName = inputName;
  const { glb } = await generate(sourceImage, params, abort?.signal);
  currentGlb = glb;

  const rec: GenRecord = {
    id: newId(),
    ts: Date.now(),
    name: sourceName,
    params,
    input: sourceImage,
    glb,
    thumb: null,
    sweepGroupId: sweep?.id,
    sweepIndex: sweep?.index,
    sweepCount: sweep?.count,
  };

  let savedPath: string | null = null;
  if (isTauri()) {
    try {
      const bytes = new Uint8Array(await glb.arrayBuffer());
      const base = sourceName.replace(/\.[^.]+$/, "") || "model";
      const fname = `${base}_${params.resolution}_seed${params.seed}_${rec.id}.glb`;
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
  setViewerTools(true);
  viewerCaption.textContent = `${params.resolution} | seed ${params.seed} | ${(glb.size / 1e6).toFixed(1)} MB`;
  await refreshGallery();

  try {
    const stats = await viewer.load(glb);
    renderViewerStats(stats);
    if (announce) setWorkspaceMode("view");
    const thumb = await viewer.thumbnail();
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
  const params = readParams();
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
  const baseParams = readParams();
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
}
resetViewBtn.addEventListener("click", () => viewer.resetView());
saveGlbBtn.addEventListener("click", async () => {
  if (!currentGlb) return;
  const bytes = new Uint8Array(await currentGlb.arrayBuffer());
  const base = inputName.replace(/\.[^.]+$/, "") || "model";
  const ok = await saveBytes(`${base}.glb`, bytes);
  if (ok) toast("Saved", "ok");
});

// ---- gallery ----
async function loadRecordData(rec: GenRecord): Promise<void> {
  let stats: ViewerStats;
  try {
    stats = await viewer.load(rec.glb);
  } catch (e) {
    toast((e as Error).message, "err");
    return;
  }
  renderViewerStats(stats);
  setWorkspaceMode("view");
  inputImage = rec.input;
  inputName = rec.name;
  inputPreview.src = URL.createObjectURL(rec.input);
  inputPreview.classList.remove("hidden");
  dropHint.classList.add("hidden");
  applyParams(rec.params);
  currentGlb = rec.glb;
  activeId = rec.id;
  setViewerTools(true);
  viewerCaption.textContent = `${rec.name} | ${rec.params.resolution} | seed ${rec.params.seed}`;
  updateGenerateEnabled();
  await refreshGallery();
  renderCandidates();
}

async function loadRecord(id: string): Promise<void> {
  const rec = await getRecord(id);
  if (rec) await loadRecordData(rec);
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
    galleryEl.innerHTML = `<div class="gallery-empty">No generations yet.</div>`;
    return;
  }
  const renderedGroups = new Set<string>();
  for (const r of recs) {
    const groupId = r.sweepGroupId;
    if (groupId && renderedGroups.has(groupId)) continue;
    const groupedRecords = groupId
      ? recs
          .filter((candidate) => candidate.sweepGroupId === groupId)
          .sort((a, b) => (a.sweepIndex ?? a.params.seed) - (b.sweepIndex ?? b.params.seed))
      : [r];
    if (groupId) renderedGroups.add(groupId);
    const representative = groupedRecords.find((candidate) => candidate.id === activeId) ?? groupedRecords[0];
    const isGroup = groupedRecords.length > 1 || Boolean(groupId);
    const item = document.createElement("div");
    item.className = `gitem${groupedRecords.some((candidate) => candidate.id === activeId) ? " active" : ""}${isGroup ? " grouped" : ""}`;
    item.title = isGroup
      ? `${representative.name} | seed sweep with ${groupedRecords.length} candidates`
      : `${representative.name} | ${new Date(representative.ts).toLocaleString()}`;

    const img = document.createElement("img");
    const src = representative.thumb ?? representative.input;
    const url = URL.createObjectURL(src);
    galleryUrls.push(url);
    img.src = url;
    item.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "gmeta";
    meta.textContent = isGroup ? `${groupedRecords.length} seeds` : `${representative.params.resolution}`;
    item.appendChild(meta);

    if (isGroup) {
      const groupLabel = document.createElement("span");
      groupLabel.className = "ggroup";
      groupLabel.textContent = "Sweep";
      item.appendChild(groupLabel);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "gdel";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      for (const record of groupedRecords) await removeRecord(record.id);
      if (groupedRecords.some((record) => record.id === activeId)) activeId = null;
      await refreshGallery();
    });
    item.appendChild(delBtn);

    item.addEventListener("click", async () => {
      if (isGroup) {
        candidates = groupedRecords.map((record) => ({
          seed: record.params.seed,
          status: "ready",
          record,
        }));
        await loadRecordData(representative);
      } else {
        await loadRecord(representative.id);
      }
    });
    galleryEl.appendChild(item);
  }
}

clearGalleryBtn.addEventListener("click", async () => {
  if (!confirm("Delete all saved generations?")) return;
  await clearStore();
  activeId = null;
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
