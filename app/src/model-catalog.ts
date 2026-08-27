// Typed bridge over the native model-management commands (Phases 1-2 of
// docs/model-installation-plan.md). All commands are Tauri-only; callers must
// guard with isTauri().

import { invoke, listen } from "./tauri";

export interface BundleSummary {
  id: string;
  displayName: string;
  quantization: string;
  fileCount: number;
  totalBytes: number;
}

export interface ManagedBundleState {
  bundleId: string;
  quantization: string;
  dir: string;
  registered: boolean;
  sizedFiles: number;
  totalFiles: number;
}

export type LegacyStatus =
  | "completeUnverified"
  | "incomplete"
  | "unrecognized"
  | "empty";

export interface LegacyMatch {
  status: LegacyStatus;
  bundleId: string | null;
  matchedFiles: number;
  totalFiles: number;
  unrecognizedFiles: number;
}

export interface ModelsScan {
  modelsRoot: string;
  modelsDir: string;
  portable: boolean;
  activeBundle: string | null;
  managed: ManagedBundleState[];
  legacy: LegacyMatch | null;
  freeBytes: number | null;
  catalogVersion: number;
  modelRevision: string;
}

export type DownloadState =
  | "preparing"
  | "downloading"
  | "paused"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled";

export interface DownloadProgress {
  bundleId: string;
  state: DownloadState;
  fileName: string | null;
  fileIndex: number;
  fileCount: number;
  fileBytesDone: number;
  fileBytesTotal: number;
  totalBytesDone: number;
  totalBytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface DownloadStatusInfo {
  bundleId: string | null;
  state: DownloadState;
  error: string | null;
}

// ---- catalog + detection ----------------------------------------------------

/** The bundled, pinned model catalog (bundle list with sizes). */
export function fetchCatalog(): Promise<BundleSummary[]> {
  return invoke<BundleSummary[]>("model_catalog");
}

/** Launch-time detection: managed installs, legacy layout, free space. */
export function scanModels(): Promise<ModelsScan> {
  return invoke<ModelsScan>("scan_models");
}

export function freeDiskSpace(path: string): Promise<number> {
  return invoke<number>("free_disk_space", { path });
}

/** Full size+SHA-256 verification; writes the installation commit marker. */
export function verifyModelBundle(bundleId: string): Promise<string> {
  return invoke<string>("verify_model_bundle", { bundleId });
}

// ---- downloads ----------------------------------------------------------------

/** Start or resume a download; returns immediately, progress via events. */
export function startModelDownload(bundleId: string): Promise<void> {
  return invoke<void>("start_model_download", { bundleId });
}

export function pauseModelDownload(): Promise<void> {
  return invoke<void>("pause_model_download");
}

export function cancelModelDownload(): Promise<void> {
  return invoke<void>("cancel_model_download");
}

export function modelDownloadStatus(): Promise<DownloadStatusInfo | null> {
  return invoke<DownloadStatusInfo | null>("model_download_status");
}

/** Interrupted downloads found in the managed root. */
export function scanPartialDownloads(): Promise<string[]> {
  return invoke<string[]>("scan_partial_downloads");
}

/** Discard one interrupted download's partial files. */
export function discardModelDownload(bundleId: string): Promise<void> {
  return invoke<void>("discard_model_download", { bundleId });
}

// ---- activation + removal -------------------------------------------------------

/** Point the server at a verified bundle and restart it. */
export function activateModelBundle(bundleId: string): Promise<void> {
  return invoke<void>("activate_model_bundle", { bundleId });
}

/** Remove an installed but inactive bundle. */
export function removeModelBundle(bundleId: string): Promise<void> {
  return invoke<void>("remove_model_bundle", { bundleId });
}

/** Subscribe to native download progress events (noop in browser). */
export function onDownloadProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<() => void> {
  return listen<DownloadProgress>("model-download-progress", handler);
}
