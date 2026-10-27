import { inspectGenerationData, sha256, validGenerationDataRef, type GenerationDataRef } from "./generation-data";
import type { GalleryFs } from "./gallery-storage";
import type { VersionRecord } from "./types";

export function generationBundlePath(root: string, reference: GenerationDataRef): string {
  if (!validGenerationDataRef(reference)) throw new Error("Invalid saved generation reference");
  return `${root}/generation-data/${reference.sha256}/generation.trg`;
}
export async function loadGenerationBundle(fs: GalleryFs, root: string, reference: GenerationDataRef): Promise<Blob> {
  const blob = new Blob([new Uint8Array(await fs.readFile(generationBundlePath(root, reference)))]);
  if (blob.size !== reference.bytes || await sha256(blob) !== reference.sha256) throw new Error("Saved generation data failed checksum verification");
  const { reference: actual } = await inspectGenerationData(blob);
  if (actual.sourceSurfaceSha256 !== reference.sourceSurfaceSha256 || actual.sourceGlbSha256 !== reference.sourceGlbSha256)
    throw new Error("Saved generation reference does not match its bundle");
  return blob;
}
/** Publish one immutable shared blob. The caller serializes by content hash. */
export async function persistGenerationBundle(fs: GalleryFs, root: string, record: VersionRecord): Promise<GenerationDataRef | undefined> {
  if (!record.generationData) {
    if (record.generationDataRef && !(await fs.exists(generationBundlePath(root, record.generationDataRef))))
      throw new Error("Generation data was not found in the Library");
    return record.generationDataRef;
  }
  const { reference: actual } = await inspectGenerationData(record.generationData);
  const reference = record.generationDataRef ?? actual;
  if (!validGenerationDataRef(reference) || reference.sha256 !== actual.sha256 || reference.bytes !== actual.bytes
    || reference.sourceSurfaceSha256 !== actual.sourceSurfaceSha256 || reference.sourceGlbSha256 !== actual.sourceGlbSha256)
    throw new Error("Generation data does not match its reference");
  if (!record.glb || await sha256(record.glb) !== reference.modelSha256) throw new Error("Generation data is bound to a different model");
  const path = generationBundlePath(root, reference);
  if (await fs.exists(path)) {
    const existing = new Blob([new Uint8Array(await fs.readFile(path))]);
    if (existing.size !== reference.bytes || await sha256(existing) !== reference.sha256) throw new Error("Existing saved generation data is corrupt");
    return reference;
  }
  const directory = path.slice(0, path.lastIndexOf("/"));
  await fs.mkdir(directory, true);
  const temporary = `${directory}/generation-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, new Uint8Array(await record.generationData.arrayBuffer()));
    const written = new Blob([new Uint8Array(await fs.readFile(temporary))]);
    if (written.size !== reference.bytes || await sha256(written) !== reference.sha256) throw new Error("Generation data write verification failed");
    await fs.rename(temporary, path);
  } finally {
    if (await fs.exists(temporary)) await fs.remove(temporary, false);
  }
  return reference;
}
