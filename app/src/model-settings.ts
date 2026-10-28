// Model management inside Settings (Phase 4): installed/active bundles,
// additional downloads, safe switching, verify/remove, storage overview.

import { type ModelsScan, scanModels } from "./model-catalog";
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
  discardPartial,
  downloadBundle,
  forgetCustomBundle,
  modelMaintenanceSnapshot,
  pauseBundle,
  removeBundle,
  resetIncompleteBundle,
  subscribeModelMaintenance,
  verifyAndRegister,
  verifyLocalBundle,
} from "./model-manager";
import { localCatalogBundle, modelStorageBytes } from "./model-discovery";
import {
  bindCuratedModelTerms,
  curatedModelTermsHtml,
} from "./model-terms";
import { pickDirectory } from "./tauri";

let storageMessage: { text: string; error: boolean } | null = null;
let pendingCustomDirectory: string | null = null;
const storageRenderRequests = new WeakMap<HTMLElement, number>();

function storageMessageHtml(): string {
  if (!storageMessage) return "";
  return `<p class="${storageMessage.error ? "settings-error" : "model-note"}" role="status">${escapeHtml(storageMessage.text)}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function renderModelStorage(container: HTMLElement | null): Promise<void> {
  if (!container) return;
  const request = (storageRenderRequests.get(container) ?? 0) + 1;
  storageRenderRequests.set(container, request);
  let scan: ModelsScan;
  try {
    scan = await scanModels();
  } catch (e) {
    if (storageRenderRequests.get(container) !== request) return;
    container.innerHTML = `<p class="settings-error">Model information unavailable: ${escapeHtml((e as Error).message)}</p>`;
    return;
  }
  const snapshot = modelDownloadSnapshot();
  const catalog = snapshot.catalog.length ? snapshot.catalog : [];
  const progress = snapshot.progress;
  const maintenance = modelMaintenanceSnapshot();
  const modelActionsDisabled = maintenance.kind !== "idle";

  const free = await availableBytes(scan.modelsRoot);
  if (storageRenderRequests.get(container) !== request) return;
  const used = modelStorageBytes(scan, catalog);

  if (!catalog.length) {
    container.innerHTML = `<p class="settings-error">Model catalog unavailable.</p>`;
    return;
  }

  const rows = catalog
    .map((bundle) => {
      const managed = scan.managed.find((m) => m.bundleId === bundle.id);
      const local = localCatalogBundle(scan, bundle.id);
      const useLocal = local && (local.active || !managed?.registered);
      const isActive = local?.active || scan.activeBundle === bundle.id;
      const downloading =
        progress?.bundleId === bundle.id &&
        ["preparing", "downloading", "verifying"].includes(progress.state);
      const hasInterruptedDownload =
        snapshot.partial.includes(bundle.id) ||
        (progress?.bundleId === bundle.id && progress.state === "failed");

      let statusLine: string;
      let actions = "";
      if (downloading && progress) {
        const pct = progress.totalBytesTotal
          ? Math.min(100, Math.round((progress.totalBytesDone / progress.totalBytesTotal) * 100))
          : 0;
        statusLine = `Downloading · ${pct}% · ${formatSpeed(progress.bytesPerSecond)} · ${formatEta(progress.etaSeconds)} left`;
        actions = `
          <button class="button button--secondary button--sm" data-act="pause">Pause</button>
          <button class="button button--secondary button--sm" data-act="cancel">Cancel</button>`;
      } else if (useLocal) {
        statusLine = `${local.verified ? "Verified catalog files" : "Catalog bundle found; verification required"} · ${escapeHtml(local.dir)}`;
        actions = `${!local.active && local.verified ? `<button class="button button--primary button--sm" data-act="use-local" data-id="${bundle.id}" data-path="${escapeHtml(local.dir)}">Use this bundle</button>` : ""}
          <button class="button button--secondary button--sm" data-act="verify-local" data-id="${bundle.id}" data-path="${escapeHtml(local.dir)}">Verify files</button>`;
      } else if (isActive && managed?.registered) {
        statusLine = "Installed and active";
        actions = `<button class="button button--secondary button--sm" data-act="verify" data-id="${bundle.id}">Verify files</button>`;
      } else if (managed?.registered) {
        statusLine = `Installed (${escapeHtml(managed.dir)})`;
        actions = `
          <button class="button button--primary button--sm" data-act="use" data-id="${bundle.id}">Use this bundle</button>
          <button class="button button--secondary button--sm" data-act="remove" data-id="${bundle.id}">Remove</button>`;
      } else if (managed && managed.totalFiles > 0 && managed.sizedFiles === managed.totalFiles) {
        statusLine = "All files present, verification required";
        actions = `
          <button class="button button--primary button--sm" data-act="verify" data-id="${bundle.id}">Verify and register</button>
          <button class="button button--secondary button--sm" data-act="remove" data-id="${bundle.id}">Remove files</button>`;
      } else if (progress?.bundleId === bundle.id && progress.state === "paused") {
        statusLine = "Download paused";
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Resume</button>
          <button class="button button--secondary button--sm" data-act="discard-partial" data-id="${bundle.id}">Discard download</button>`;
      } else if (managed || hasInterruptedDownload) {
        statusLine = managed
          ? `Incomplete (${managed.sizedFiles} of ${managed.totalFiles} files). Existing files will be verified before missing data is downloaded.`
          : "Incomplete download found. Existing data will be verified before the download resumes.";
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Verify and resume</button>
          <button class="button button--secondary button--sm" data-act="reset-incomplete" data-id="${bundle.id}">Delete incomplete files</button>`;
      } else {
        statusLine = "Not installed";
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Download</button>`;
      }

      if (modelActionsDisabled) {
        actions = actions.replaceAll("<button ", "<button disabled ");
        if (maintenance.bundleId === bundle.id) statusLine = `${maintenance.kind === "verifying" ? "Verifying" : "Activating"} ${escapeHtml(bundle.displayName)}...`;
      }

      return `
        <div class="bundle-row${isActive ? " active" : ""}">
          <div class="bundle-row-main">
            <strong>${escapeHtml(bundle.displayName)}${isActive ? ' <span class="model-badge ok">Active</span>' : ""}</strong>
            <span>${escapeHtml(statusLine)}</span>
          </div>
          <div class="bundle-actions">${actions}</div>
        </div>`;
    })
    .join("");
  const custom = scan.custom;
  const customActive = custom?.bundleId === scan.activeBundle;
  const customRow = custom
    ? `
      <div class="bundle-row${customActive ? " active" : ""}">
        <div class="bundle-row-main">
          <strong>Custom model folder <span class="model-badge custom">Unverified custom bundle</span>${customActive ? ' <span class="model-badge ok">Active</span>' : ""}</strong>
          <span>${custom.available
            ? `${escapeHtml(custom.dir)} (${custom.ggufFiles} readable GGUF file${custom.ggufFiles === 1 ? "" : "s"})`
            : escapeHtml(custom.error || "Folder unavailable")}</span>
        </div>
        <div class="bundle-actions">
          ${custom.available && !customActive
            ? `<button class="button button--primary button--sm" data-act="use-custom" data-path="${escapeHtml(custom.dir)}"${modelActionsDisabled ? " disabled" : ""}>Use this folder</button>`
            : ""}
          ${!customActive
            ? `<button class="button button--secondary button--sm" data-act="forget-custom">Forget</button>`
            : ""}
        </div>
      </div>`
    : "";
  const customImport = `
    <div class="custom-model-import">
      <button class="button button--secondary button--sm" data-act="pick-custom">
        ${custom ? "Choose a different model folder" : "Choose existing model folder"}
      </button>
      ${pendingCustomDirectory ? `
        <div class="custom-model-confirm" role="alert" aria-labelledby="settings-custom-warning-title">
          <strong id="settings-custom-warning-title">Use model files from this folder?</strong>
          <p>The files stay in their current location. Triastasis recognizes catalog bundles and can verify their checksums. Other model files are user-provided and may be incompatible or incorrectly licensed.</p>
          <code>${escapeHtml(pendingCustomDirectory)}</code>
          <div class="custom-model-confirm-actions">
            <button class="button button--primary button--sm" data-act="confirm-custom" data-path="${escapeHtml(pendingCustomDirectory)}"${modelActionsDisabled ? " disabled" : ""}>Use this folder</button>
            <button class="button button--secondary button--sm" data-act="cancel-custom">Cancel</button>
          </div>
        </div>` : ""}
    </div>`;

  container.innerHTML = `
    <div class="model-storage">
      <div class="settings-meta-grid settings-field-wide">
        <div class="settings-meta-item"><span>Download location</span><strong>${escapeHtml(scan.modelsRoot)}</strong></div>
        <div class="settings-meta-item"><span>Available space</span><strong>${free != null ? escapeHtml(formatGigabytes(free)) : "-"}</strong></div>
        <div class="settings-meta-item"><span>Estimated model storage used</span><strong>${escapeHtml(formatGigabytes(used))}</strong></div>
        <div class="settings-meta-item"><span>Model revision</span><strong>${escapeHtml(scan.modelRevision.slice(0, 12))}</strong></div>
      </div>
      ${curatedModelTermsHtml()}
      <div class="bundle-list">${rows}${customRow}</div>
      ${customImport}
      ${storageMessageHtml()}
    </div>`;

  bindCuratedModelTerms(container, () => void renderModelStorage(container));

  container.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id ?? "";
      btn.disabled = true;
      let rerender = true;
      try {
        storageMessage = null;
        if (
          (
            act === "remove" ||
            act === "discard-partial" ||
            act === "reset-incomplete" ||
            act === "forget-custom"
          ) &&
          btn.dataset.confirm !== "true"
        ) {
          btn.dataset.confirm = "true";
          btn.textContent =
            act === "remove"
              ? "Confirm removal"
              : act === "reset-incomplete"
                ? "Confirm deletion"
              : act === "forget-custom"
                ? "Confirm forget"
                : "Confirm discard";
          rerender = false;
          return;
        }
        if (act === "use") await activateBundle(id);
        if (act === "use-local") await activateBundle(id, btn.dataset.path);
        if (act === "verify-local") {
          await verifyLocalBundle(id, btn.dataset.path ?? "");
          storageMessage = { text: "Catalog checksums verified. The model files remain in their existing folder.", error: false };
        }
        if (act === "pick-custom") {
          const picked = await pickDirectory(custom?.dir || scan.modelsDir || scan.modelsRoot);
          if (picked) pendingCustomDirectory = picked;
        }
        if (act === "cancel-custom") pendingCustomDirectory = null;
        if (act === "confirm-custom" || act === "use-custom") {
          await activateCustomBundle(btn.dataset.path ?? "");
          pendingCustomDirectory = null;
          storageMessage = { text: "Existing model folder selected.", error: false };
        }
        if (act === "forget-custom") {
          await forgetCustomBundle();
          storageMessage = { text: "Custom folder forgotten. No model files were deleted.", error: false };
        }
        if (act === "verify") {
          await verifyAndRegister(id);
          storageMessage = { text: "All model files verified successfully.", error: false };
        }
        if (act === "remove") {
          await removeBundle(id);
          storageMessage = { text: "Model bundle removed.", error: false };
        }
        if (act === "download") await downloadBundle(id);
        if (act === "pause") await pauseBundle();
        if (act === "cancel") await cancelBundle();
        if (act === "discard-partial") {
          await discardPartial(id);
          storageMessage = { text: "Incomplete download discarded.", error: false };
        }
        if (act === "reset-incomplete") {
          await resetIncompleteBundle(id);
          storageMessage = {
            text: "Incomplete files deleted. Start the download again when ready.",
            error: false,
          };
        }
      } catch (e) {
        storageMessage = { text: (e as Error).message || String(e), error: true };
      } finally {
        btn.disabled = false;
        if (rerender) void renderModelStorage(container);
      }
    };
  });
}

let subscribed = false;

/** Keep any rendered Model storage section in sync with download events. */
export function subscribeModelStorageRefresh(): void {
  if (subscribed) return;
  subscribed = true;
  const refreshRenderedStorage = () => {
    document
      .querySelectorAll<HTMLElement>("#settings-model-storage")
      .forEach((el) => void renderModelStorage(el));
  };
  subscribeModelDownloads(refreshRenderedStorage);
  subscribeModelMaintenance(refreshRenderedStorage);
}
