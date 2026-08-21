// Thin bridge over the Tauri v2 runtime so the same UI also runs in a plain
// browser (vite dev / served by trellis-server). Every Tauri call is guarded by
// `isTauri()`; in the browser we fall back to sensible web behaviour.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BgRemoval, GenerationQualityWarning } from "./types";

export type NativeFileDropEvent =
  | { type: "enter" | "over" | "leave" }
  | { type: "drop"; paths: string[] };

export interface AutomationInfo {
  running: boolean;
  url: string;
  port: number;
  maxConcurrency: number;
  policy: string;
  gpuName: string;
  vramTotalMb: number;
  vramFreeMb: number;
  reason: string;
}

export interface AutomationJobParams {
  seed: number;
  resolution: 512 | 1024 | 1536;
  bgRemoval: "auto" | "birefnet" | "threshold";
  uv: "xatlas" | "box";
}

/** Canonical progress stored by the automation queue for one job. */
export interface AutomationJobProgress {
  stageId: string | null;
  stageLabel: string | null;
  completedSteps: number | null;
  totalSteps: number | null;
  /** null while the native backend has no measurable sampler data. */
  percent: number | null;
  etaSeconds: number | null;
  updatedAt: number | null;
}

export interface AutomationJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  statusUrl: string;
  modelUrl: string;
  imageUrl: string;
  submittedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  outputPath: string | null;
  error: string | null;
  sourceName: string;
  sourceType: string;
  params: AutomationJobParams;
  queuePosition: number | null;
  jobsAhead: number;
  qualityWarning: GenerationQualityWarning | null;
  progress?: AutomationJobProgress | null;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Invoke a Rust command; throws in the browser (callers must guard). */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/** Subscribe to a Tauri event; no-op (returns a noop unlisten) in the browser. */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}

/** Receive files dragged from the operating system into the native webview. */
export async function listenForNativeFileDrops(
  handler: (event: NativeFileDropEvent) => void | Promise<void>,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "drop") void handler({ type: "drop", paths: payload.paths });
    else void handler({ type: payload.type });
  });
}

/** Read a native dropped image after Tauri has supplied its absolute path. */
export async function readDroppedImage(path: string): Promise<{ blob: Blob; name: string }> {
  if (!isTauri()) throw new Error("Native file drop is unavailable in the browser");
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    gif: "image/gif",
  };
  const type = mimeTypes[extension];
  if (!type) throw new Error("Drop a PNG, JPEG, WebP, BMP, or GIF image");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  if (!bytes.length) throw new Error("The dropped image is empty");
  const name = path.split(/[\\/]/).pop() || `dropped.${extension}`;
  return { blob: new Blob([bytes], { type }), name };
}

/**
 * Save bytes to disk. In Tauri, open a native "Save as" dialog then write via
 * the fs plugin. In the browser, trigger a normal download.
 */
export async function saveBytes(defaultName: string, bytes: Uint8Array): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "glTF binary", extensions: ["glb"] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const blob = new Blob([bytes as BlobPart], { type: "model/gltf-binary" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** Native folder picker (Tauri only); returns the chosen path or null. */
export async function pickDirectory(current?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, defaultPath: current || undefined });
  return typeof res === "string" ? res : null;
}

/** Open the configured output directory in the OS file browser (Tauri only). */
export async function openOutputDir(): Promise<void> {
  if (isTauri()) await invoke("open_output_dir");
}

/** Open the server logs directory in the OS file browser (Tauri only). */
export async function openLogsDir(): Promise<void> {
  if (isTauri()) await invoke("open_logs_dir");
}

/** The logs directory path (Tauri only); empty string in the browser. */
export async function logsDir(): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("logs_dir");
  } catch {
    return "";
  }
}

/**
 * Auto-save GLB bytes into the configured output directory (Tauri only).
 * The Rust side resolves + creates the dir and returns the full path; the fs
 * plugin then writes the bytes there. Returns the path, or null in the browser.
 */
export async function saveToOutputDir(name: string, bytes: Uint8Array): Promise<string | null> {
  if (!isTauri()) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await invoke<string>("output_path", { name });
  await writeFile(path, bytes);
  return path;
}

/** Run the bundled TRELLIS background-removal path without generating geometry. */
export async function previewAlpha(image: Blob, bgRemoval: BgRemoval): Promise<Blob> {
  if (!isTauri()) throw new Error("exact mask preview requires the desktop app");
  const input = Array.from(new Uint8Array(await image.arrayBuffer()));
  const output = await invoke<number[]>("preview_alpha", { image: input, bgRemoval });
  if (!output.length) throw new Error("background removal returned an empty image");
  return new Blob([new Uint8Array(output)], { type: "image/png" });
}

/** Local queued automation API and hardware safety policy (Tauri only). */
export async function automationInfo(): Promise<AutomationInfo | null> {
  if (!isTauri()) return null;
  return invoke<AutomationInfo>("automation_info");
}

/** Jobs submitted through the tray-resident automation API. */
export async function automationJobs(apiUrl: string): Promise<AutomationJob[]> {
  const response = await fetch(`${apiUrl}/jobs`);
  if (!response.ok) throw new Error(`Automation jobs request failed (${response.status})`);
  const payload = await response.json() as { jobs?: AutomationJob[] };
  return Array.isArray(payload.jobs) ? payload.jobs : [];
}

/** Download one successful automation job's model and original source image. */
export async function automationJobFiles(
  apiUrl: string,
  jobId: string,
): Promise<{ glb: Blob; input: Blob }> {
  const [modelResponse, imageResponse] = await Promise.all([
    fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}/model`),
    fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}/image`),
  ]);
  if (!modelResponse.ok) throw new Error(`Automation model download failed (${modelResponse.status})`);
  if (!imageResponse.ok) throw new Error(`Automation source download failed (${imageResponse.status})`);
  const [glb, input] = await Promise.all([modelResponse.blob(), imageResponse.blob()]);
  return { glb, input };
}
