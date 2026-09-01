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
  modelMaintenanceSnapshot,
  pauseBundle,
  recommendBundle,
  resetIncompleteBundle,
  selectionWarning,
  setModelsRoot,
  subscribeModelMaintenance,
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
export type OnboardingStep = "welcome" | "credits" | "runtime" | "models";
let onboardingStep: OnboardingStep = "welcome";
let runtimeInstallInProgress = false;
let lastReadyBundleId: string | null = null;
let activationFeedback: { bundleId: string; state: "ready" | "failed"; message: string } | null = null;
const automaticActivationAttempts = new Set<string>();

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
  return effectiveActiveBundleId(scan) === null;
}

/** Resolve the bundle the server can actually use, including legacy flat layouts. */
export function effectiveActiveBundleId(scan: ModelsScan): string | null {
  const managedActive = scan.managed.find(
    (bundle) => bundle.registered && bundle.bundleId === scan.activeBundle,
  );
  if (managedActive) return managedActive.bundleId;
  if (
    scan.activeBundle === "custom-local" &&
    scan.custom?.bundleId === "custom-local" &&
    scan.custom.available
  ) {
    return scan.custom.bundleId;
  }
  if (scan.legacy?.status === "completeUnverified") {
    return scan.legacy.bundleId;
  }
  return null;
}

