import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Viewer } from "./viewer";

// Exercise the real adoption/framing methods without constructing a WebGL renderer.
function framingViewer() {
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.001, 100);
  const fixture = Object.assign(Object.create(Viewer.prototype), {
    disposed: false, loadedRoot: null, userCameraView: false,
    scene: new THREE.Scene(), bounds: new THREE.Box3(), cameraType: "perspective",
    perspectiveCamera: camera, activeCamera: camera,
    orthographicCamera: new THREE.OrthographicCamera(), orthoHeight: 1,
    controls: { target: new THREE.Vector3(), update() {} },
    clearModel() {}, buildTopologyLines() {}, rebuildHelpers() {}, setDisplayMode() {},
    updateTopologyVisibility() {}, getStats() { return {}; },
  });
  fixture.collectLoadedStats = () => fixture.bounds.setFromObject(fixture.loadedRoot);
  return fixture as Viewer & typeof fixture;
}
function shape(x: number, y: number, z: number) {
  return new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshBasicMaterial());
}

test("switching from an automatically fitted thin model to a cube fits the cube", () => {
  const viewer = framingViewer();
  viewer.loadRoot(shape(0.1, 0.1, 1));
  const thinDistance = viewer.activeCamera.position.distanceTo(viewer.controls.target);
  viewer.loadRoot(shape(1, 1, 1));
  const cubeDistance = viewer.activeCamera.position.distanceTo(viewer.controls.target);
  assert.ok(cubeDistance > thinDistance * 1.6, "the previous tight automatic fit must not replace the new bounds fit");
});

test("deliberate orbit/zoom survives model adoption, but Reset view resumes automatic fitting", () => {
  const viewer = framingViewer();
  viewer.loadRoot(shape(0.1, 0.1, 1));
  viewer.activeCamera.position.set(0, 0, 5);
  viewer.userCameraView = true; // A controls start event records a deliberate camera adjustment.
  viewer.loadRoot(shape(1, 1, 1));
  assert.equal(viewer.activeCamera.position.distanceTo(viewer.controls.target), 5);
  assert.equal(viewer.activeCamera.position.x, 0);
  viewer.resetView();
  viewer.loadRoot(shape(0.1, 0.1, 1));
  assert.ok(viewer.activeCamera.position.distanceTo(viewer.controls.target) < 2);
});
