import { sha256 } from "./generation-data";

export async function containerFixture(magic: string, schema: string, payloads: Record<string, Blob>, metadata: Record<string, unknown> = {},
  mutate: (manifest: Record<string, any>) => void = () => {}): Promise<Blob> {
  let offset = 0;
  const files = [], parts: Blob[] = [];
  for (const [name, blob] of Object.entries(payloads)) {
    files.push({ name, offset, bytes: blob.size, sha256: await sha256(blob), ...(metadata.fileInfo as Record<string, object> ?? {})[name] });
    parts.push(blob);
    const padded = Math.ceil(blob.size / 8) * 8;
    parts.push(new Blob([new Uint8Array(padded - blob.size)])); offset += padded;
  }
  const { fileInfo: _info, ...rest } = metadata;
  const manifest: Record<string, any> = { schema, version: 1, ...rest, files };
  mutate(manifest);
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(16), view = new DataView(header);
  new Uint8Array(header).set(new TextEncoder().encode(magic));
  view.setUint32(8, encoded.length, true); view.setUint32(12, files.length, true);
  return new Blob([header, encoded, new Uint8Array(Math.ceil(encoded.length / 8) * 8 - encoded.length), ...parts]);
}
export async function generationFixture(): Promise<{ data: Blob; glb: Blob }> {
  const glb = new Blob(["synthetic model"]);
  const meshHeader = new Uint32Array([3,1]);
  const surface = new Blob([meshHeader, new Float32Array([0,0,0, .1,0,0, 0,.1,0]), new Int32Array([0,1,2])]);
  const payloads: Record<string, Blob> = { "roots.i32": new Blob([new Int32Array([0,0,0])]),
    "shape.norm.f32": new Blob([new Float32Array(32)]), "original-noise.f32": new Blob([new Float32Array(32)]),
    "conditioning.f32": new Blob([new Float32Array(1029 * 1024)]), "cutout.png": new Blob(["synthetic RGBA PNG"]),
    "surface.mesh": surface, "dense-snap.mesh": surface };
  const fileInfo: Record<string, object> = {};
  for (const [name, shape, dtype] of [["roots.i32", [1,3], "int32-le"], ["shape.norm.f32", [1,32], "float32-le"],
    ["original-noise.f32", [1,32], "float32-le"], ["conditioning.f32", [1029,1024], "float32-le"]] as const)
    fileInfo[name] = { shape, dtype };
  for (let i = 0; i < 4; i++) {
    payloads[`subdivision-${i}.u8`] = new Blob([new Uint8Array([1,0,0,0,0,0,0,0])]);
    fileInfo[`subdivision-${i}.u8`] = { shape: [1,8], dtype: "uint8" };
  }
  for (const name of ["surface.mesh", "dense-snap.mesh"]) fileInfo[name] = { encoding: "triastasis-mesh-le-v1", vertices: 3, triangles: 1 };
  const data = await containerFixture("TRGST001", "triastasis-generation-data", payloads, {
    profile: "textured-512-v1", resolution: 512, texture_resolution: 512, root_grid: 32, roots: 1,
    hierarchy_counts: [1,1,1,1,1], array_order: "item-major", octant_order: "x-bit0-y-bit1-z-bit2", negative_conditioning: "zeros",
    shape_normalization: "trellis2-native-shape-f32-v1", texture_normalization: "trellis2-native-texture-f32-v1", generation_seed: 42,
    source_surface_sha256: await sha256(surface), source_glb_sha256: await sha256(glb), coordinate_order_sha256: await sha256(payloads["roots.i32"]), fileInfo,
  });
  return { data, glb };
}
