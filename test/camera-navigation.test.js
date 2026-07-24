"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCameraNavigation } = require("../camera-navigation.js");

function createHarness() {
  const frames = new Map();
  let nextFrame = 1;
  let currentTime = 0;
  const updates = [];
  let centeredSelections = 0;
  const state = {
    camera: { x: 0, y: 0, scale: 1 },
    cameraFocusFrame: null,
    seamlessMode: false,
    rows: [],
    selectedNode: null,
    smoothPanEnabled: false,
    smoothPanSpeed: 480,
    smoothPanKeys: new Set(),
    smoothPanFrame: null,
    smoothPanLastTimestamp: null,
    smoothZoomEnabled: false,
    smoothZoomSpeed: 1.5,
    smoothZoomKeys: new Set(),
    smoothZoomFrame: null,
    smoothZoomLastTimestamp: null,
  };
  const elements = {
    viewport: { clientWidth: 800, clientHeight: 600 },
  };
  const navigation = createCameraNavigation({
    state,
    elements,
    getBaseScale: () => 1,
    updateCamera: () => updates.push({ ...state.camera }),
    selectNodeAtViewportCenter: () => { centeredSelections += 1; },
    getFocusRowEmphasis: () => (state.seamlessMode ? 1.1 : undefined),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    now: () => currentTime,
  });

  return {
    centeredSelections: () => centeredSelections,
    frames,
    navigation,
    setTime(time) {
      currentTime = time;
    },
    state,
    updates,
  };
}

test("camera navigation pans and zooms around the requested viewport point", () => {
  const harness = createHarness();

  harness.navigation.panBy(-40, 25);
  harness.navigation.zoomAtPoint(400, 300, 2);

  assert.deepEqual(harness.state.camera, { x: -480, y: -250, scale: 2 });
  assert.equal(harness.updates.length, 2);
});

test("camera navigation animates a selected node and cancels the pending focus", () => {
  const harness = createHarness();
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 120, bottom: 220, nodes: [node] }];
  harness.state.selectedNode = node;

  harness.navigation.focusSelectedNodeAtRowScale(node);

  assert.notEqual(harness.state.cameraFocusFrame, null);
  const focusFrame = harness.state.cameraFocusFrame;
  harness.frames.get(focusFrame)(180);

  assert.equal(harness.state.cameraFocusFrame, null);
  assert.equal(harness.state.camera.scale, 1.62);
  assert.ok(Math.abs((400 - harness.state.camera.x) / harness.state.camera.scale - 200) < 0.001);
  assert.ok(Math.abs((300 - harness.state.camera.y) / harness.state.camera.scale - 170) < 0.001);

  harness.navigation.animateCameraTo({ x: 0, y: 0, scale: 1 });
  const nextFocusFrame = harness.state.cameraFocusFrame;
  harness.navigation.cancelCameraFocus();
  assert.equal(harness.state.cameraFocusFrame, null);
  assert.equal(harness.frames.has(nextFocusFrame), false);
});

test("camera navigation enlarges focus scale in seamless mode", () => {
  const harness = createHarness();
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 120, bottom: 220, nodes: [node] }];
  harness.state.selectedNode = node;
  harness.state.seamlessMode = true;

  harness.navigation.focusSelectedNodeAtRowScale(node);
  const focusFrame = harness.state.cameraFocusFrame;
  harness.frames.get(focusFrame)(180);

  assert.ok(Math.abs(harness.state.camera.scale - 1.98) < Number.EPSILON * 10);
});

test("smooth keyboard pan keeps moving until the key is released", () => {
  const harness = createHarness();
  harness.state.smoothPanEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");

  const firstFrame = harness.state.smoothPanFrame;
  harness.frames.get(firstFrame)(16);
  assert.ok(harness.state.camera.x < 0);

  harness.navigation.handleKeyUp("ArrowRight");
  assert.equal(harness.state.smoothPanFrame, null);
  assert.equal(harness.centeredSelections(), 1);
});
