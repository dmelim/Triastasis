import assert from "node:assert/strict";
import { test } from "node:test";

import { createTransactionalGallery, type GalleryFs } from "./gallery-storage";
import type { VersionRecord } from "./types";

const ROOT = "gallery-test";

/** In-memory filesystem with optional fault injection. */
class MemoryFs implements GalleryFs {
  files = new Map<string, Uint8Array | string>();
  dirs = new Set<string>();
  /** When set, the Nth operation (1-based) throws, then counting resets. */
  failAtOp: number | null = null;
  private ops = 0;

  private maybeFail(): void {
    if (this.failAtOp === null) return;
    this.ops += 1;
    if (this.ops === this.failAtOp) {
      this.failAtOp = null;
      this.ops = 0;
      throw new Error(`injected failure at operation ${this.ops}`);
    }
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    this.maybeFail();
    this.dirs.add(path);
    if (recursive) {
      const parts = path.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        this.dirs.add(current);
      }
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.maybeFail();
    this.files.set(path, data);
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    this.maybeFail();
    this.files.set(path, text);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined || typeof value === "string") throw new Error(`missing ${path}`);
    return value;
  }

  async readTextFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined || typeof value !== "string") throw new Error(`missing ${path}`);
    return value;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
    if (recursive) {
      for (const key of [...this.files.keys(), ...this.dirs]) {
        if (key.startsWith(`${path}/`)) {
          this.files.delete(key);
          this.dirs.delete(key);
        }
      }
    }
  }

  async listDirectories(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const dir of this.dirs) {
      if (dir.startsWith(prefix)) {
        const rest = dir.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) names.add(name);
      }
    }
    // Only direct children: exclude names reached through deeper paths.
    return [...names].filter((name) => this.dirs.has(`${path}/${name}`));
  }

  snapshot(): Map<string, Uint8Array | string> {
    return new Map(this.files);
  }
}

function makeRecord(overrides: Partial<VersionRecord> = {}): VersionRecord {
  const glbBytes = new TextEncoder().encode("glTF-fake-model-bytes");
  return {
    id: "record-1",
    ts: 1000,
    name: "input.png",
    params: {},
    input: new Blob([new TextEncoder().encode("png-bytes")], { type: "image/png" }),
    glb: new Blob([glbBytes], { type: "model/gltf-binary" }),
    thumb: new Blob([new TextEncoder().encode("thumb-png")], { type: "image/png" }),
    assetId: "asset-1",
    versionId: "record-1",
    operation: "generated",
    operationParams: {},
    createdAt: 1000,
    label: "First",
    favorite: false,
    metrics: null,
    ...overrides,
  } as VersionRecord;
}

async function readBlob(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

test("a fresh record loads back completely", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "One" }));
  const loaded = await gallery.loadRecord("r1");
  assert.ok(loaded);
  assert.equal(loaded.label, "One");
  assert.equal(await readBlob(loaded.glb), "glTF-fake-model-bytes");
  assert.ok(loaded.thumb);
});

test("legacy fixed-file records remain readable", async () => {
  const fs = new MemoryFs();
  await fs.mkdir(`${ROOT}/legacy`, true);
  await fs.writeFile(`${ROOT}/legacy/input.bin`, new TextEncoder().encode("old-input"));
  await fs.writeFile(`${ROOT}/legacy/model.glb`, new TextEncoder().encode("glTF-old"));
  await fs.writeTextFile(
    `${ROOT}/legacy/metadata.json`,
    JSON.stringify({
      id: "legacy",
      ts: 1,
      name: "in.png",
      params: {},
      assetId: "legacy",
      versionId: "legacy",
      operation: "generated",
      operationParams: {},
      createdAt: 1,
      label: "Legacy",
      favorite: false,
      metrics: null,
      inputType: "image/png",
      glbType: "model/gltf-binary",
      thumbType: null,
      hasThumb: false,
    }),
  );
  const gallery = createTransactionalGallery(fs, ROOT);
  const loaded = await gallery.loadRecord("legacy");
  assert.ok(loaded);
  assert.equal(loaded.label, "Legacy");
  assert.equal(loaded.thumb, null);
});

