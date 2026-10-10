import { invoke, listen } from "./tauri";

export interface RuntimeStatus {
  installed: boolean;
  managed: boolean;
  version: string | null;
  versionState: "current" | "older" | "newer" | "unknown";
  releaseUrl: string;
  targetVersion: string;
  updateAvailable: boolean;
  pendingVersion: string | null;
  pendingPath: string | null;
  backend: string;
  path: string;
  portable: boolean;
  recommendedBackend: string;
  recommendation: string;
}

/** Payload of `runtime-download-progress`; `total` is 0 when the size is unknown. */
export interface RuntimeProgress {
  phase: "download" | "verify" | "extract";
  downloaded: number;
  total: number;
}

/** Subscribe to runtime download progress (noop in the browser). */
export function onRuntimeProgress(handler: (progress: RuntimeProgress) => void): Promise<() => void> {
  return listen<RuntimeProgress>("runtime-download-progress", handler);
}

export function scanRuntime(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_status");
}

export function installRuntime(backend: string): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("install_runtime", { backend });
}

export function updateRuntime(backend: string): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("update_runtime", { backend });
}

export function runtimeLabel(backend: string): string {
  if (backend === "unknown") return "Unknown backend";
  if (backend === "cuda12") return "CUDA 12 compatibility";
  if (backend === "cuda") return "CUDA";
  if (backend === "rocm") return "ROCm";
  return "Vulkan";
}