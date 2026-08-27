// First-launch model setup. The welcome is shown once, while the focused model
// recovery screen can return if no usable bundle remains. Never starts a
// download without an explicit user action.

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

const APP_SHELL_SELECTOR = ".mode-rail, #setup-banner, #recovery-banner, #workspace";
const ONBOARDING_STORAGE_KEY = "triastasis.onboarding.complete.v1";

function onboardingWasCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboardingCompleted(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // The model remains usable even if the webview cannot persist preferences.
  }
}

function setSetupVisible(visible: boolean): void {
  const root = section();
  const wasVisible = root ? !root.classList.contains("hidden") : false;
  root?.classList.toggle("hidden", !visible);
  document.body.classList.toggle("model-setup-active", visible);
  document.querySelectorAll<HTMLElement>(APP_SHELL_SELECTOR).forEach((element) => {
    element.inert = visible;
    element.toggleAttribute("aria-hidden", visible);
  });
  if (visible && !wasVisible) queueMicrotask(() => root?.focus());
}

function renderSetupLoading(root: HTMLElement): void {
  root.innerHTML = `
    <div class="onboarding-shell onboarding-shell--loading" role="status" aria-live="polite">
      <img class="onboarding-logo" src="/brand/triastasis-mark.png" alt="" />
      <div class="onboarding-loading-copy">
        <strong id="model-setup-title">Checking your model setup</strong>
        <span>Looking for model bundles already installed on this computer.</span>
      </div>
    </div>`;
}

function renderSetupError(root: HTMLElement, showWelcome: boolean): void {
  root.setAttribute("aria-labelledby", showWelcome ? "model-setup-title" : "model-setup-error-title");
  root.innerHTML = `
    <div class="onboarding-shell onboarding-shell--error">
      ${showWelcome ? `
        <header class="onboarding-intro">
          <img class="onboarding-logo" src="/brand/triastasis-mark.png" alt="Triastasis logo" />
          <div>
            <h1 id="model-setup-title">Welcome to Triastasis</h1>
            <p>Create a textured 3D model from a single image, entirely on your computer.</p>
          </div>
        </header>` : ""}
      <section class="onboarding-error" aria-labelledby="model-setup-error-title">
        <h2 id="model-setup-error-title">We could not check your model bundles</h2>
        <p>Triastasis needs access to its model storage before setup can continue.</p>
        <button class="button button--primary" data-act="retry-scan">Try again</button>
      </section>
    </div>`;
  root.querySelector<HTMLButtonElement>("[data-act='retry-scan']")?.addEventListener("click", () => {
    renderSetupLoading(root);
    void refreshModelSetup();
  });
}

/** True when the app has nothing usable to generate with yet. */
export function needsSetup(scan: ModelsScan): boolean {
  const hasVerifiedActive = scan.managed.some(
    (m) => m.registered && m.bundleId === scan.activeBundle,
  );
  const legacyUsable = scan.legacy?.status === "completeUnverified";
  return !hasVerifiedActive && !legacyUsable;
}

/** The welcome is shown once; missing models still reopen the focused setup screen. */
export function shouldShowSetup(scan: ModelsScan, onboardingComplete: boolean): boolean {
  return !onboardingComplete || needsSetup(scan);
}

/** Registered bundles that can be offered as an immediate first-launch choice. */
export function installedBundleIds(scan: ModelsScan): string[] {
  return scan.managed
    .filter((bundle) => bundle.registered && bundle.bundleId !== scan.activeBundle)
    .map((bundle) => bundle.bundleId);
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
  const onboardingComplete = onboardingWasCompleted();
  const scan = await currentScan();
  if (!scan) {
    setSetupVisible(true);
    renderSetupError(el, !onboardingComplete);
    return;
  }
  const partials = modelDownloadSnapshot().partial;
  const show = shouldShowSetup(scan, onboardingComplete);
  setSetupVisible(show);
  if (!show) {
    el.replaceChildren();
    return;
  }
  await renderSetup(el, scan, partials, !onboardingComplete);
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
    installed: scan.managed.some((m) => m.bundleId === summary.id && m.registered) ||
      (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId === summary.id),
    active: scan.activeBundle === summary.id,
    partialBytes: 0,
  }));
  return { views, recommendation };
}