test("an update never corrupts the previous revision, whatever the interruption point", async () => {
  // Every blob/metadata write of the second save is interrupted in turn;
  // after each simulated crash the record must load as either the complete
  // first revision or the complete second one.
  for (const failAtOp of [3, 4, 5, 6, 7, 8]) {
    const fs = new MemoryFs();
    const gallery = createTransactionalGallery(fs, ROOT);
    await gallery.writeRecord(
      "r1",
      makeRecord({ id: "r1", label: "First", thumb: new Blob([new TextEncoder().encode("t1")]) }),
    );
    const before = fs.snapshot();

    fs.failAtOp = failAtOp;
    try {
      await gallery.writeRecord(
        "r1",
        makeRecord({
          id: "r1",
          label: "Second",
          thumb: null, // thumbnail removed by the update
        }),
      );
    } catch {
      // interrupted: acceptable
    }

    const loaded = await gallery.loadRecord("r1");
    assert.ok(loaded, `interruption at op ${failAtOp} must not lose the record`);
    assert.ok(
      loaded.label === "First" || loaded.label === "Second",
      `mixed record after interruption at op ${failAtOp}: ${loaded.label}`,
    );
    if (loaded.label === "First") {
      assert.equal(await readBlob(loaded.input), "png-bytes");
      assert.ok(loaded.thumb, "first revision keeps its thumbnail");
    } else {
      assert.ok(!loaded.thumb, "second revision has no thumbnail");
    }
    void before;
  }
});

test("a corrupt newest revision falls back to the previous committed one", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "Old" }));
  await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "New" }));

  // Make the newest revision's model blob unreadable.
  fs.files.delete(`${ROOT}/r1/revisions/2/model.glb`);

  const loaded = await gallery.loadRecord("r1");
  assert.ok(loaded);
  assert.equal(loaded.label, "Old");
});

test("removing a thumbnail cannot make a record disappear", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await gallery.writeRecord("r1", makeRecord({ id: "r1" }));
  await gallery.writeRecord("r1", makeRecord({ id: "r1", thumb: null }));
  const loaded = await gallery.loadRecord("r1");
  assert.ok(loaded);
  assert.equal(loaded.thumb, null);
});

test("a physically missing thumbnail degrades to the source preview", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await gallery.writeRecord("r1", makeRecord({ id: "r1" }));
  fs.files.delete(`${ROOT}/r1/revisions/1/thumb.bin`);

  const loaded = await gallery.loadRecord("r1");
  assert.ok(loaded);
  assert.equal(loaded.thumb, null);
  assert.equal(await readBlob(loaded.input), "png-bytes");
});

test("cleanup keeps the current and at most one previous revision", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  for (let index = 1; index <= 4; index += 1) {
    await gallery.writeRecord("r1", makeRecord({ id: "r1", label: `v${index}` }));
  }
  const revisions = await fs.listDirectories(`${ROOT}/r1/revisions`);
  assert.equal(revisions.length, 2);
  const loaded = await gallery.loadRecord("r1");
  assert.equal(loaded?.label, "v4");
});

test("interrupted writes are cleaned up by the next successful save", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "Good" }));
  fs.failAtOp = 4;
  try {
    await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "Broken" }));
  } catch {
    // expected
  }
  await gallery.writeRecord("r1", makeRecord({ id: "r1", label: "Recovered" }));

  const revisions = await fs.listDirectories(`${ROOT}/r1/revisions`);
  for (const name of revisions) {
    assert.ok(
      await fs.exists(`${ROOT}/r1/revisions/${name}/metadata.json`),
      "no incomplete revision may survive a later commit",
    );
  }
  const loaded = await gallery.loadRecord("r1");
  assert.equal(loaded?.label, "Recovered");
});

test("concurrent writes to one record serialize instead of racing", async () => {
  const fs = new MemoryFs();
  const gallery = createTransactionalGallery(fs, ROOT);
  await Promise.all([
    gallery.writeRecord("r1", makeRecord({ id: "r1", label: "A" })),
    gallery.writeRecord("r1", makeRecord({ id: "r1", label: "B" })),
    gallery.writeRecord("r1", makeRecord({ id: "r1", label: "C" })),
  ]);
  const loaded = await gallery.loadRecord("r1");
  assert.ok(loaded);
  assert.ok(["A", "B", "C"].includes(loaded.label));
});