/** Pick the initial managed bundle without overriding a valid existing choice. */
export function defaultInstalledBundleId(
  scan: ModelsScan,
  recommendedBundleId: string,
  preferRecommended = false,
): string | null {
  const installed = scan.managed
    .filter((bundle) => bundle.registered)
    .map((bundle) => bundle.bundleId);
  const activeBundleId = effectiveActiveBundleId(scan);
  if (installed.length === 1) {
    return activeBundleId === installed[0] ? null : installed[0];
  }
  if (
    preferRecommended &&
    installed.length > 1 &&
    installed.includes(recommendedBundleId) &&
    activeBundleId !== recommendedBundleId
  ) {
    return recommendedBundleId;
  }
  if (activeBundleId) return null;
  if (installed.length > 1 && installed.includes(recommendedBundleId)) {
    return recommendedBundleId;
  }
  return installed[0] ?? null;
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

export function nextOnboardingStep(
  step: OnboardingStep,
  termsAccepted: boolean,
  runtimeInstalled: boolean,
): OnboardingStep {
  if (step === "welcome") return "credits";
  if (step === "credits") return termsAccepted ? "runtime" : "credits";
  if (step === "runtime") return runtimeInstalled ? "models" : "runtime";
  return "models";
}

export function previousOnboardingStep(step: OnboardingStep): OnboardingStep {
  if (step === "models") return "runtime";
  if (step === "runtime") return "credits";
  if (step === "credits") return "welcome";
  return "welcome";
}

export function startBlockedReason(
  scan: ModelsScan,
  runtimeInstalled: boolean,
  blockingActivity: string | null = null,
): string | null {
  if (!runtimeInstalled) return "Finish runtime setup first.";
  if (blockingActivity) return blockingActivity;
  if (needsSetup(scan)) return "Download and activate a model bundle first.";
  return null;
}

async function currentScan(): Promise<ModelsScan | null> {
  try {
    return await scanModels();
  } catch {
    return null;
  }
}

async function activateManagedBundle(bundleId: string): Promise<void> {
  activationFeedback = null;
  try {
    await activateBundle(bundleId);
    const scan = await currentScan();
    if (!scan || scan.activeBundle !== bundleId) {
      throw new Error("The model bundle was activated but could not be confirmed as ready.");
    }
    activationFeedback = {
      bundleId,
      state: "ready",
      message: `${bundleDisplayName(bundleId)} is ready`,
    };
  } catch (error) {
    activationFeedback = {
      bundleId,
      state: "failed",
      message: (error as Error).message || String(error),
    };
    throw error;
  }
}

function bundleDisplayName(bundleId: string): string {
  return modelDownloadSnapshot().catalog.find((bundle) => bundle.id === bundleId)?.displayName || "Model bundle";
}

function handleDownloadStateChange(): void {
  const progress = modelDownloadSnapshot().progress;
  const readyBundleId = progress?.state === "ready" ? progress.bundleId : null;
  if (!readyBundleId) {
    lastReadyBundleId = null;
    if (progress && ["preparing", "downloading", "verifying"].includes(progress.state)) {
      activationFeedback = null;
    }
    void refreshModelSetup();
    return;
  }
  if (readyBundleId === lastReadyBundleId) {
    void refreshModelSetup();
    return;
  }
  if (modelMaintenanceSnapshot().kind !== "idle") {
    lastReadyBundleId = null;
    void refreshModelSetup();
    return;
  }
  lastReadyBundleId = readyBundleId;
  void (async () => {
    const scan = await currentScan();
    if (scan?.activeBundle === readyBundleId) {
      activationFeedback = {
        bundleId: readyBundleId,
        state: "ready",
        message: `${bundleDisplayName(readyBundleId)} is ready`,
      };
    } else {
      try {
        await activateManagedBundle(readyBundleId);
      } catch {
        // The persistent activation feedback explains the failure and leaves a retry action available.
      }
    }
    await refreshModelSetup();
  })();
}

export async function refreshModelSetup(): Promise<void> {
  const el = section();
  if (!el || !isTauri()) return;
  if (runtimeInstallInProgress) return;
  const onboardingComplete = onboardingWasCompleted();
  const [scan, runtime] = await Promise.all([
    currentScan(),
    scanRuntime().catch(() => null),
  ]);
  if (runtimeInstallInProgress) return;
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
  const activeBundleId = effectiveActiveBundleId(scan);
  const views = catalog.map((summary) => ({
    summary,
    recommended: summary.id === recommendation.bundleId,
    warning: selectionWarning(summary.id, vramMb),
    installed: scan.managed.some((m) => m.bundleId === summary.id && m.registered) ||
      (scan.legacy?.status === "completeUnverified" && scan.legacy.bundleId === summary.id),
    needsRegistration: bundleNeedsRegistration(scan, summary.id),
    canResume: bundleCanResume(scan, summary.id, partials),
    active: activeBundleId === summary.id,
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
  const { views, recommendation } = buildViews(
    catalog.filter((b) => b.id),
    scan,
    hardware?.vramMb ?? null,
    partials,
  );
  const progress = snapshot.progress;
  const termsAccepted = curatedModelTermsAccepted();
  const step = showWelcome ? onboardingStep : runtime.installed ? "models" : "runtime";
  const automaticBundleId = step === "models" && runtime.installed
    ? defaultInstalledBundleId(scan, recommendation.bundleId, showWelcome)
    : null;
  if (automaticBundleId && modelMaintenanceSnapshot().kind === "idle") {
    const attemptKey = `${scan.modelsRoot}\n${automaticBundleId}`;
    if (!automaticActivationAttempts.has(attemptKey)) {
      automaticActivationAttempts.add(attemptKey);
      void activateManagedBundle(automaticBundleId)
        .catch(() => undefined)
        .finally(() => void refreshModelSetup());
    }
  }
  const maintenance = modelMaintenanceSnapshot();
  const activationBundleName = maintenance.bundleId ? bundleDisplayName(maintenance.bundleId) : null;

  const freeText =
    scan.freeBytes != null ? `${formatGigabytes(scan.freeBytes)} free` : "free space unknown";
  const intro = scan.portable
    ? "Choose a model bundle to download into this portable installation."
    : "Triastasis needs one model bundle to generate 3D models. Choose a quality tier below.";

  const cards = views
    .map((view) => {
      const ownProgress = progress?.bundleId === view.summary.id ? progress : null;
      const activationInProgress = maintenance.kind === "activating";
      const activatingThisBundle = activationInProgress && maintenance.bundleId === view.summary.id;
      const activationFailed = activationFeedback?.bundleId === view.summary.id &&
        activationFeedback.state === "failed";
      const controlsDisabled = activationInProgress ? " disabled" : "";
      let action: string;
      if (activatingThisBundle) {
        action = `
          <button class="button button--primary button--sm" type="button" disabled aria-busy="true">
            <span class="spinner" aria-hidden="true"></span>
            <span class="spinner-label">Activating ${escapeHtml(view.summary.displayName)}...</span>
          </button>`;
      } else if (ownProgress?.state === "preparing") {
        action = `
          <button class="button button--primary button--sm" type="button" disabled aria-busy="true">
            <span class="spinner" aria-hidden="true"></span>
            <span class="spinner-label">Starting...</span>
          </button>`;
      } else if (ownProgress && ["downloading", "verifying"].includes(ownProgress.state)) {
        action = `
          <button class="button button--secondary button--sm" data-act="pause" data-id="${view.summary.id}"${controlsDisabled}>Pause</button>
          <button class="button button--secondary button--sm" data-act="cancel" data-id="${view.summary.id}"${controlsDisabled}>Cancel</button>`;
      } else if (view.installed) {
        action = view.active
          ? '<button class="button button--primary button--sm" type="button" disabled aria-current="true">In use</button>'
          : `<button class="button button--primary button--sm" data-act="use" data-id="${view.summary.id}"${controlsDisabled}>Use ${escapeHtml(view.summary.displayName)}</button>`;
      } else if (view.needsRegistration) {
        action = `<button class="button button--primary button--sm" data-act="verify" data-id="${view.summary.id}"${controlsDisabled}>Verify and register</button>`;
      } else if (ownProgress?.state === "paused") {
        action = `<button class="button button--primary button--sm" data-act="resume" data-id="${view.summary.id}"${controlsDisabled}>Resume download</button>`;
      } else if (ownProgress?.state === "failed") {
        action = "";
      } else if (view.canResume) {
        action = `<button class="button button--primary button--sm" data-act="resume" data-id="${view.summary.id}"${controlsDisabled}>Verify and resume</button>`;
      } else {
        action = `<button class="button button--primary button--sm" data-act="download" data-id="${view.summary.id}"${controlsDisabled}>Download</button>`;
      }
      const recBadge = view.recommended
        ? `<span class="model-badge rec">Recommended for this system</span>`
        : "";
      const stateBadge = view.active
        ? '<span class="model-badge ok">Active</span>'
        : activatingThisBundle
          ? '<span class="model-badge activating">Activating</span>'
          : activationFailed
            ? '<span class="model-badge failed">Activation failed</span>'
            : view.installed
              ? '<span class="model-badge installed">Installed</span>'
              : "";
      const cardState = view.active
        ? " active"
        : activatingThisBundle
          ? " activating"
          : activationFailed
            ? " activation-failed"
            : "";
      const warn = view.warning ? `<p class="model-warning">${escapeHtml(view.warning)}</p>` : "";
      return `
        <div class="bundle-card${cardState}" data-bundle="${view.summary.id}">
          <div class="bundle-head">
            <strong>${escapeHtml(view.summary.displayName)}</strong>
            ${stateBadge}
            ${recBadge}
          </div>
          <p>${view.summary.quantization.toUpperCase()}, about ${formatGigabytes(view.summary.totalBytes)}, ${view.summary.fileCount} files</p>
          ${warn}
          <div class="bundle-actions">${action}</div>
        </div>`;
    })
    .join("");

  const progressPanel = maintenance.kind === "activating" && activationBundleName
    ? renderActivationStatus(`Activating ${activationBundleName}...`, false)
    : activationFeedback
      ? renderActivationStatus(activationFeedback.message, activationFeedback.state === "failed")
      : progress
        ? ["preparing", "downloading", "verifying"].includes(progress.state)
          ? renderProgress(progress)
          : progress.state === "failed"
            ? renderDownloadFailure(progress)
            : ""
        : "";

  const legacyPanel = renderLegacyPanel(scan, maintenance.kind !== "idle");
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
            ? `We found ${escapeHtml(installedViews[0].summary.displayName)} already installed. Its current status is shown below.`
            : `We found ${installedViews.length} model bundles already installed. The current selection and other available choices are shown below.`}</p>
        </div>
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
              ${effectiveActiveBundleId(scan) === scan.custom.bundleId
                ? '<button class="button button--primary" type="button" disabled aria-current="true">In use</button>'
                : `<button class="button button--primary" data-act="use-custom" data-path="${escapeHtml(scan.custom.dir)}"${maintenance.kind !== "idle" ? " disabled" : ""}>Use custom folder</button>`}
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
            <button class="button button--primary button--sm" data-act="confirm-custom" data-path="${escapeHtml(pendingCustomPath)}"${maintenance.kind !== "idle" ? " disabled" : ""}>Use this folder</button>
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
          <div class="runtime-status-title">
            <strong>${escapeHtml(runtimeLabel(runtime.backend))} runtime is ready</strong>
            <span class="model-badge ok">Ready</span>
          </div>
          <p>Installed at <code>${escapeHtml(runtime.path)}</code></p>
        </div>` : `
        <div class="runtime-status recommended">
          <div class="runtime-status-title">
            <strong>${escapeHtml(runtimeLabel(recommendedRuntime))}</strong>
            <span class="model-badge rec">Recommended for this system</span>
          </div>
          <p>${escapeHtml(runtime.recommendation)}</p>
          <div class="runtime-install-action">
            <button class="button button--primary" type="button" data-act="install-runtime" data-backend="${escapeHtml(recommendedRuntime)}">Install recommended runtime</button>
          </div>
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

  const downloadInProgress = progress && ["preparing", "downloading", "verifying"].includes(progress.state)
    ? `Finish downloading ${bundleDisplayName(progress.bundleId)} first.`
    : null;
  const blockingActivity = maintenance.kind === "activating" && activationBundleName
    ? `Activating ${activationBundleName}...`
    : downloadInProgress;
  const startReason = startBlockedReason(scan, runtime.installed, blockingActivity);
  const navigationReason = step === "credits" && !termsAccepted
    ? "Accept the model terms to continue."
    : step === "models"
      ? startReason
      : null;
  root.setAttribute(
    "aria-labelledby",
    step === "welcome" ? "model-setup-title" : step === "runtime" ? "runtime-setup-title" : step === "credits" ? "model-credits-title" : "model-bundle-title",
  );
  root.innerHTML = `
    <div class="onboarding-shell onboarding-shell--${step}">
      ${showWelcome ? `
        <nav class="onboarding-progress" aria-label="Onboarding progress">
          <span${step === "welcome" ? ' aria-current="step"' : ""}>Welcome</span>
          <span${step === "credits" ? ' aria-current="step"' : ""}>Credits</span>
          <span${step === "runtime" ? ' aria-current="step"' : ""}>Runtime</span>
          <span${step === "models" ? ' aria-current="step"' : ""}>Ready</span>
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
        <div class="onboarding-nav-back">
          ${step !== "welcome" && showWelcome ? '<button class="button button--secondary" type="button" data-act="previous-step">Previous</button>' : ""}
        </div>
        <div class="onboarding-nav-action">
          ${navigationReason ? `<span id="onboarding-action-reason" class="onboarding-nav-reason" role="status">${escapeHtml(navigationReason)}</span>` : ""}
          ${step === "welcome" ? '<button class="button button--primary" type="button" data-act="next-step">Next</button>' : ""}
          ${step === "credits" ? `<button class="button button--primary" type="button" data-act="next-step"${termsAccepted ? "" : ' disabled aria-describedby="onboarding-action-reason"'}>Next</button>` : ""}
          ${step === "runtime" && runtime.installed ? '<button class="button button--primary" type="button" data-act="next-step">Next</button>' : ""}
          ${step === "models" ? `<button class="button button--primary" type="button" data-act="start"${startReason ? ' disabled aria-describedby="onboarding-action-reason"' : ""}>Start Triastasis</button>` : ""}
        </div>
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

function renderActivationStatus(message: string, isError: boolean): string {
  return `
    <div class="model-progress${isError ? " model-progress--failed" : ""}" role="${isError ? "alert" : "status"}">
      <strong>${escapeHtml(message)}</strong>
      ${isError ? "<p><span>The bundle remains installed. Check that another Triastasis instance is not running, then try activation again. Technical details are saved in the app logs.</span></p>" : ""}
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

function renderLegacyPanel(scan: ModelsScan, actionsDisabled: boolean): string {
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
        <button class="button button--primary button--sm" data-act="download" data-id="${escapeHtml(legacy.bundleId)}"${actionsDisabled ? " disabled" : ""}>Download managed bundle</button>
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
        act === "use" ||
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
          act === "verify"
            ? "Verifying..."
            : act === "resume"
              ? "Resuming..."
              : act === "use" || act === "use-custom" || act === "confirm-custom"
                ? "Activating..."
                : "Starting...";
        btn.setAttribute("aria-busy", "true");
      }
      try {
        if (act === "next-step") {
          const next = nextOnboardingStep(
            onboardingStep,
            curatedModelTermsAccepted(),
            runtime.installed,
          );
          if (next === onboardingStep) {
            refreshAfterAction = false;
            return;
          }
          onboardingStep = next;
        } else if (act === "previous-step") {
          onboardingStep = previousOnboardingStep(onboardingStep);
        } else if (act === "start") {
          const reason = startBlockedReason(
            scan,
            runtime.installed,
            modelMaintenanceSnapshot().kind === "activating" ? "Finish model activation first." : null,
          );
          if (reason) {
            showMessage(root, reason, true);
            refreshAfterAction = false;
            return;
          }
          markOnboardingCompleted();
        } else if (act === "install-runtime") {
          const backend = btn.dataset.backend || runtime.recommendedBackend;
          runtimeInstallInProgress = true;
          root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((control) => {
            control.disabled = true;
          });
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
          showMessage(root, `Activating ${bundleDisplayName(id)}...`, false);
          await activateManagedBundle(id);
        }
      } catch (e) {
        showMessage(root, (e as Error).message || String(e), true);
        refreshAfterAction = false;
      } finally {
        if (act === "install-runtime") {
          runtimeInstallInProgress = false;
          root.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((control) => {
            control.disabled = false;
          });
        }
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
  subscribeModelDownloads(handleDownloadStateChange);
  subscribeModelMaintenance((maintenance) => {
    if (maintenance.kind === "idle") handleDownloadStateChange();
    else void refreshModelSetup();
  });
  window.setInterval(() => void refreshModelSetup(), 10000);
}
