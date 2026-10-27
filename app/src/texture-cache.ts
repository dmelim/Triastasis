import { isTauri } from "./tauri";
import { sha256 } from "./generation-data";

/** At most three decoded fields on local disk; only the field being uploaded
 * or downloaded is held in RAM. This cache is disposable, never Library data. */
export class TextureCache {
  private readonly id = crypto.randomUUID();
  private readonly directory = `triastasis/texture-options/${this.id}`;
  private readonly entries = new Map<string, { bytes: number; hash: string }>();
  private bytes = 0;
  private closed = false;
  private async browserDirectory() {
    const root = await navigator.storage.getDirectory();
    const textures = await root.getDirectoryHandle("triastasis-texture-options", { create: true });
    return textures.getDirectoryHandle(this.id, { create: true });
  }
  private async deleteFile(key: string): Promise<void> {
    if (isTauri()) {
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.remove(`${this.directory}/${key}`, { baseDir: fs.BaseDirectory.AppLocalData }).catch(() => {});
    } else await (await this.browserDirectory()).removeEntry(key).catch(() => {});
  }
  async save(blob: Blob): Promise<string> {
    if (this.closed || this.entries.size >= 3 || blob.size > 512 * 1024 * 1024 - this.bytes) throw new Error("Texture option cache is full");
    const key = crypto.randomUUID() + ".tropt", digest = await sha256(blob);
    try {
      if (isTauri()) {
        const fs = await import("@tauri-apps/plugin-fs"), options = { baseDir: fs.BaseDirectory.AppLocalData };
        await fs.mkdir(this.directory, { ...options, recursive: true });
        await fs.writeFile(`${this.directory}/${key}`, new Uint8Array(await blob.arrayBuffer()), options);
      } else {
        const file = await (await this.browserDirectory()).getFileHandle(key, { create: true });
        const writer = await file.createWritable();
        try { await writer.write(blob); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
      }
    } catch (error) { await this.deleteFile(key).catch(() => {}); throw error; }
    this.entries.set(key, { bytes: blob.size, hash: digest }); this.bytes += blob.size;
    try { await this.read(key); } catch (error) { await this.remove(key); throw error; }
    return key;
  }
  async read(key: string): Promise<Blob> {
    const entry = this.entries.get(key);
    if (!entry || this.closed) throw new Error("This texture option is no longer cached. Generate it again before baking.");
    let blob: Blob;
    if (isTauri()) {
      const fs = await import("@tauri-apps/plugin-fs");
      blob = new Blob([new Uint8Array(await fs.readFile(`${this.directory}/${key}`, { baseDir: fs.BaseDirectory.AppLocalData }))]);
    } else blob = await (await (await this.browserDirectory()).getFileHandle(key)).getFile();
    if (blob.size !== entry.bytes || await sha256(blob) !== entry.hash) throw new Error("Cached texture option failed verification");
    return blob;
  }
  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key); if (!entry) return;
    this.bytes -= entry.bytes; this.entries.delete(key);
    await this.deleteFile(key);
  }
  async dispose(): Promise<void> {
    if (this.closed) return; this.closed = true; this.entries.clear(); this.bytes = 0;
    if (isTauri()) {
      const fs = await import("@tauri-apps/plugin-fs");
      await fs.remove(this.directory, { baseDir: fs.BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
    } else {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle("triastasis-texture-options", { create: true })).removeEntry(this.id, { recursive: true }).catch(() => {});
    }
  }
}
