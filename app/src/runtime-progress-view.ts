import { onRuntimeProgress, type RuntimeProgress } from "./runtime-manager";
import { runtimeProgressFraction, runtimeProgressLabel } from "./runtime-presentation";
import { createDownloadProgressView, type DownloadProgressViewState } from "./download-progress-view";
import { formatEta, formatSpeed } from "./model-download-state";

export function runtimeProgressViewState(progress: RuntimeProgress, bytesPerSecond = 0): DownloadProgressViewState {
  const fraction = runtimeProgressFraction(progress);
  if (progress.phase !== "download") return {
    fraction: null,
    summary: runtimeProgressLabel(progress),
    detail: progress.phase === "verify" ? "Checking the SHA-256 checksum..." : "Installing the verified runtime files...",
  };
  const megabytes = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString("en-US")} MB`;
  const percentage = fraction === null ? "Downloading runtime..." : `${Math.floor(fraction * 100)}%`;
  const eta = fraction !== null && bytesPerSecond > 0 ? Math.max(0, progress.total - progress.downloaded) / bytesPerSecond : null;
  return {
    fraction,
    summary: bytesPerSecond > 0
      ? `${percentage}, ${formatSpeed(bytesPerSecond)}${eta === null ? "" : `, ${formatEta(eta)} remaining`}`
      : percentage,
    detail: `${megabytes(progress.downloaded)}${progress.total > 0 ? ` of ${megabytes(progress.total)}` : ""}`,
  };
}

/**
 * Show live runtime download progress in `container` while `task` runs. The
 * listener is ready before the task starts; the view is removed when it settles.
 */
export async function withRuntimeProgress<T>(container: HTMLElement, task: () => Promise<T>): Promise<T> {
  const view = typeof document !== "undefined" && typeof document.createElement === "function"
    ? createDownloadProgressView(container, "Runtime download progress") : null;
  let unlisten = () => {};
  try {
    if (view) {
      let previous: { downloaded: number; time: number } | null = null;
      unlisten = await onRuntimeProgress((progress) => {
        const time = performance.now();
        const speed = previous && progress.phase === "download" && time > previous.time
          ? Math.max(0, (progress.downloaded - previous.downloaded) / ((time - previous.time) / 1000)) : 0;
        previous = progress.phase === "download" ? { downloaded: progress.downloaded, time } : null;
        view.update(runtimeProgressViewState(progress, speed));
      });
    }
    return await task();
  } finally {
    unlisten();
    view?.remove();
  }
}
