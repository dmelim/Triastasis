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
  availableBytes,
  cancelBundle,
  discardPartial,
  downloadBundle,
  pauseBundle,
  removeBundle,
  verifyAndRegister,
} from "./model-manager";

let storageMessage: { text: string; error: boolean } | null = null;

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
  let scan: ModelsScan;
  try {
    scan = await scanModels();
  } catch (e) {
    container.innerHTML = `<p class="settings-error">Model information unavailable: ${escapeHtml((e as Error).message)}</p>`;
    return;
  }
  const snapshot = modelDownloadSnapshot();
  const catalog = snapshot.catalog.length ? snapshot.catalog : [];
  const progress = snapshot.progress;

  const free = await availableBytes(scan.modelsRoot);
  const used = scan.managed.reduce((sum, m) => {
    const summary = catalog.find((b) => b.id === m.bundleId);
    return sum + (summary?.totalBytes ?? 0);
  }, 0);

  if (!catalog.length) {
    container.innerHTML = `<p class="settings-error">Model catalog unavailable.</p>`;
    return;
  }

  const rows = catalog
    .map((bundle) => {
      const managed = scan.managed.find((m) => m.bundleId === bundle.id);
      const isActive = scan.activeBundle === bundle.id;
      const downloading =
        progress?.bundleId === bundle.id &&
        ["preparing", "downloading", "verifying"].includes(progress.state);

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
      } else if (isActive) {
        statusLine = "Installed and active";
        actions = `<button class="button button--secondary button--sm" data-act="verify" data-id="${bundle.id}">Verify files</button>`;
      } else if (managed?.registered) {
        statusLine = `Installed (${escapeHtml(managed.dir)})`;
        actions = `
          <button class="button button--primary button--sm" data-act="use" data-id="${bundle.id}">Use this bundle</button>
          <button class="button button--secondary button--sm" data-act="remove" data-id="${bundle.id}">Remove</button>`;
      } else if (progress?.bundleId === bundle.id && progress.state === "paused") {
        statusLine = "Download paused";
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Resume</button>
          <button class="button button--secondary button--sm" data-act="discard-partial" data-id="${bundle.id}">Discard download</button>`;
      } else if (managed) {
        statusLine = `Incomplete (${managed.sizedFiles} of ${managed.totalFiles} files)`;
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Download missing files</button>
          <button class="button button--secondary button--sm" data-act="discard-partial" data-id="${bundle.id}">Discard partial files</button>`;
      } else {
        statusLine = "Not installed";
        actions = `<button class="button button--primary button--sm" data-act="download" data-id="${bundle.id}">Download</button>`;
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

  container.innerHTML = `
    <div class="model-storage">
      <div class="settings-meta-grid settings-field-wide">
        <div class="settings-meta-item"><span>Storage location</span><strong>${escapeHtml(scan.modelsRoot)}</strong></div>
        <div class="settings-meta-item"><span>Available space</span><strong>${free != null ? escapeHtml(formatGigabytes(free)) : "-"}</strong></div>
        <div class="settings-meta-item"><span>Estimated model storage used</span><strong>${escapeHtml(formatGigabytes(used))}</strong></div>
        <div class="settings-meta-item"><span>Model revision</span><strong>${escapeHtml(scan.modelRevision.slice(0, 12))}</strong></div>
      </div>
      <div class="bundle-list">${rows}</div>
      ${storageMessageHtml()}
    </div>`;

  container.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id ?? "";
      btn.disabled = true;
      let rerender = true;
      try {
        storageMessage = null;
        if ((act === "remove" || act === "discard-partial") && btn.dataset.confirm !== "true") {
          btn.dataset.confirm = "true";
          btn.textContent = act === "remove" ? "Confirm removal" : "Confirm discard";
          rerender = false;
          return;
        }
        if (act === "use") await activateBundle(id);
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
  subscribeModelDownloads(() => {
    document
      .querySelectorAll<HTMLElement>("#settings-model-storage")
      .forEach((el) => void renderModelStorage(el));
  });
}
