// First-launch model setup (Phase 3). Shown when no verified bundle exists and
// no previously working installation was recognized. Never starts a download
// without an explicit user action.

import {
  type BundleSummary,
  type ModelsScan,
  scanModels,
} from "./model-catalog";
import {
  formatEta,
  formatGigabytes,
  formatSpeed,
  modelDownloadSnapshot,
  subscribeModelDownloads,
} from "./model-download-state";
import {
  activateBundle,
  availableBytes,
  cancelBundle,
  detectNativeHardware,
  downloadBundle,
  pauseBundle,
  recommendBundle,
  selectionWarning,
  setModelsRoot,
} from "./model-manager";
import { isTauri, pickDirectory } from "./tauri";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function section(): HTMLElement | null {
  return document.getElementById("model-setup");
}

/** True when the app has nothing usable to generate with yet. */
export function needsSetup(scan: ModelsScan): boolean {
  const hasVerifiedActive = scan.managed.some(
    (m) => m.registered && m.bundleId === scan.activeBundle,
  );
  const legacyUsable = scan.legacy?.status === "CompleteUnverified";
  return !hasVerifiedActive && !legacyUsable;
}

async function currentScan(): Promise<ModelsScan | null> {
  try {
    return await scanModels();
  } catch {
    return null;
  }
}

export async function refreshModelSetup(): Promise<void> {
  const el = section();
  if (!el || !isTauri()) return;
  const scan = await currentScan();
  if (!scan) {
    el.classList.add("hidden");
    return;
  }
  const partials = modelDownloadSnapshot().partial;
  const legacyNeedsAttention =
    scan.legacy?.status === "Incomplete" || scan.legacy?.status === "Unrecognized";
  const show = needsSetup(scan) || partials.length > 0 || legacyNeedsAttention;
  el.classList.toggle("hidden", !show);
  if (!show) return;
  await renderSetup(el, scan, partials);
}

interface BundleView {
  summary: BundleSummary;
  recommended: boolean;
  warning: string | null;
  installed: boolean;
  active: boolean;
  partialBytes: number;
}

function buildViews(
  catalog: BundleSummary[],
  scan: ModelsScan,
  vramMb: number | null,
): { views: BundleView[]; recommendation: ReturnType<typeof recommendBundle> } {
  const recommendation = recommendBundle(vramMb);
  const views = catalog.map((summary) => ({
    summary,
    recommended: summary.id === recommendation.bundleId,
    warning: selectionWarning(summary.id, vramMb),
    installed: scan.managed.some((m) => m.bundleId === summary.id && m.registered),
    active: scan.activeBundle === summary.id,
    partialBytes: 0,
  }));
  return { views, recommendation };
}

async function renderSetup(
  root: HTMLElement,
  scan: ModelsScan,
  partials: string[],
): Promise<void> {
  const snapshot = modelDownloadSnapshot();
  const catalog = snapshot.catalog.length
    ? snapshot.catalog
    : [{ id: "", displayName: "", quantization: "", fileCount: 0, totalBytes: 0 }];
  const hardware = await detectNativeHardware();
  const { views } = buildViews(catalog.filter((b) => b.id), scan, hardware?.vramMb ?? null);
  const progress = snapshot.progress;

  const freeText =
    scan.freeBytes != null ? `${formatGigabytes(scan.freeBytes)} free` : "free space unknown";
  const intro = scan.portable
    ? "Choose a model bundle to download into this portable installation."
    : "Triastasis needs one model bundle to generate 3D models. Choose a quality tier below.";

  const cards = views
    .map((view) => {
      const isActive = progress?.bundleId === view.summary.id &&
        ["preparing", "downloading", "verifying"].includes(progress.state);
      let action: string;
      if (isActive && progress) {
        action = `
          <button class="button button--secondary button--sm" data-act="pause" data-id="${view.summary.id}">Pause</button>
          <button class="button button--secondary button--sm" data-act="cancel" data-id="${view.summary.id}">Cancel</button>`;
      } else if (view.installed) {
        action = view.active
          ? `<span class="model-badge ok">Active</span>`
          : `<button class="button button--primary button--sm" data-act="use" data-id="${view.summary.id}">Use this bundle</button>`;
      } else if (progress?.bundleId === view.summary.id && progress.state === "paused") {
        action = `<button class="button button--primary button--sm" data-act="resume" data-id="${view.summary.id}">Resume download</button>`;
      } else {
        action = `<button class="button button--primary button--sm" data-act="download" data-id="${view.summary.id}">Download</button>`;
      }
      const recBadge = view.recommended
        ? `<span class="model-badge rec">Recommended for this system</span>`
        : "";
      const warn = view.warning ? `<p class="model-warning">${escapeHtml(view.warning)}</p>` : "";
      return `
        <div class="bundle-card${view.recommended ? " recommended" : ""}" data-bundle="${view.summary.id}">
          <div class="bundle-head">
            <strong>${escapeHtml(view.summary.displayName)}</strong>
            ${recBadge}
          </div>
          <p>${view.summary.quantization.toUpperCase()} · about ${formatGigabytes(view.summary.totalBytes)} · ${view.summary.fileCount} files</p>
          ${warn}
          <div class="bundle-actions">${action}</div>
        </div>`;
    })
    .join("");

  const progressBar =
    progress && ["preparing", "downloading", "verifying"].includes(progress.state)
      ? renderProgress(progress)
      : "";

  const legacyPanel = renderLegacyPanel(scan);

  root.innerHTML = `
    <h2>Set up your model bundle</h2>
    <p>${escapeHtml(intro)}</p>
    <div class="model-location">
      <label>Storage location</label>
      <code id="model-root-path">${escapeHtml(scan.modelsRoot)}</code>
      <span class="model-free">${escapeHtml(freeText)}</span>
      <button class="button button--secondary button--sm" data-act="change-location">Change location…</button>
      ${scan.portable ? `<p class="model-note">Portable mode keeps models next to the application.</p>` : ""}
    </div>
    <div id="model-setup-message" class="banner hidden"><span></span></div>
    <div class="bundle-grid">${cards}</div>
    ${progressBar}
    ${legacyPanel}
    ${partials.length ? `<p class="model-note">An unfinished download was found and can be resumed.</p>` : ""}
  `;

  bindActions(root, scan);
}

