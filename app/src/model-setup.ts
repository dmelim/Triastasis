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
  activateCustomBundle,
  availableBytes,
  cancelBundle,
  detectNativeHardware,
  downloadBundle,
  pauseBundle,
  recommendBundle,
  resetIncompleteBundle,
  selectionWarning,
  setModelsRoot,
  verifyAndRegister,
} from "./model-manager";
import { busyContentFor } from "./modal-busy";
import {
  bindCuratedModelTerms,
  curatedModelTermsAccepted,
  curatedModelTermsHtml,
} from "./model-terms";
import { isTauri, pickDirectory } from "./tauri";
import { installRuntime, runtimeLabel, scanRuntime, type RuntimeStatus } from "./runtime-manager";

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
let pendingCustomPath: string | null = null;
type OnboardingStep = "welcome" | "runtime" | "credits" | "models";
let onboardingStep: OnboardingStep = "welcome";

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
        <strong id="model-setup-title">Checking your local setup</strong>
        <span>Checking the generation runtime and model bundles on this computer.</span>
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
        <h2 id="model-setup-error-title">We could not check your local setup</h2>
        <p>Triastasis needs access to its runtime and model storage before setup can continue.</p>
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
  const customUsable =
    scan.activeBundle === "custom-local" && scan.custom?.available === true;
  return !hasVerifiedActive && !legacyUsable && !customUsable;
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

/** Complete managed files that only need their registration marker rebuilt. */
export function bundleNeedsRegistration(scan: ModelsScan, bundleId: string): boolean {
  const managed = scan.managed.find((bundle) => bundle.bundleId === bundleId);
  return Boolean(
    managed &&
      !managed.registered &&
      managed.totalFiles > 0 &&
      managed.sizedFiles === managed.totalFiles,
  );
}

/** Incomplete managed or partial files that the downloader can inspect and resume. */
export function bundleCanResume(
  scan: ModelsScan,
  bundleId: string,
  partials: string[] = [],
): boolean {
  const managed = scan.managed.find((bundle) => bundle.bundleId === bundleId);
  const managedIncomplete = Boolean(
    managed &&
      !managed.registered &&
      managed.totalFiles > 0 &&
      managed.sizedFiles < managed.totalFiles,
  );
  return managedIncomplete || partials.includes(bundleId);
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
  const [scan, runtime] = await Promise.all([
    currentScan(),
    scanRuntime().catch(() => null),
  ]);
  if (!scan || !runtime) {
    setSetupVisible(true);
    renderSetupError(el, !onboardingComplete);
    return;
  }
  const partials = modelDownloadSnapshot().partial;
  const show = shouldShowSetup(scan, onboardingComplete) || !runtime.installed;
  setSetupVisible(show);
  if (!show) {
    el.replaceChildren();
    return;
  }
  if (onboardingComplete) onboardingStep = runtime.installed ? "models" : "runtime";
  await renderSetup(el, scan, runtime, partials, !onboardingComplete);
}

/** Reopen model setup when generation discovers that no model is configured. */
export async function openModelSetup(message?: string): Promise<void> {
  onboardingStep = "models";
  setSetupVisible(true);
  await refreshModelSetup();
  const root = section();
  if (root && message) showMessage(root, message, true);
}

interface BundleView {
  summary: BundleSummary;
  recommended: boolean;
  warning: string | null;
  installed: boolean;
  needsRegistration: boolean;
  canResume: boolean;
  active: boolean;
}

function buildViews(
  catalog: BundleSummary[],
  scan: ModelsScan,
  vramMb: number | null,
  partials: string[],
): { views: BundleView[]; recommendation: ReturnType<typeof recommendBundle> } {
  const recommendation = recommendBundle(vramMb);
  const views = catalog.map((summary) => ({
    summary,
    recommended: summary.id === recommendation.bundleId,
    warning: selectionWarning(summary.id, vramMb),
    installed: scan.managed.some((m) => m.bundleId === summary.id && m.registered) ||
      (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId === summary.id),
    needsRegistration: bundleNeedsRegistration(scan, summary.id),
    canResume: bundleCanResume(scan, summary.id, partials),
    active: scan.activeBundle === summary.id,
  }));
  return { views, recommendation };
}

