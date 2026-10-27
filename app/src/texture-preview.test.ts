import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createTexturePreview } from "./texture-preview";

function surface() {
  const bytes = new ArrayBuffer(56); new Uint32Array(bytes, 0, 2).set([3,1]);
  new Float32Array(bytes, 8, 9).set([-.6,0,0, 0,.6,0, 0,0,.1]); new Int32Array(bytes, 44, 3).set([0,1,2]); return bytes;
}
test("preview keeps one surface and treats RGB, metallic and roughness in their correct color spaces", () => {
  const preview = createTexturePreview(surface());
  const mesh = preview.root.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  const geometry = mesh.geometry;
  preview.set(new Float32Array([.5,.5,.5,.2,.8,1, .5,.5,.5,.2,.8,1, .5,.5,.5,.2,.8,1]));
  assert.ok(Math.abs(geometry.getAttribute("color").getX(0) - .21404114) < 1e-6);
  assert.ok(Math.abs(geometry.getAttribute("texturePbr").getX(0) - .2) < 1e-6);
  assert.ok(Math.abs(geometry.getAttribute("texturePbr").getY(0) - .8) < 1e-6);
  preview.set(new Float32Array(18).fill(.3)); assert.equal(mesh.geometry, geometry);
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  mesh.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  assert.match(shader.vertexShader, /vTexturePbr = texturePbr/);
  assert.match(shader.fragmentShader, /roughnessFactor \*= vTexturePbr.y/);
  assert.match(shader.fragmentShader, /metalnessFactor \*= vTexturePbr.x/);
  assert.equal(mesh.material.transparent, false);
  preview.dispose();
});
test("preview rejects invalid indices and nonfinite attributes before GPU upload", () => {
  const bytes = surface(); new Int32Array(bytes, 44, 3)[0] = 99;
  assert.throws(() => createTexturePreview(bytes), /invalid geometry/);
  const preview = createTexturePreview(surface()); const values = new Float32Array(18); values[0] = NaN;
  assert.throws(() => preview.set(values), /invalid/); preview.dispose();
});
