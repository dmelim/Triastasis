import { getGenerationProgress, type NativeProgress } from "./api";
import { apiBase, loadConfig } from "./config";
import { nativeWork } from "./native-work";
import { readBinaryContainer, type BinaryContainer, type GenerationDataRef } from "./generation-data";

export interface TexturePreview { seed: number; values: Float32Array; missingSamples: number }
async function request(route: string, form: FormData, progress: (value: NativeProgress) => void, shouldStart: () => boolean, queuedCancellation?: AbortSignal): Promise<Blob> {
  return nativeWork(async () => {
    const requestId = `texture-${crypto.randomUUID()}`;
    form.append("request_id", requestId);
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        const snapshot = await getGenerationProgress(requestId);
        if (!stopped && snapshot) progress(snapshot);
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    };
    void poll();
    try {
      // Deliberately no running AbortSignal: HTTP abort does not stop GPU work.
      const response = await fetch(`${apiBase(await loadConfig())}${route}`, { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : `Texture operation failed (HTTP ${response.status})`);
      }
      const result = await response.blob();
      if (!result.size) throw new Error("The runtime returned an empty texture result");
      return result;
    } finally { stopped = true; }
  }, shouldStart, queuedCancellation);
}
export function retexture(bundle: Blob, seed: number, progress: (value: NativeProgress) => void, shouldStart: () => boolean, queuedCancellation?: AbortSignal): Promise<Blob> {
  const form = new FormData(); form.append("generation_data", bundle, "generation.trg"); form.append("seed", String(seed));
  return request("/retexture", form, progress, shouldStart, queuedCancellation);
}
export function bakeTexture(bundle: Blob, option: Blob, atlas: number, encoding: string, progress: (value: NativeProgress) => void, shouldStart: () => boolean, queuedCancellation?: AbortSignal): Promise<Blob> {
  const form = new FormData(); form.append("generation_data", bundle, "generation.trg"); form.append("texture_option", option, "selection.tropt");
  form.append("atlas_size", String(atlas)); form.append("texture_encoding", encoding);
  return request("/retexture/bake", form, progress, shouldStart, queuedCancellation);
}
export async function texturePreview(blob: Blob, reference: GenerationDataRef, source: BinaryContainer): Promise<TexturePreview> {
  const container = await readBinaryContainer(blob, "TROPT001", "triastasis-texture-option", ["field.f32", "preview.f32"]);
  const m = container.manifest, surface = source.entries.get("surface.mesh")!;
  if (m.profile !== reference.profile || m.generation_data_sha256 !== reference.sha256 || m.source_surface_sha256 !== reference.sourceSurfaceSha256
    || m.coordinate_order_sha256 !== source.manifest.coordinate_order_sha256 || m.sampler_profile !== "trellis2-texture-12-v1")
    throw new Error("Texture option does not belong to this saved generation");
  if (typeof m.seed !== "number" || !Number.isInteger(m.seed) || m.seed <= 0 || m.seed > 0xffffffff
    || typeof m.missing_samples !== "number" || !Number.isInteger(m.missing_samples) || m.missing_samples < 0 || m.missing_samples > Number(surface.vertices))
    throw new Error("Invalid texture preview metadata");
  const e = container.entries.get("preview.f32")!;
  if (e.dtype !== "float32-le" || !Array.isArray(e.shape) || e.shape.length !== 2 || e.shape[0] !== surface.vertices || e.shape[1] !== 6 || e.bytes !== Number(surface.vertices) * 24)
    throw new Error("Invalid texture preview dimensions");
  const values = new Float32Array(await (await container.entry("preview.f32")).arrayBuffer());
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid preview material values");
  return { seed: m.seed, values, missingSamples: m.missing_samples };
}
