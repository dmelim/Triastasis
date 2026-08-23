// .polyloom.json generation-manifest lifecycle for the desktop app.
//
// A manifest is written when a job is submitted (status "interrupted", so a
// crash or restart leaves a resumable record), then rewritten on completion
// ("completed", with model, metrics, and warning) or failure ("failed"). All
// hashing is performed by the shell writer; failures here never break a
// generation in flight.

import { isTauri, readGenerationManifest, saveToOutputDir, writeGenerationManifest } from "./tauri";
import type {
  GenerationManifest,
  ManifestMetrics,
  ManifestQualityWarning,
  ManifestSweep,
  ModelMetrics,
  SweepCandidateState,
} from "./types";

export interface ManifestContext {
  dir: string;
  fileName: string;
  sourceName: string;
  modelName: string;
  jobId: string;
  requestId: string;
  submittedAtUtc: string;
  startedAtUtc: string;
  params: { resolution: number; seed: number; bgRemoval: string; uv: string; texture: boolean };
  label: string;
  sweep?: Pick<ManifestSweep, "groupId" | "index" | "count"> & { state: SweepCandidateState };
}

export interface FinishPatch {
  status: "completed" | "failed" | "interrupted" | "cancelled";
  error?: string;
  metrics?: ManifestMetrics | null;
  qualityWarning?: ManifestQualityWarning | null;
  durationSeconds?: number;
  /** Actual produced GLB filename, when it differs from the recorded one. */
  modelName?: string;
}

export function imageExtensionFor(mimeType: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("bmp")) return "bmp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

export function safeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "") || "model";
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe || "model";
}

function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function nowIso(): string {
  return new Date().toISOString();
}

function thinRatioFrom(dimensions: { x: number; y: number; z: number }): number | null {
  const axes = [dimensions.x, dimensions.y, dimensions.z];
  const largest = Math.max(...axes);
  if (!Number.isFinite(largest) || largest <= 0) return null;
  return Math.min(...axes) / largest;
}

export function metricsFromModelMetrics(
  metrics: ModelMetrics,
): ManifestMetrics | null {
  const dims = metrics.dimensions
    ? { x: metrics.dimensions.x, y: metrics.dimensions.y, z: metrics.dimensions.z }
    : null;
  if (!dims && metrics.fileSize === undefined) return null;
  return {
    dimensions: dims,
    triangles: metrics.triangles ?? null,
    fileSizeBytes: metrics.fileSize ?? null,
    thinRatio: dims ? thinRatioFrom(dims) : null,
  };
}

/** A desktop completion is durable only after its GLB reached the output directory. */
export function hasDurableGeneratedArtifact(
  desktop: boolean,
  savedPath: string | null,
): boolean {
  return Boolean(savedPath) || !desktop;
}

interface BuildArgs {
  status: GenerationManifest["status"];
  label: string;
  sourceName: string;
  modelName: string;
  jobId: string;
  nativeRequestId: string;
  params: { resolution: number; seed: number; bgRemoval: string; uv: string; texture: boolean };
  submittedAtUtc: string;
  startedAtUtc?: string;
  finishedAtUtc?: string;
  durationSeconds?: number;
  assetId?: string;
  versionId?: string;
  parentVersionId?: string | null;
  metrics?: ManifestMetrics | null;
  qualityWarning?: ManifestQualityWarning | null;
  error?: string;
  sweep?: ManifestContext["sweep"];
}

function buildManifest(args: BuildArgs): GenerationManifest {
  return {
    schemaVersion: 1,
    status: args.status,
    label: args.label,
    sourceImage: args.sourceName,
    model: args.modelName,
    resolution: args.params.resolution,
    seed: args.params.seed,
    bgRemoval: args.params.bgRemoval,
    uv: args.params.uv,
    texture: args.params.texture,
    jobId: args.jobId,
    nativeRequestId: args.nativeRequestId,
    assetId: args.assetId ?? args.jobId,
    versionId: args.versionId ?? args.jobId,
    parentVersionId: args.parentVersionId ?? null,
    submittedAtUtc: args.submittedAtUtc,
    startedAtUtc: args.startedAtUtc ?? null,
    finishedAtUtc: args.finishedAtUtc ?? null,
    durationSeconds: args.durationSeconds ?? null,
    polyloomVersion: null,
    serverVersion: null,
    metrics: args.metrics ?? null,
    qualityWarning: args.qualityWarning ?? null,
    error: args.error ?? null,
    files: [
      { role: "sourceImage", path: args.sourceName, sha256: "" },
      { role: "glb", path: args.modelName, sha256: "" },
    ],
    sweep: args.sweep
      ? {
          groupId: args.sweep.groupId,
          index: args.sweep.index,
          count: args.sweep.count,
          seed: args.params.seed,
          state: args.sweep.state,
        }
      : null,
  };
}

/**
 * Saves the source image beside the future GLB and writes the initial
 * interrupted manifest. Returns null (never throws) whenever manifests are
 * unavailable — browser mode or any filesystem failure.
 */
