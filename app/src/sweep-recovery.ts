// Pure orchestration helpers for manifest-driven job control. Kept free of
// DOM and Tauri dependencies so node:test can exercise them directly.

import type { GenerationManifest, ManifestIssue } from "./types";

export interface RecoveryCandidate {
  path: string;
  manifest: GenerationManifest;
  /** Validation issues reported by the native manifest reader, if any. */
  issues?: ManifestIssue[];
}

export interface RecoveryEligibility {
  eligible: boolean;
  /** Human-readable reason when not eligible. */
  reason?: string;
}

/** Issue kinds on the source image that make recovery impossible. */
const SOURCE_BLOCKING_KINDS = new Set(["missing", "unsafePath", "hashMismatch", "invalidFormat"]);

/** Returns the first blocking problem with a candidate's source image. */
export function sourceIssueReason(issues?: ManifestIssue[]): string | null {
  for (const issue of issues ?? []) {
    if (issue.role === "sourceImage" && SOURCE_BLOCKING_KINDS.has(issue.kind)) {
      return `source image unusable (${issue.kind}): ${issue.path}`;
    }
  }
  return null;
}

/**
 * Decides whether an interrupted-sweep candidate may be re-queued.
 *
 * Policy:
 * - completed and cancelled are terminal and never re-generated;
 * - failed candidates ARE retryable (labelled as failed in the UI);
 * - interrupted is the primary recovery case;
 * - lineage IDs and a readable, unmodified source-image reference are required.
 */
export function recoveryEligibility(
  manifest: GenerationManifest,
  issues?: ManifestIssue[],
): RecoveryEligibility {
  if (manifest.status === "completed") return { eligible: false, reason: "already completed" };
  if (manifest.status === "cancelled") return { eligible: false, reason: "cancelled" };
  if (manifest.status !== "interrupted" && manifest.status !== "failed") {
    return { eligible: false, reason: `unrecoverable state "${manifest.status}"` };
  }
  if (!manifest.assetId || !manifest.versionId) {
    return { eligible: false, reason: "missing lineage ids" };
  }
  if (!manifest.sourceImage) return { eligible: false, reason: "no source image reference" };
  const sourceProblem = sourceIssueReason(issues);
  if (sourceProblem) return { eligible: false, reason: sourceProblem };
  return { eligible: true };
}

/** Normalized absolute identity of a referenced source file. */
export function sourceIdentityFor(manifestPath: string, sourceImage: string): string {
  const cut = Math.max(manifestPath.lastIndexOf("/"), manifestPath.lastIndexOf("\\"));
  const dir = cut > 0 ? manifestPath.slice(0, cut) : "";
  return `${dir.toLowerCase()}::${sourceImage.toLowerCase()}`;
}

/** Sorts by original submission order so recovery preserves seed order. */
export function sortBySweepIndex<T extends { manifest: GenerationManifest }>(entries: T[]): T[] {
  return [...entries].sort(
    (a, b) => (a.manifest.sweep?.index ?? 0) - (b.manifest.sweep?.index ?? 0),
  );
}

/** The subset of candidates a recovery action will actually re-queue. */
export function queueableCandidates<T extends RecoveryCandidate>(entries: T[]): T[] {
  return sortBySweepIndex(entries).filter((entry) =>
    recoveryEligibility(entry.manifest, entry.issues).eligible,
  );
}

/**
 * Pure preflight for a recovery action: filters eligible candidates, orders
 * them by sweep index, and assigns each its normalized source identity.
 * Callers then read every distinct source BEFORE queueing anything, so an
 * unexpected read failure can never leave a partially restored sweep.
 */
export function planRecoveryQueue<T extends RecoveryCandidate>(
  entries: T[],
): Array<{ candidate: T; sourceKey: string }> {
  return sortBySweepIndex(entries)
    .filter((entry) => recoveryEligibility(entry.manifest, entry.issues).eligible)
    .map((candidate) => ({
      candidate,
      sourceKey: sourceIdentityFor(candidate.path, candidate.manifest.sourceImage!),
    }));
}

/**
 * Reads every distinct source before enqueueing the first job. This function
 * is used directly by the UI so tests can enforce the zero-partial-queue
 * contract against production orchestration.
 */
export async function executeRecoveryPlan<T extends RecoveryCandidate, TSource>(
  plan: Array<{ candidate: T; sourceKey: string }>,
  readSource: (candidate: T) => Promise<TSource>,
  enqueue: (candidate: T, source: TSource) => void,
): Promise<number> {
  const sources = new Map<string, TSource>();
  for (const { candidate, sourceKey } of plan) {
    if (sources.has(sourceKey)) continue;
    try {
      sources.set(sourceKey, await readSource(candidate));
    } catch (error) {
      const sweepIndex = candidate.manifest.sweep?.index;
      const number = sweepIndex === undefined ? "?" : String(sweepIndex + 1);
      const label = candidate.manifest.label || "Unnamed candidate";
      const seed = candidate.manifest.seed;
      const detail = (error as Error).message || String(error);
      throw new Error(
        `Candidate ${number} "${label}" (seed ${seed}, ${candidate.path}) failed source preflight: ${detail}`,
      );
    }
  }

  for (const { candidate, sourceKey } of plan) {
    enqueue(candidate, sources.get(sourceKey)!);
  }
  return plan.length;
}

/**
 * Groups warning messages for summaries: identical messages collapse into one
 * labelled count, mixed codes never get mislabelled as a single kind.
 */
export function summarizeWarnings(messages: string[]): string | null {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = message.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()]
    .map(([message, count]) => (count === 1 ? message : `${message} ×${count}`))
    .join("; ");
}

/**
 * Whether a successful generation must finalize its manifest. True for fresh
 * contexts, pre-persisted sweep candidates, and resumed lineage alike — the
 * previous condition skipped pre-persisted candidates entirely.
 */
export function requiresTerminalFinalization(state: {
  manifestContext: unknown;
  resume: unknown;
  candidateManifest: unknown;
}): boolean {
  return Boolean(state.manifestContext || state.resume || state.candidateManifest);
}
