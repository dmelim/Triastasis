// Bundle recommendation and shared actions for model management (Phases 3-4).
// The recommendation never selects or downloads anything on its own; it only
// labels one bundle "Recommended for this system" and explains uncertainty.

import { invoke } from "./tauri";
import { loadConfig, saveConfig } from "./config";
import {
  clearDownloadProgress,
  markDownloadFailed,
  markDownloadStarting,
  refreshPartialDownloads,
} from "./model-download-state";
import {
  activateCustomModelDirectory,
  activateModelBundle,
  cancelModelDownload,
  discardModelDownload,
  freeDiskSpace,
  forgetCustomModelDirectory,
  pauseModelDownload,
  removeModelBundle,
  startModelDownload,
  verifyModelBundle,
} from "./model-catalog";

export interface NativeHardwareInfo {
  backend: string;
  gpuIndex: number;
  gpuName: string | null;
  vramMb: number | null;
}

/** Read the native hardware probe without the generation-resolution logic. */
export async function detectNativeHardware(): Promise<NativeHardwareInfo | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  try {
    const info = await invoke<NativeHardwareInfo>("detect_hardware_info");
    return info ?? null;
  } catch {
    return null;
  }
}

export interface BundleRecommendation {
  bundleId: string;
  /** False when hardware could not be detected well enough to be sure. */
  confident: boolean;
  reason: string;
}

/**
 * Recommend a quality tier from detected VRAM:
 * - under ~8 GB VRAM (or unknown) -> Starter / Recommended respectively
 * - 8-16 GB -> Recommended
 * - above 16 GB -> Recommended, noting Full precision fits comfortably
 */
export function recommendBundle(vramMb: number | null | undefined): BundleRecommendation {
  if (vramMb == null || vramMb <= 0) {
    return {
      bundleId: "trellis2-q8",
      confident: false,
      reason: "No supported GPU was detected, so the balanced default is suggested.",
    };
  }
  if (vramMb < 8000) {
    return {
      bundleId: "trellis2-q4",
      confident: true,
      reason: `${Math.round(vramMb / 1024)} GB of GPU memory is below the recommended tier's comfortable range.`,
    };
  }
  if (vramMb >= 16000) {
    return {
      bundleId: "trellis2-q8",
      confident: true,
      reason: `${Math.round(vramMb / 1024)} GB of GPU memory also fits Full precision if you prefer it.`,
    };
  }
  return {
    bundleId: "trellis2-q8",
    confident: true,
    reason: `${Math.round(vramMb / 1024)} GB of GPU memory suits this tier.`,
  };
}

/** Warn when a selection is unlikely to run reliably on this system. */
export function selectionWarning(bundleId: string, vramMb: number | null | undefined): string | null {
  if (vramMb == null || vramMb <= 0) return null;
  if (bundleId !== "trellis2-f16" && vramMb < 8000 && bundleId === "trellis2-q8") {
    return "This GPU may not have enough memory for the Recommended tier. Starter is safer.";
  }
  if (bundleId === "trellis2-f16" && vramMb < 16000) {
    return "Full precision usually needs 16 GB or more of GPU memory.";
  }
  return null;
}

// ---- configuration ---------------------------------------------------------

/**
 * Persist the managed models root before downloading. The server is not
 * restarted here: nothing is active yet.
 */
export async function setModelsRoot(modelsRoot: string): Promise<void> {
  await loadConfig(true);
  await saveConfig({ modelsRoot });
}

export async function currentModelsRoot(fallback: string): Promise<string> {
  const cfg = await loadConfig(true);
  const root = cfg.modelsRoot.trim();
  return root || fallback;
}

// ---- actions ------------------------------------------------------------------

export async function downloadBundle(bundleId: string): Promise<void> {
  markDownloadStarting(bundleId);
  try {
    await startModelDownload(bundleId);
  } catch (error) {
    const message = (error as Error).message || String(error);
    markDownloadFailed(bundleId, message);
    throw error;
  }
}

export async function pauseBundle(): Promise<void> {
  await pauseModelDownload();
}

export async function cancelBundle(): Promise<void> {
  await cancelModelDownload();
}

export async function stopFailedBundle(bundleId: string): Promise<void> {
  await discardModelDownload(bundleId);
  clearDownloadProgress(bundleId);
  await refreshPartialDownloads();
}

export async function verifyAndRegister(bundleId: string): Promise<void> {
  await verifyModelBundle(bundleId);
}

export async function activateBundle(bundleId: string): Promise<void> {
  await activateModelBundle(bundleId);
  await loadConfig(true);
}

export async function activateCustomBundle(path: string): Promise<void> {
  await activateCustomModelDirectory(path);
  await loadConfig(true);
}

export async function forgetCustomBundle(): Promise<void> {
  await forgetCustomModelDirectory();
  await loadConfig(true);
}

export async function removeBundle(bundleId: string): Promise<void> {
  await removeModelBundle(bundleId);
}

export async function discardPartial(bundleId: string): Promise<void> {
  await discardModelDownload(bundleId);
}

export async function availableBytes(path: string): Promise<number | null> {
  try {
    return await freeDiskSpace(path);
  } catch {
    return null;
  }
}