async function renderSetup(
  root: HTMLElement,
  scan: ModelsScan,
  runtime: RuntimeStatus,
  partials: string[],
  showWelcome: boolean,
): Promise<void> {
  const snapshot = modelDownloadSnapshot();
  const catalog = snapshot.catalog.length
    ? snapshot.catalog
    : [{ id: "", displayName: "", quantization: "", fileCount: 0, totalBytes: 0 }];
  const hardware = await detectNativeHardware();
  const { views } = buildViews(
    catalog.filter((b) => b.id),
    scan,
    hardware?.vramMb ?? null,
    partials,
  );
  const progress = snapshot.progress;
  const termsAccepted = curatedModelTermsAccepted();

  const freeText =
    scan.freeBytes != null ? `${formatGigabytes(scan.freeBytes)} free` : "free space unknown";
  const intro = scan.portable
    ? "Choose a model bundle to download into this portable installation."
    : "Triastasis needs one model bundle to generate 3D models. Choose a quality tier below.";

  const cards = views
    .map((view) => {
      const ownProgress = progress?.bundleId === view.summary.id ? progress : null;
      let action: string;
      if (ownProgress?.state === "preparing") {
        action = `
          <button class="button button--primary button--sm" type="button" disabled aria-busy="true">
            <span class="spinner" aria-hidden="true"></span>
            <span class="spinner-label">Starting...</span>
          </button>`;
      } else if (ownProgress && ["downloading", "verifying"].includes(ownProgress.state)) {
        action = `
          <button class="button button--secondary button--sm" data-act="pause" data-id="${view.summary.id}">Pause</button>
          <button class="button button--secondary button--sm" data-act="cancel" data-id="${view.summary.id}">Cancel</button>`;
      } else if (view.installed) {
        action = view.active
          ? ""
          : `<button class="button button--primary button--sm" data-act="use" data-id="${view.summary.id}">Use ${escapeHtml(view.summary.displayName)}</button>`;
      } else if (view.needsRegistration) {
        action = `<button class="button button--primary button--sm" data-act="verify" data-id="${view.summary.id}">Verify and register</button>`;
      } else if (ownProgress?.state === "paused") {
        action = `<button class="button button--primary button--sm" data-act="resume" data-id="${view.summary.id}">Resume download</button>`;
      } else if (ownProgress?.state === "failed") {
        action = "";
      } else if (view.canResume) {
        action = `<button class="button button--primary button--sm" data-act="resume" data-id="${view.summary.id}">Verify and resume</button>`;
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

  const progressPanel = progress
    ? ["preparing", "downloading", "verifying"].includes(progress.state)
      ? renderProgress(progress)
      : progress.state === "failed"
        ? renderDownloadFailure(progress)
        : ""
    : "";

  const legacyPanel = renderLegacyPanel(scan);
  const installedIds = new Set(installedBundleIds(scan));
  if (scan.activeBundle) installedIds.add(scan.activeBundle);
  if (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId) {
    installedIds.add(scan.legacy.bundleId);
  }
  const installedViews = views.filter((view) => installedIds.has(view.summary.id));
  const selectableInstalledViews = installedViews.filter((view) =>
    scan.activeBundle !== view.summary.id &&
    !(scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId === view.summary.id)
  );
  const installedPrompt = installedViews.length
    ? `
      <section class="installed-bundle-prompt" aria-labelledby="installed-bundle-title">
        <div>
          <h3 id="installed-bundle-title">Model bundle found</h3>
          <p>${installedViews.length === 1
            ? `We found ${escapeHtml(installedViews[0].summary.displayName)} already installed. Use it now, or choose another bundle below.`
            : `We found ${installedViews.length} model bundles already installed. Use one now, or choose another bundle below.`}</p>
        </div>
        ${selectableInstalledViews.length
          ? `<div class="installed-bundle-actions">
              ${selectableInstalledViews.map((view) =>
                `<button class="button button--primary" data-act="use" data-id="${view.summary.id}">Use ${escapeHtml(view.summary.displayName)}</button>`
              ).join("")}
            </div>`
          : ""}
      </section>`
    : "";
  const customPrompt = scan.custom
    ? `
      <section class="installed-bundle-prompt installed-bundle-prompt--custom" aria-labelledby="custom-bundle-title">
        <div>
          <div class="bundle-head">
            <h3 id="custom-bundle-title">Custom model folder found</h3>
            <span class="model-badge custom">Unverified custom bundle</span>
          </div>
          <p>${scan.custom.available
            ? `${escapeHtml(scan.custom.dir)} contains ${scan.custom.ggufFiles} readable GGUF file${scan.custom.ggufFiles === 1 ? "" : "s"}.`
            : escapeHtml(scan.custom.error || "The custom model folder is unavailable.")}</p>
        </div>
        ${scan.custom.available
          ? `<div class="installed-bundle-actions">
              ${scan.activeBundle === scan.custom.bundleId
                ? '<span class="model-badge ok">Custom folder is ready</span>'
                : `<button class="button button--primary" data-act="use-custom" data-path="${escapeHtml(scan.custom.dir)}">Use custom folder</button>`}
            </div>`
          : ""}
      </section>`
    : "";
  const customImport = `
    <section id="custom-model-import" class="custom-model-import" aria-labelledby="custom-model-import-title">
      <div>
        <h3 id="custom-model-import-title">Already have compatible model files?</h3>
        <p>Choose the folder that contains your GGUF model files. Triastasis will inspect the folder before using it and will not copy or upload the files.</p>
      </div>
      <button class="button button--secondary" type="button" data-act="pick-custom">
        ${scan.custom ? "Choose a different model folder" : "Choose model folder"}
      </button>
      ${pendingCustomPath ? `
        <div class="custom-model-confirm" role="alert" aria-labelledby="custom-model-warning-title">
          <strong id="custom-model-warning-title">Use unverified model files?</strong>
          <p>Custom model files are not verified or supported by Triastasis. They may be incompatible, unsafe, or incorrectly licensed. You are responsible for the files and their source.</p>
          <code>${escapeHtml(pendingCustomPath)}</code>
          <div class="custom-model-confirm-actions">
            <button class="button button--primary button--sm" data-act="confirm-custom" data-path="${escapeHtml(pendingCustomPath)}">Use this folder</button>
            <button class="button button--secondary button--sm" data-act="cancel-custom">Cancel</button>
          </div>
        </div>` : ""}
    </section>`;

  const modelsContent = `
      <section class="onboarding-models onboarding-stage" aria-labelledby="model-bundle-title">
        <div class="onboarding-models-heading">
          <h1 id="model-bundle-title">${installedPrompt || customPrompt ? "Choose your model bundle" : "Set up your model bundle"}</h1>
          <p>${escapeHtml(intro)}</p>
        </div>
        ${installedPrompt}
        ${customPrompt}
        <div class="model-location">
          <label>Storage location</label>
          <code id="model-root-path">${escapeHtml(scan.modelsRoot)}</code>
          <span class="model-free">${escapeHtml(freeText)}</span>
          <button class="button button--secondary button--sm" data-act="change-location">Change location...</button>
          ${scan.portable ? `<p class="model-note">Portable mode keeps models next to the application.</p>` : ""}
        </div>
        <div id="model-setup-message" class="banner hidden"><span></span></div>
        ${!termsAccepted && !showWelcome
          ? curatedModelTermsHtml()
          : !termsAccepted
            ? '<p class="model-terms-reminder" role="note">Curated downloads require acceptance of the model terms on the previous screen. If you try to download first, Triastasis will explain what is missing.</p>'
            : ""}
        ${views.length
          ? `<div class="bundle-grid">${cards}</div>`
          : `<div class="model-catalog-empty" role="alert">Model choices are unavailable. Try restarting Triastasis.</div>`}
        ${progressPanel}
        ${legacyPanel}
        ${customImport}
        ${partials.length ? `<p class="model-note">An unfinished download was found and can be resumed.</p>` : ""}
      </section>
  `;

  const recommendedRuntime = runtime.recommendedBackend;
  const runtimeContent = `
    <section class="onboarding-runtime onboarding-stage" aria-labelledby="runtime-setup-title">
      <div class="onboarding-models-heading">
        <h1 id="runtime-setup-title">Set up the generation runtime</h1>
        <p>Triastasis needs a native GPU runtime to generate models locally. The app downloads it from the matching Triastasis release and verifies its SHA-256 before installation.</p>
      </div>
      <div id="model-setup-message" class="banner hidden"><span></span></div>
      ${runtime.installed ? `
        <div class="runtime-status runtime-status--ready">
          <div>
            <strong>${escapeHtml(runtimeLabel(runtime.backend))} runtime is ready</strong>
            <p>Installed at <code>${escapeHtml(runtime.path)}</code></p>
          </div>
          <span class="model-badge ok">Ready</span>
        </div>` : `
        <div class="runtime-status recommended">
          <div>
            <div class="bundle-head">
              <strong>${escapeHtml(runtimeLabel(recommendedRuntime))}</strong>
              <span class="model-badge rec">Recommended for this system</span>
            </div>
            <p>${escapeHtml(runtime.recommendation)}</p>
          </div>
          <button class="button button--primary" type="button" data-act="install-runtime" data-backend="${escapeHtml(recommendedRuntime)}">Install recommended runtime</button>
        </div>
        <details class="runtime-options">
          <summary>Choose a different runtime</summary>
          <p>Use this only when you know which backend your system requires. Vulkan is the broad compatibility option. ROCm may require a separate compatible AMD runtime.</p>
          <div class="runtime-option-actions">
            ${["vulkan", "cuda", "cuda12", "rocm"].filter((backend) => backend !== recommendedRuntime).map((backend) =>
              `<button class="button button--secondary button--sm" type="button" data-act="install-runtime" data-backend="${backend}">${escapeHtml(runtimeLabel(backend))}</button>`
            ).join("")}
          </div>
        </details>`}
      <p class="model-note">${runtime.portable ? "Portable mode installs the runtime beside Triastasis." : "The runtime is installed in your local application data and can be replaced by a future verified update."}</p>
    </section>`;

  const step = showWelcome ? onboardingStep : runtime.installed ? "models" : "runtime";
  root.setAttribute(
    "aria-labelledby",
    step === "welcome" ? "model-setup-title" : step === "runtime" ? "runtime-setup-title" : step === "credits" ? "model-credits-title" : "model-bundle-title",
  );
  root.innerHTML = `
    <div class="onboarding-shell onboarding-shell--${step}">
      ${showWelcome ? `
        <nav class="onboarding-progress" aria-label="Onboarding progress">
          <span${step === "welcome" ? ' aria-current="step"' : ""}>Welcome</span>
          <span${step === "runtime" ? ' aria-current="step"' : ""}>Runtime</span>
          <span${step === "credits" ? ' aria-current="step"' : ""}>Credits</span>
          <span${step === "models" ? ' aria-current="step"' : ""}>Models</span>
        </nav>` : ""}
      ${step === "welcome" ? `
        <header class="onboarding-intro onboarding-stage">
          <div>
            <h1 id="model-setup-title">Welcome to Triastasis</h1>
            <p>Create a textured 3D model from a single image, entirely on your computer.</p>
          </div>
          <img class="onboarding-logo" src="/brand/triastasis-mark.png" alt="Triastasis logo" />
        </header>` : ""}
      ${step === "runtime" ? runtimeContent : ""}
      ${step === "credits" ? `
        <section class="onboarding-credits onboarding-stage" aria-labelledby="model-credits-title">
          <h1 id="model-credits-title">Credits and model terms</h1>
          <p class="onboarding-lineage">Built on <a href="https://github.com/pwilkin/trellis.cpp" target="_blank" rel="noreferrer">Piotr Wilkin's trellis.cpp</a>, a native C++ port of Microsoft's TRELLIS.2 research.</p>
          ${curatedModelTermsHtml()}
        </section>` : ""}
      ${step === "models" ? modelsContent : ""}
      <div class="onboarding-nav" aria-label="Onboarding navigation">
        ${step !== "welcome" && showWelcome ? '<button class="button button--secondary" type="button" data-act="previous-step">Previous</button>' : '<span></span>'}
        ${step === "welcome" ? '<button class="button button--primary" type="button" data-act="next-step">Next</button>' : ""}
        ${step === "runtime" && runtime.installed ? '<button class="button button--primary" type="button" data-act="next-step">Next</button>' : ""}
        ${step === "credits" ? '<button class="button button--primary" type="button" data-act="next-step">Next</button>' : ""}
        ${step === "models" ? '<button class="button button--primary" type="button" data-act="start">Start Triastasis</button>' : ""}
      </div>
    </div>`;

  bindActions(root, scan, runtime);
  if (step === "credits" || (!showWelcome && step === "models")) {
    bindCuratedModelTerms(root, () => void refreshModelSetup());
  }
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
  const summary = progress.state === "preparing"
    ? "Starting download..."
    : `${pct}%, ${formatSpeed(progress.bytesPerSecond)}, ${formatEta(progress.etaSeconds)} remaining`;
  return `
    <div class="model-progress" role="status" aria-label="Model download progress">
      <div class="model-progress-bar" aria-hidden="true"><div style="width:${pct}%"></div></div>
      <p>${summary}<br><span>${detail}</span></p>
    </div>`;
}

function renderDownloadFailure(
  progress: NonNullable<ReturnType<typeof modelDownloadSnapshot>["progress"]>,
): string {
  const detail = progress.error || "The download stopped before the model bundle was ready.";
  return `
    <div class="model-progress model-progress--failed" role="alert">
      <strong>Download stopped</strong>
      <p>${escapeHtml(detail)}<br><span>Triastasis kept reusable files. Try resuming first. If recovery keeps failing, delete the incomplete bundle and start again.</span></p>
      <div class="model-progress-actions">
        <button class="button button--primary button--sm" data-act="resume" data-id="${escapeHtml(progress.bundleId)}">Try resume again</button>
        <button class="button button--secondary button--sm" data-act="delete-incomplete" data-id="${escapeHtml(progress.bundleId)}">Delete incomplete files</button>
      </div>
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
      <p class="model-note">Use them as a custom bundle below, choose another location, or manage the files yourself.</p>
    </div>`;
}

function showMessage(root: HTMLElement, text: string, isError: boolean): void {
  const box = root.querySelector<HTMLElement>("#model-setup-message");
  if (!box) return;
  box.classList.remove("hidden");
  box.classList.toggle("err", isError);
  (box.querySelector("span") as HTMLElement).textContent = text;
}

function bindActions(root: HTMLElement, scan: ModelsScan, runtime: RuntimeStatus): void {
  root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id ?? "";
      if (act === "delete-incomplete" && btn.dataset.confirm !== "true") {
        btn.dataset.confirm = "true";
        btn.textContent = "Confirm deletion";
        return;
      }
      const beginsDownload =
        act === "install-runtime" ||
        act === "download" ||
        act === "resume" ||
        act === "verify" ||
        act === "confirm-custom" ||
        act === "use-custom";
      const originalHtml = btn.innerHTML;
      const originalMinWidth = btn.style.minWidth;
      let refreshAfterAction = true;
      btn.disabled = true;
      if (beginsDownload) {
        const busy = busyContentFor(btn.getBoundingClientRect().width);
        btn.style.minWidth = busy.minWidth;
        btn.innerHTML = busy.html;
        btn.querySelector<HTMLElement>(".spinner-label")!.textContent =
          act === "verify" ? "Verifying..." : act === "resume" ? "Resuming..." : "Starting...";
        btn.setAttribute("aria-busy", "true");
      }
      try {
        if (act === "next-step") {
          if (onboardingStep === "welcome") onboardingStep = "runtime";
          else if (onboardingStep === "runtime") {
            if (!runtime.installed) {
              showMessage(root, "Install the recommended runtime before continuing.", true);
              refreshAfterAction = false;
              return;
            }
            onboardingStep = "credits";
          } else onboardingStep = "models";
        } else if (act === "previous-step") {
          if (onboardingStep === "models") onboardingStep = "credits";
          else if (onboardingStep === "credits") onboardingStep = "runtime";
          else onboardingStep = "welcome";
        } else if (act === "start") {
          if (needsSetup(scan)) {
            showMessage(root, "Choose and activate a model bundle before starting Triastasis.", true);
            refreshAfterAction = false;
            return;
          }
          markOnboardingCompleted();
        } else if (act === "install-runtime") {
          const backend = btn.dataset.backend || runtime.recommendedBackend;
          showMessage(root, `Downloading and verifying the ${runtimeLabel(backend)} runtime...`, false);
          await installRuntime(backend);
        } else if (act === "change-location") {
          const picked = await pickDirectory(scan.modelsRoot);
          if (picked && picked !== scan.modelsRoot) {
            const free = await availableBytes(picked);
            if (free == null) throw new Error("The chosen folder is not accessible.");
            await setModelsRoot(picked);
          }
        } else if (act === "pick-custom") {
          const picked = await pickDirectory(scan.custom?.dir || scan.modelsDir || scan.modelsRoot);
          if (picked) pendingCustomPath = picked;
        } else if (act === "cancel-custom") {
          pendingCustomPath = null;
        } else if (act === "confirm-custom" || act === "use-custom") {
          const path = btn.dataset.path ?? "";
          showMessage(root, "Switching to the custom model folder...", false);
          await activateCustomBundle(path);
          pendingCustomPath = null;
        } else if (act === "download" || act === "resume") {
          await downloadBundle(id);
        } else if (act === "verify") {
          showMessage(root, "Verifying the existing model files...", false);
          await verifyAndRegister(id);
        } else if (act === "pause") {
          await pauseBundle();
        } else if (act === "cancel") {
          await cancelBundle();
        } else if (act === "delete-incomplete") {
          await resetIncompleteBundle(id);
          showMessage(root, "Incomplete files deleted. Start the download again when ready.", false);
        } else if (act === "use") {
          showMessage(root, "Switching to this bundle...", false);
          await activateBundle(id);
        }
      } catch (e) {
        showMessage(root, (e as Error).message || String(e), true);
        refreshAfterAction = false;
      } finally {
        if (beginsDownload) {
          btn.innerHTML = originalHtml;
          btn.style.minWidth = originalMinWidth;
          btn.removeAttribute("aria-busy");
        }
        btn.disabled = false;
        if (refreshAfterAction) void refreshModelSetup();
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
