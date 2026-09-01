import { invoke } from "./tauri";

export interface RuntimeStatus {
  installed: boolean;
  backend: string;
  path: string;
  portable: boolean;
  recommendedBackend: string;
  recommendation: string;
}

export function scanRuntime(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("runtime_status");
}

export function installRuntime(backend: string): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("install_runtime", { backend });
}

export function runtimeLabel(backend: string): string {
  if (backend === "cuda12") return "CUDA 12 compatibility";
  if (backend === "cuda") return "CUDA";
  if (backend === "rocm") return "ROCm";
  return "Vulkan";
}