function renderProgress(progress: NonNullable<ReturnType<typeof modelDownloadSnapshot>["progress"]>): string {
  const pct = progress.totalBytesTotal
    ? Math.min(100, Math.round((progress.totalBytesDone / progress.totalBytesTotal) * 100))
    : 0;
  const detail =
    progress.state === "verifying"
      ? "Verifying downloaded files…"
      : progress.fileName
        ? `${escapeHtml(progress.fileName)} (${formatGigabytes(progress.fileBytesDone)} of ${formatGigabytes(progress.fileBytesTotal)})`
        : "Preparing…";
  return `
    <div class="model-progress" role="status" aria-label="Model download progress">
      <div class="model-progress-bar" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <p>${pct}% · ${formatSpeed(progress.bytesPerSecond)} · ${formatEta(progress.etaSeconds)} remaining<br><span>${detail}</span></p>
    </div>`;
}

function renderLegacyPanel(scan: ModelsScan): string {
  const legacy = scan.legacy;
  if (!legacy || legacy.status === "Empty") return "";
  if (legacy.status === "CompleteUnverified") {
    return "";
  }
  if (legacy.status === "Incomplete" && legacy.bundleId) {
    return `
      <div class="model-legacy">
        <p>An incomplete legacy installation was found: ${legacy.matchedFiles} of ${legacy.totalFiles} files match ${escapeHtml(legacy.bundleId)}.</p>
        <p class="model-note">Legacy files are left untouched. Downloading creates a separate managed bundle.</p>
        <button class="button button--primary button--sm" data-act="download" data-id="${escapeHtml(legacy.bundleId)}">Download managed bundle</button>
      </div>`;
  }
  return `
    <div class="model-legacy">
      <p>This folder contains model files Triastasis could not recognize. They were left untouched.</p>
      <p class="model-note">Choose another location above, or remove the unrecognized files yourself.</p>
    </div>`;
}

function showMessage(root: HTMLElement, text: string, isError: boolean): void {
  const box = root.querySelector<HTMLElement>("#model-setup-message");
  if (!box) return;
  box.classList.remove("hidden");
  box.classList.toggle("err", isError);
  (box.querySelector("span") as HTMLElement).textContent = text;
}

function bindActions(root: HTMLElement, scan: ModelsScan): void {
  root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id ?? "";
      btn.disabled = true;
      try {
        if (act === "change-location") {
          const picked = await pickDirectory(scan.modelsRoot);
          if (picked && picked !== scan.modelsRoot) {
            const free = await availableBytes(picked);
            if (free == null) throw new Error("The chosen folder is not accessible.");
            await setModelsRoot(picked);
          }
        } else if (act === "download" || act === "resume") {
          await downloadBundle(id);
        } else if (act === "pause") {
          await pauseBundle();
        } else if (act === "cancel") {
          await cancelBundle();
        } else if (act === "use") {
          showMessage(root, "Switching to this bundle…", false);
          await activateBundle(id);

        }
      } catch (e) {
        showMessage(root, (e as Error).message || String(e), true);
      } finally {
        btn.disabled = false;
        void refreshModelSetup();
      }
    };
  });
}

let started = false;

/** Bootstrap: renders the setup section whenever it becomes relevant. */
export function initModelSetup(): void {
  if (started || !isTauri()) return;
  started = true;
  void refreshModelSetup();
  subscribeModelDownloads(() => void refreshModelSetup());
  window.setInterval(() => void refreshModelSetup(), 10000);
}
