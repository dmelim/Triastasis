import type { NormalizedGenParams } from "./types";

export type GenerationPreset = "low" | "medium" | "high";

type PresetSettings = Omit<NormalizedGenParams, "seed">;

export interface GenerationPresetDefinition {
  label: string;
  description: string;
  settings: PresetSettings;
}

export const GENERATION_PRESETS: Record<GenerationPreset, GenerationPresetDefinition> = {
  low: {
    label: "Low",
    description: "Faster generation with lighter geometry and compact textures.",
    settings: {
      resolution: 512,
      bgRemoval: "auto",
      uv: "box",
      targetFaces: "auto",
      texture: true,
      atlasSize: "auto",
      textureResolution: 512,
      remeshBand: "auto",
      textureEncoding: "webp",
    },
  },
  medium: {
    label: "Medium",
    description: "Recommended balance of detail, texture quality, and generation time.",
    settings: {
      resolution: 1024,
      bgRemoval: "auto",
      uv: "xatlas",
      targetFaces: "auto",
      texture: true,
      atlasSize: "auto",
      textureResolution: "auto",
      remeshBand: "auto",
      textureEncoding: "auto",
    },
  },
  high: {
    label: "High",
    description: "Higher mesh and atlas detail on the stable 1024 reconstruction path.",
    settings: {
      resolution: 1024,
      bgRemoval: "birefnet",
      uv: "xatlas",
      targetFaces: 500000,
      texture: true,
      atlasSize: 4096,
      textureResolution: "auto",
      remeshBand: "auto",
      textureEncoding: "png",
    },
  },
};

const PRESET_SETTING_KEYS = [
  "resolution",
  "bgRemoval",
  "uv",
  "targetFaces",
  "texture",
  "atlasSize",
  "textureResolution",
  "remeshBand",
  "textureEncoding",
] as const satisfies ReadonlyArray<keyof PresetSettings>;

/** Detects an exact preset match while intentionally ignoring seed controls. */
export function matchingGenerationPreset(
  params: NormalizedGenParams,
): GenerationPreset | null {
  for (const preset of ["low", "medium", "high"] as const) {
    const expected = GENERATION_PRESETS[preset].settings;
    if (PRESET_SETTING_KEYS.every((key) => params[key] === expected[key])) return preset;
  }
  return null;
}
