import type { BundleSummary, LocalBundleState, ModelsScan } from "./model-catalog";

/** Keep the selected directory when multiple copies of the same tier exist. */
export function localCatalogBundle(scan: ModelsScan, bundleId: string): LocalBundleState | undefined {
  const matches = scan.local?.filter((bundle) => bundle.bundleId === bundleId) ?? [];
  return matches.find((bundle) => bundle.active) ?? matches.find((bundle) => bundle.verified) ?? matches[0];
}

export function modelStorageBytes(scan: ModelsScan, catalog: BundleSummary[]): number {
  const directories = new Map<string, number>();
  const add = (dir: string, bytes: number) => {
    let key = dir.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-z]:\//i.test(key) || key.startsWith("//")) key = key.toLowerCase();
    directories.set(key, Math.max(directories.get(key) ?? 0, bytes));
  };
  for (const entry of scan.managed) add(entry.dir, entry.totalBytes ?? catalog.find((b) => b.id === entry.bundleId)?.totalBytes ?? 0);
  for (const entry of scan.local ?? []) add(entry.dir, entry.totalBytes);
  if (scan.custom) add(scan.custom.dir, scan.custom.totalBytes ?? 0);
  return [...directories.values()].reduce((total, bytes) => total + bytes, 0);
}