async function renderSetup(
  root: HTMLElement,
  scan: ModelsScan,
  partials: string[],
  showWelcome: boolean,
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
        action = `<span class="model-badge ok">Installed</span>`;
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
          <p>${view.summary.quantization.toUpperCase()}, about ${formatGigabytes(view.summary.totalBytes)}, ${view.summary.fileCount} files</p>
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
  const installedIds = new Set(installedBundleIds(scan));
  if (scan.activeBundle) installedIds.add(scan.activeBundle);
  if (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId) {
    installedIds.add(scan.legacy.bundleId);
  }
  const installedViews = views.filter((view) => installedIds.has(view.summary.id));
  const installedPrompt = installedViews.length
    ? `
      <section class="installed-bundle-prompt" aria-labelledby="installed-bundle-title">
        <div>
          <h3 id="installed-bundle-title">Model bundle found</h3>
          <p>${installedViews.length === 1
            ? `We found ${escapeHtml(installedViews[0].summary.displayName)} already installed. Use it now, or choose another bundle below.`
            : `We found ${installedViews.length} model bundles already installed. Use one now, or choose another bundle below.`}</p>
        </div>
        <div class="installed-bundle-actions">
          ${installedViews.map((view) => {
            const alreadyInUse = scan.activeBundle === view.summary.id ||
              (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId === view.summary.id);
            return `
              <button class="button button--primary" data-act="${alreadyInUse ? "continue" : "use"}" data-id="${view.summary.id}">
                Use ${escapeHtml(view.summary.displayName)}
              </button>`;
          }).join("")}
        </div>
      </section>`
    : "";

  root.setAttribute("aria-labelledby", showWelcome ? "model-setup-title" : "model-bundle-title");
  root.innerHTML = `
    <div class="onboarding-shell">
      ${showWelcome ? `
        <header class="onboarding-intro">
          <img class="onboarding-logo" src="/brand/triastasis-mark.png" alt="Triastasis logo" />
          <div>
            <h1 id="model-setup-title">Welcome to Triastasis</h1>
            <p>Create a textured 3D model from a single image, entirely on your computer.</p>
            <p class="onboarding-lineage">Built on Piotr Wilkin's trellis.cpp, a native C++ port of Microsoft's TRELLIS.2 research.</p>
          </div>
        </header>` : ""}
      <section class="onboarding-models" aria-labelledby="model-bundle-title">
        <div class="onboarding-models-heading">
          <h2 id="model-bundle-title">Set up your model bundle</h2>
          <p>${escapeHtml(intro)}</p>
        </div>
        ${installedPrompt}
        <div class="model-location">
          <label>Storage location</label>
          <code id="model-root-path">${escapeHtml(scan.modelsRoot)}</code>
          <span class="model-free">${escapeHtml(freeText)}</span>
          <button class="button button--secondary button--sm" data-act="change-location">Change location...</button>
          ${scan.portable ? `<p class="model-note">Portable mode keeps models next to the application.</p>` : ""}
        </div>
        <div id="model-setup-message" class="banner hidden"><span></span></div>
        ${views.length
          ? `<div class="bundle-grid">${cards}</div>`
          : `<div class="model-catalog-empty" role="alert">Model choices are unavailable. Try restarting Triastasis.</div>`}
        ${progressBar}
        ${legacyPanel}
        ${partials.length ? `<p class="model-note">An unfinished download was found and can be resumed.</p>` : ""}
      </section>
    </div>
  `;

  bindActions(root, scan);
}

function renderProgress(progress: NonNullable<ReturnType<typeof modelDownloadSnapshot>["progress"]>): string {
  const pct = progress.totalBytesTotal
    ? Math.min(100, Math.round((progress.totalBytesDone / progress.totalBytesTotal) * 100))
    : 0;
  const detail =
    progress.state === "verifying"
      ? "Verifying downloaded files..."
      : progress.fileName
        ? `${escapeHtml(progress.fileName)} (${formatGigabytes(progress.fileBytesDone)} of ${formatGigabytes(progress.fileBytesTotal)})`
        : "Preparing...";
  return `
    <div class="model-progress" role="status" aria-label="Model download progress">
      <div class="model-progress-bar" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <p>${pct}%, ${formatSpeed(progress.bytesPerSecond)}, ${formatEta(progress.etaSeconds)} remaining<br><span>${detail}</span></p>
    </div>`;
}

function renderLegacyPanel(scan: ModelsScan): string {
  const legacy = scan.legacy;
  if (!legacy || legacy.status === "empty") return "";
  if (legacy.status === "completeUnverified") {
    return "";
  }
  if (legacy.status === "incomplete" && legacy.bundleId) {
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
          showMessage(root, "Switching to this bundle...", false);
          await activateBundle(id);
          markOnboardingCompleted();
        } else if (act === "continue") {
          markOnboardingCompleted();
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
export async function initModelSetup(): Promise<void> {
  if (started) return;
  if (!isTauri()) {
    setSetupVisible(false);
    return;
  }
  started = true;
  const root = section();
  if (root && !onboardingWasCompleted()) {
    setSetupVisible(true);
    renderSetupLoading(root);
  }
  await refreshModelSetup();
  subscribeModelDownloads(() => void refreshModelSetup());
  window.setInterval(() => void refreshModelSetup(), 10000);
}
