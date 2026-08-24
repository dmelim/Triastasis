import { invoke, isTauri } from "./tauri";

export type GenerationResolution = 512 | 1024 | 1536;

export interface NativeHardwareInfo {
  backend: string;
  gpuIndex: number;
  gpuName: string | null;
  vramMb: number | null;
}

export interface GenerationHardwareProfile extends NativeHardwareInfo {
  recommendedMaxResolution: GenerationResolution;
}

export const HARDWARE_OVERRIDE_KEY = "polyloom.allow-generation-above-recommendation";

export function recommendedMaxResolution(
  vramMb: number | null,
  gpuIndex = 0,
): GenerationResolution {
  if (gpuIndex < 0) return 512;
  if (vramMb === null) return 1024;
  if (vramMb < 8192) return 512;
  if (vramMb < 16384) return 1024;
  return 1536;
}

export function allowsGenerationAboveRecommendation(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(HARDWARE_OVERRIDE_KEY) === "1";
}

export function setAllowsGenerationAboveRecommendation(allowed: boolean): void {
  localStorage.setItem(HARDWARE_OVERRIDE_KEY, allowed ? "1" : "0");
}

export function resolutionAllowed(
  resolution: GenerationResolution,
  profile: GenerationHardwareProfile,
  override = allowsGenerationAboveRecommendation(),
): boolean {
  return override || resolution <= profile.recommendedMaxResolution;
}

export function describeHardware(profile: GenerationHardwareProfile): string {
  if (profile.gpuIndex < 0) return "CPU mode";
  if (profile.gpuName && profile.vramMb !== null) {
    const vramGb = Math.round((profile.vramMb / 1024) * 10) / 10;
    return `${profile.gpuName}, ${vramGb} GB VRAM`;
  }
  if (profile.gpuName) return profile.gpuName;
  return "GPU memory not detected";
}

export async function detectGenerationHardware(): Promise<GenerationHardwareProfile> {
  let info: NativeHardwareInfo = {
    backend: isTauri() ? "unknown" : "browser",
    gpuIndex: 0,
    gpuName: null,
    vramMb: null,
  };
  if (isTauri()) {
    try {
      info = await invoke<NativeHardwareInfo>("detect_hardware_info");
    } catch {
      // Unknown hardware uses a conservative 1024 recommendation.
    }
  }
  return {
    ...info,
    recommendedMaxResolution: recommendedMaxResolution(info.vramMb, info.gpuIndex),
  };
}
