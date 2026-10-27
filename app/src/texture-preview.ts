import * as THREE from "three";

/** A single frozen surface, reused for every option. Vertex RGB is interpreted
 * as sRGB exactly once; metallic and roughness remain linear attributes. */
export function createTexturePreview(surface: ArrayBuffer, doubleSided = false) {
  if (surface.byteLength < 8) throw new Error("Saved preview surface is truncated");
  const header = new DataView(surface), vertices = header.getUint32(0, true), triangles = header.getUint32(4, true);
  if (!vertices || !triangles || vertices > 15_000_000 || triangles > 30_000_000 || surface.byteLength !== 8 + 12 * (vertices + triangles))
    throw new Error("Saved preview surface dimensions are invalid");
  const positions = new Float32Array(surface, 8, vertices * 3), faces = new Int32Array(surface, 8 + vertices * 12, triangles * 3);
  if (positions.some(value => !Number.isFinite(value) || Math.abs(value) > 16) || faces.some(index => index < 0 || index >= vertices))
    throw new Error("Saved preview surface contains invalid geometry");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
  geometry.computeVertexNormals();
  const colors = new Float32Array(vertices * 3), materialValues = new Float32Array(vertices * 2);
  colors.fill(.21404114);
  for (let v = 0; v < vertices; v++) { materialValues[v * 2] = 0; materialValues[v * 2 + 1] = .8; }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("texturePbr", new THREE.BufferAttribute(materialValues, 2));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute vec2 texturePbr; varying vec2 vTexturePbr;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTexturePbr = texturePbr;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 vTexturePbr;")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor *= vTexturePbr.y;")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor *= vTexturePbr.x;");
  };
  material.customProgramCacheKey = () => "triastasis-vertex-pbr-v1";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Texture preview"; mesh.rotation.x = -Math.PI / 2;
  const root = new THREE.Group(); root.add(mesh);
  const color = new THREE.Color();
  return { root, set(values: Float32Array) {
    if (values.length !== vertices * 6 || values.some(value => !Number.isFinite(value) || value < 0 || value > 1))
      throw new Error("Texture preview attribute dimensions are invalid");
    for (let v = 0; v < vertices; v++) {
      color.setRGB(values[v*6], values[v*6+1], values[v*6+2], THREE.SRGBColorSpace);
      colors.set([color.r, color.g, color.b], v * 3);
      materialValues[v*2] = values[v*6+3]; materialValues[v*2+1] = values[v*6+4];
    }
    geometry.getAttribute("color").needsUpdate = true; geometry.getAttribute("texturePbr").needsUpdate = true;
  }, dispose() { geometry.dispose(); material.dispose(); } };
}
