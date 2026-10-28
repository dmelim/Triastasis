export interface DownloadProgressViewState {
  fraction: number | null;
  summary: string;
  detail: string;
}

function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function downloadProgressFraction(fraction: number | null): number | null {
  return fraction === null || !Number.isFinite(fraction) ? null : Math.max(0, Math.min(1, fraction));
}

/** Native progress values work under the desktop CSP without inline styles. */
export function downloadProgressHtml(state: DownloadProgressViewState, label: string): string {
  const fraction = downloadProgressFraction(state.fraction);
  return `<div class="model-progress" role="status" aria-label="${escapeText(label)}">
    <progress class="model-progress-bar" max="1"${fraction === null ? "" : ` value="${fraction}"`} aria-label="${escapeText(label)}"></progress>
    <p data-download-summary>${escapeText(state.summary)}</p>
    <span data-download-detail>${escapeText(state.detail)}</span>
  </div>`;
}

export function createDownloadProgressView(container: HTMLElement, label: string) {
  const view = document.createElement("div");
  view.innerHTML = downloadProgressHtml({ fraction: null, summary: "Starting download...", detail: "Contacting the release server..." }, label);
  const root = view.firstElementChild as HTMLElement;
  container.append(root);
  const bar = root.querySelector<HTMLProgressElement>("progress")!;
  const summary = root.querySelector<HTMLElement>("[data-download-summary]")!;
  const detail = root.querySelector<HTMLElement>("[data-download-detail]")!;
  return {
    update(state: DownloadProgressViewState) {
      const fraction = downloadProgressFraction(state.fraction);
      if (fraction === null) bar.removeAttribute("value");
      else bar.value = fraction;
      summary.textContent = state.summary;
      detail.textContent = state.detail;
    },
    remove() { root.remove(); },
  };
}