export async function startGenerationManifest(input: {
  base: string;
  jobId: string;
  requestId: string;
  label: string;
  params: { resolution: number; seed: number; bgRemoval: string; uv: string; texture: boolean };
  sourceBlob: Blob;
  sweep?: ManifestContext["sweep"];
}): Promise<ManifestContext | null> {
  try {
    if (!isTauri()) return null;
    const ext = imageExtensionFor(input.sourceBlob.type || "image/png");
    const sourceName = input.sweep
      ? `${input.base}_sweep${shortId(input.sweep.groupId)}_source.${ext}`
      : `${input.base}_${input.jobId}_source.${ext}`;
    const savedPath = await saveToOutputDir(
      sourceName,
      new Uint8Array(await input.sourceBlob.arrayBuffer()),
    );
    if (!savedPath) return null;
    const dir = dirname(savedPath);
    const modelName = `${input.base}_${input.params.resolution}_seed${input.params.seed}_${input.jobId}.glb`;
    const fileName = `${safeStem(modelName)}.polyloom.json`;
    const submittedAt = nowIso();
    await writeGenerationManifest(
      dir,
      buildManifest({
        status: "interrupted",
        label: input.label,
        sourceName,
        modelName,
        jobId: input.jobId,
        nativeRequestId: input.requestId,
        params: input.params,
        submittedAtUtc: submittedAt,
        startedAtUtc: submittedAt,
        sweep: input.sweep ? { ...input.sweep, state: "queued" } : undefined,
      }),
      fileName,
    );
    return {
      dir,
      fileName,
      sourceName,
      modelName,
      jobId: input.jobId,
      requestId: input.requestId,
      submittedAtUtc: submittedAt,
      startedAtUtc: submittedAt,
      params: input.params,
      label: input.label,
      sweep: input.sweep,
    };
  } catch (error) {
    console.warn("Could not write generation manifest", error);
    return null;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Persists every candidate of a seed sweep BEFORE the first generation
 * starts: one shared durable source image plus one queued manifest per
 * candidate. Returns per-candidate contexts; on any failure the caller must
 * not queue the sweep at all (no half-persisted sweeps).
 */
export async function prepareSweepManifests(input: {
  base: string;
  groupId: string;
  labelBase: string;
  params: { resolution: number; bgRemoval: string; uv: string; texture: boolean };
  seeds: number[];
  sourceBlob: Blob;
}): Promise<Array<ManifestContext | null>> {
  if (!isTauri()) return input.seeds.map(() => null);
  const ext = imageExtensionFor(input.sourceBlob.type || "image/png");
  const sharedSourceName = `${input.base}_sweep${shortId(input.groupId)}_source.${ext}`;
  let dir: string | null = null;
  try {
    const savedPath = await saveToOutputDir(
      sharedSourceName,
      new Uint8Array(await input.sourceBlob.arrayBuffer()),
    );
    if (!savedPath) return input.seeds.map(() => null);
    dir = dirname(savedPath);
  } catch (error) {
    console.warn("Could not persist shared sweep source image", error);
    return input.seeds.map(() => null);
  }

  const submittedAt = nowIso();
  const contexts: Array<ManifestContext | null> = [];
  for (const [index, seed] of input.seeds.entries()) {
    const jobId = `${shortId(input.groupId)}-${index}-${seed}`;
    const modelName = `${input.base}_${input.params.resolution}_seed${seed}_${jobId}.glb`;
    const fileName = `${safeStem(modelName)}.polyloom.json`;
    try {
      await writeGenerationManifest(
        dir,
        buildManifest({
          status: "interrupted",
          label: `Candidate ${index + 1}/${input.seeds.length} · seed ${seed}`,
          sourceName: sharedSourceName,
          modelName,
          jobId,
          nativeRequestId: `${input.groupId}-${index}`,
          params: { ...input.params, seed },
          submittedAtUtc: submittedAt,
          startedAtUtc: submittedAt,
          assetId: input.groupId,
          versionId: jobId,
          sweep: {
            groupId: input.groupId,
            index,
            count: input.seeds.length,
            state: "queued",
          },
        }),
        fileName,
      );
      contexts.push({
        dir,
        fileName,
        sourceName: sharedSourceName,
        modelName,
        jobId,
        requestId: `${input.groupId}-${index}`,
        submittedAtUtc: submittedAt,
        startedAtUtc: submittedAt,
        params: { ...input.params, seed },
        label: `Candidate ${index + 1}/${input.seeds.length} · seed ${seed}`,
        sweep: {
          groupId: input.groupId,
          index,
          count: input.seeds.length,
          state: "queued",
        },
      });
    } catch (error) {
      console.warn(`Could not persist sweep candidate ${index}`, error);
      contexts.push(null);
    }
  }
  // Any failed candidate invalidates the whole persistence step so the
  // caller can refuse to enqueue a half-recorded sweep.
  return contexts.some((context) => context === null) ? input.seeds.map(() => null) : contexts;
}

/** Records a non-terminal candidate lifecycle change (queued/running). */
export async function setCandidateManifestState(
  context: ManifestContext,
  state: Extract<SweepCandidateState, "queued" | "running">,
): Promise<void> {
  try {
    if (!isTauri() || !context?.sweep) return;
    await writeGenerationManifest(
      context.dir,
      buildManifest({
        status: "interrupted",
        label: context.label,
        sourceName: context.sourceName,
        modelName: context.modelName,
        jobId: context.jobId,
        nativeRequestId: context.requestId,
        params: context.params,
        submittedAtUtc: context.submittedAtUtc,
        startedAtUtc: context.startedAtUtc,
        assetId: context.sweep.groupId,
        versionId: context.jobId,
        sweep: { ...context.sweep, state },
      }),
      context.fileName,
    );
    context.sweep.state = state;
  } catch (error) {
    console.warn("Could not update sweep candidate manifest", error);
  }
}

/** Marks a still-queued or running candidate as cancelled. */
export async function cancelCandidateManifest(context: ManifestContext): Promise<void> {
  try {
    if (!isTauri() || !context?.sweep) return;
    await writeGenerationManifest(
      context.dir,
      buildManifest({
        status: "cancelled",
        label: context.label,
        sourceName: context.sourceName,
        modelName: context.modelName,
        jobId: context.jobId,
        nativeRequestId: context.requestId,
        params: context.params,
        submittedAtUtc: context.submittedAtUtc,
        startedAtUtc: context.startedAtUtc,
        finishedAtUtc: nowIso(),
        assetId: context.sweep.groupId,
        versionId: context.jobId,
        sweep: { ...context.sweep, state: "cancelled" },
      }),
      context.fileName,
    );
    context.sweep.state = "cancelled";
  } catch (error) {
    console.warn("Could not cancel sweep candidate manifest", error);
  }
}

/**
 * Rewrites an existing manifest for a terminal state. Warn-only.
 */
export async function finishGenerationManifest(
  context: ManifestContext,
  patch: FinishPatch,
): Promise<void> {
  try {
    if (!isTauri() || !context) return;
    const sweepState: SweepCandidateState | undefined = context.sweep
      ? patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled"
        ? patch.status
        : context.sweep.state
      : undefined;
    await writeGenerationManifest(
      context.dir,
      buildManifest({
        status: patch.status,
        label: context.label,
        sourceName: context.sourceName,
        modelName: patch.modelName ?? context.modelName,
        jobId: context.jobId,
        nativeRequestId: context.requestId,
        params: context.params,
        submittedAtUtc: context.submittedAtUtc,
        startedAtUtc: context.startedAtUtc,
        finishedAtUtc: nowIso(),
        durationSeconds: patch.durationSeconds,
        assetId: context.sweep ? context.sweep.groupId : undefined,
        versionId: context.jobId,
        metrics: patch.metrics ?? null,
        qualityWarning: patch.qualityWarning ?? null,
        error: patch.error,
        sweep: context.sweep ? { ...context.sweep, state: sweepState ?? context.sweep.state } : undefined,
      }),
      context.fileName,
    );
  } catch (error) {
    // Terminal writes must be observable: log the detail, then surface a
    // clearly prefixed error to the caller (which keeps the gallery record
    // and warns the user instead of claiming durable recovery).
    console.error("Could not update generation manifest", error);
    throw new Error(
      `Manifest finalization failed: ${(error as Error).message || String(error)}`,
    );
  }
}

/**
 * Updates an interrupted manifest in place after its requeued replacement
 * finishes. Loads the original record so lineage, label, settings, and the
 * source-image reference survive untouched; only lifecycle fields change.
 */
export async function finishResumedManifest(
  manifestPath: string,
  patch: FinishPatch & { newJobId: string; newRequestId: string },
): Promise<void> {
  try {
    if (!isTauri()) return;
    const preview = await readGenerationManifest(manifestPath);
    const m = preview.manifest;
    const updated: GenerationManifest = {
      ...m,
      status: patch.status,
      jobId: patch.newJobId,
      nativeRequestId: patch.newRequestId,
      finishedAtUtc: nowIso(),
      durationSeconds: patch.durationSeconds ?? m.durationSeconds ?? null,
      metrics: patch.metrics ?? m.metrics ?? null,
      qualityWarning: patch.qualityWarning ?? null,
      error: patch.error ?? null,
    };
    // Keep a recovered candidate's sweep lifecycle in step with its manifest.
    if (
      updated.sweep &&
      (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled")
    ) {
      updated.sweep.state = patch.status;
    }
    if (patch.modelName) {
      // The replacement job may name its GLB differently than originally
      // planned; keep the manifest pointing at the real file.
      updated.model = patch.modelName;
      const glbEntry = updated.files?.find((file) => file.role === "glb");
      if (glbEntry) glbEntry.path = patch.modelName;
    }
    const dir = dirname(manifestPath);
    const fileName = basename(manifestPath);
    await writeGenerationManifest(dir, updated, fileName);
  } catch (error) {
    console.error("Could not update resumed generation manifest", error);
    throw new Error(
      `Manifest finalization failed: ${(error as Error).message || String(error)}`,
    );
  }
}
