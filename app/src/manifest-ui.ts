import type { ManifestIssue } from "./types";

const CORE_ROLES = new Set(["sourceImage", "glb"]);
const BLOCKING_ISSUE_KINDS = new Set([
  "missing",
  "hashMismatch",
  "invalidFormat",
  "unsafePath",
]);

/** Escapes untrusted manifest text before it is placed in an HTML template. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Core source/model issues that the native layer will refuse to process. */
export function hasBlockingCoreIssue(issues: ManifestIssue[]): boolean {
  return issues.some(
    (issue) => CORE_ROLES.has(issue.role) && BLOCKING_ISSUE_KINDS.has(issue.kind),
  );
}

/** Plain-text description of a native manifest validation issue. */
export function manifestIssueText(issue: Pick<ManifestIssue, "kind" | "path">): string {
  switch (issue.kind) {
    case "missing":
      return `Missing file: ${issue.path}`;
    case "hashMismatch":
      return `Modified since generation: ${issue.path}`;
    case "invalidFormat":
      return `Unreadable format: ${issue.path}`;
    default:
      return `Unsafe path rejected: ${issue.path}`;
  }
}
