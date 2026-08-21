// HTTP client for the resident trellis-server (see src/trellis-server.cpp):
//   GET  /health   -> "ok"
//   POST /generate  multipart: image file plus generation overrides and an
//                   optional request_id used with the progress endpoint
//                   -> model/gltf-binary, or JSON {"error": "..."} on failure.
//   GET  /progress/{request_id}
//                  -> canonical job progress; percent is null until a real
//                     sampler reports steps (never inferred from elapsed time).

import { apiBase, loadConfig } from "./config";
import { normalizeGenParams, type GenParams } from "./types";

async function base(): Promise<string> {
  return apiBase(await loadConfig());
}

export async function health(timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${await base()}/health`, { signal: ctrl.signal });
    return res.ok && (await res.text()).trim() === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Canonical progress snapshot served by trellis-server's registry. */
export interface NativeProgress {
  requestId: string;
  status: "running" | "succeeded" | "failed";
  stageId: string;
  stageLabel: string;
  completedSteps: number;
  totalSteps: number;
  /** null while no sampler has reported steps: show an indeterminate bar. */
  percent: number | null;
  /** ETA for the active sampler only, not the whole job. */
  stageEtaSeconds: number | null;
  updatedAt: number;
  error: string | null;
}

/**
 * Fetch one job's canonical progress. Returns null on any failure — including
 * the expected 404 before registration and older servers without the endpoint
 * — so callers fall back to indeterminate display.
 */
export async function getGenerationProgress(requestId: string): Promise<NativeProgress | null> {
  try {
    const res = await fetch(`${await base()}/progress/${encodeURIComponent(requestId)}`);
    if (!res.ok) return null;
    return (await res.json()) as NativeProgress;
  } catch {
    return null;
  }
}

/** trellis-server maps bg_removal: "auto" keeps the server default (no field). */
function toForm(image: Blob, p: GenParams): FormData {
  const normalized = normalizeGenParams(p);
  const fd = new FormData();
  fd.append("image", image, "input.png");
  fd.append("seed", String(normalized.seed));
  fd.append("resolution", String(normalized.resolution));
  if (normalized.bgRemoval !== "auto") fd.append("bg_removal", normalized.bgRemoval);
  fd.append("uv", normalized.uv);

  // Optional fields are sent only when the caller intentionally supplied an
  // override. Missing fields and "auto" preserve the server launch/default
  // behavior, which keeps v1 stored records and old callers compatible.
  if (p.targetFaces !== undefined && normalized.targetFaces !== "auto") {
    fd.append("target_faces", String(normalized.targetFaces));
  }
  if (p.texture !== undefined) {
    fd.append("texture", normalized.texture ? "on" : "off");
  }
  if (p.atlasSize !== undefined && normalized.atlasSize !== "auto") {
    fd.append("atlas_size", String(normalized.atlasSize));
  }
  if (p.textureResolution !== undefined && normalized.textureResolution !== "auto") {
    fd.append("texture_resolution", String(normalized.textureResolution));
  }
  if (p.remeshBand !== undefined && normalized.remeshBand !== "auto") {
    fd.append("remesh_band", String(normalized.remeshBand));
  }
  if (p.textureEncoding !== undefined && normalized.textureEncoding !== "auto") {
    fd.append("texture_encoding", normalized.textureEncoding);
  }
  return fd;
}

export interface GenerateResult {
  glb: Blob;
}

export async function generate(
  image: Blob,
  params: GenParams,
  signal?: AbortSignal,
  requestId?: string,
): Promise<GenerateResult> {
  const form = toForm(image, params);
  if (requestId) form.append("request_id", requestId);
  const res = await fetch(`${await base()}/generate`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    let msg = `generation failed (HTTP ${res.status})`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const glb = await res.blob();
  if (glb.size === 0) throw new Error("server returned an empty model");
  return { glb };
}
