// Shared download-state store + human-readable formatting for the model
// manager. UI modules subscribe here instead of talking to events directly so
// the setup screen and Settings stay in sync.

import {
  fetchCatalog,
  onDownloadProgress,
  scanPartialDownloads,
  type BundleSummary,
  type DownloadProgress,
} from "./model-catalog";

export interface ModelDownloadSnapshot {
  progress: DownloadProgress | null;
  /** Interrupted downloads found on disk (restart recovery). */
  partial: string[];
  catalog: BundleSummary[];
}

type Listener = (snapshot: ModelDownloadSnapshot) => void;

let snapshot: ModelDownloadSnapshot = { progress: null, partial: [], catalog: [] };
const listeners = new Set<Listener>();
let initialized = false;

export function startingDownloadProgress(
  bundleId: string,
  totalBytes: number,
): DownloadProgress {
  return {
    bundleId,
    state: "preparing",
    error: null,
    fileName: null,
    fileIndex: 0,
    fileCount: 0,
    fileBytesDone: 0,
    fileBytesTotal: 0,
    totalBytesDone: 0,
    totalBytesTotal: totalBytes,
    bytesPerSecond: 0,
    etaSeconds: null,
  };
}

export function failedDownloadProgress(
  previous: DownloadProgress,
  error: string,
): DownloadProgress {
  return {
    ...previous,
    state: "failed",
    error,
    bytesPerSecond: 0,
    etaSeconds: null,
  };
}

export function modelDownloadSnapshot(): ModelDownloadSnapshot {
  return snapshot;
}

export function subscribeModelDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const copy = snapshot;
  listeners.forEach((listener) => listener(copy));
}

/** Show feedback synchronously while the native worker is being scheduled. */
export function markDownloadStarting(bundleId: string): void {
  const totalBytes = snapshot.catalog.find((bundle) => bundle.id === bundleId)?.totalBytes ?? 0;
  snapshot = { ...snapshot, progress: startingDownloadProgress(bundleId, totalBytes) };
  emit();
}

/** Preserve an invoke failure in the shared UI instead of reverting to idle. */
export function markDownloadFailed(bundleId: string, error: string): void {
  const current = snapshot.progress?.bundleId === bundleId
    ? snapshot.progress
    : startingDownloadProgress(bundleId, 0);
  snapshot = { ...snapshot, progress: failedDownloadProgress(current, error) };
  emit();
}

export function clearDownloadProgress(bundleId: string): void {
  if (snapshot.progress?.bundleId !== bundleId) return;
  snapshot = { ...snapshot, progress: null };
  emit();
}

/** Idempotent bootstrapping: event subscription + initial partial/catalog scan. */
export async function initModelDownloadState(isTauriEnv: boolean): Promise<void> {
  if (!isTauriEnv || initialized) return;
  initialized = true;
  await onDownloadProgress((progress) => {
    snapshot = { ...snapshot, progress };
    emit();
    if (progress.state === "ready") void refreshPartialDownloads();
  });
  await refreshPartialDownloads();
}

export async function refreshPartialDownloads(): Promise<void> {
  try {
    const [partial, catalog] = await Promise.all([
      scanPartialDownloads(),
      snapshot.catalog.length ? Promise.resolve(snapshot.catalog) : fetchCatalog(),
    ]);
    snapshot = { ...snapshot, partial, catalog };
    emit();
  } catch {
    /* native shell unavailable */
  }
}

// ---- formatting ---------------------------------------------------------------

export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1e3) return `${(bytesPerSecond / 1e3).toFixed(0)} kB/s`;
  return `${bytesPerSecond} B/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
