"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCameraNavigation } = require("../camera-navigation.js");

function createHarness(focusTargetHeight = 180) {
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
    getFocusTargetHeight: () => focusTargetHeight,
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

test("camera navigation uses the configured focus media size", () => {
  const harness = createHarness(240);
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 120, bottom: 220, nodes: [node] }];
  harness.state.selectedNode = node;

  harness.navigation.focusSelectedNodeAtRowScale(node);
  harness.frames.get(harness.state.cameraFocusFrame)(180);

  assert.ok(Math.abs(harness.state.camera.scale - 2.16) < Number.EPSILON * 10);
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

test("Shift+arrow pans two thirds of a viewport and derives the key pan step", () => {
  const harness = createHarness();
  harness.state.smoothPanSpeed = 500;

  assert.equal(harness.navigation.getKeyboardPanStep(), 250);

  harness.navigation.panOneViewport("ArrowRight");
  assert.ok(Math.abs(harness.state.camera.x + 800 * (2 / 3)) < 0.001);

  harness.navigation.panOneViewport("ArrowUp");
  assert.equal(harness.state.camera.y, 400);

  harness.navigation.panOneViewport("Escape");
  assert.equal(harness.updates.length, 2);
});

test("animating to the current camera skips the frame loop", () => {
  const harness = createHarness();

  harness.navigation.animateCameraTo({ x: 0, y: 0, scale: 1 });
  assert.equal(harness.state.cameraFocusFrame, null);
  assert.equal(harness.updates.length, 1);

  harness.navigation.animateCameraTo({ x: 40, y: 60, scale: 2 }, { animate: false });
  assert.equal(harness.state.cameraFocusFrame, null);
  assert.deepEqual(harness.state.camera, { x: 40, y: 60, scale: 2 });
});

test("End fits the whole selected row inside the padded viewport", () => {
  const harness = createHarness();
  const first = { x: 0, y: 0, width: 200, mediaHeight: 100, isVideo: false };
  const second = { x: 220, y: 0, width: 180, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 0, bottom: 100, nodes: [first, second] }];
  harness.state.selectedNode = second;

  harness.navigation.fitSelectedRowInViewport();
  harness.frames.get(harness.state.cameraFocusFrame)(180);

  // The row spans 400x100 and the viewport is 800x600 with 64px padding, so
  // width is the binding constraint: 672 / 400.
  assert.equal(harness.state.camera.scale, 1.68);
  assert.ok(Math.abs((400 - harness.state.camera.x) / harness.state.camera.scale - 200) < 0.001);
  assert.ok(Math.abs((300 - harness.state.camera.y) / harness.state.camera.scale - 50) < 0.001);
});

test("fitting a row accounts for video control height and stops smooth motion", () => {
  const harness = createHarness();
  const node = { x: 0, y: 0, width: 400, mediaHeight: 100, isVideo: true };
  harness.state.rows = [{ top: 0, bottom: 100, nodes: [node] }];
  harness.state.selectedNode = node;
  harness.state.smoothPanEnabled = true;
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");
  harness.navigation.startSmoothKeyboardZoom("PageUp");

  harness.navigation.fitSelectedRowInViewport();

  assert.equal(harness.state.smoothPanFrame, null);
  assert.equal(harness.state.smoothZoomFrame, null);

  harness.frames.get(harness.state.cameraFocusFrame)(180);
  // The 8px control strip makes the row 400x108, so it is centred on y = 54.
  assert.ok(Math.abs((300 - harness.state.camera.y) / harness.state.camera.scale - 54) < 0.001);
});

test("fitting a row does nothing without a selected node or a matching row", () => {
  const harness = createHarness();
  harness.navigation.fitSelectedRowInViewport();
  assert.equal(harness.updates.length, 0);

  const node = { x: 0, y: 0, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.selectedNode = node;
  harness.state.rows = [{ top: 0, bottom: 100, nodes: [] }];
  harness.navigation.fitSelectedRowInViewport();
  assert.equal(harness.updates.length, 0);
});

test("smooth keyboard zoom accelerates while held and stops on key release", () => {
  const harness = createHarness();
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageUp");

  harness.frames.get(harness.state.smoothZoomFrame)(16);
  const zoomedIn = harness.state.camera.scale;
  assert.ok(zoomedIn > 1);
  // Zooming keeps the viewport centre pinned.
  assert.ok(Math.abs((400 - harness.state.camera.x) / zoomedIn - 400) < 0.001);

  harness.frames.get(harness.state.smoothZoomFrame)(32);
  assert.ok(harness.state.camera.scale > zoomedIn);

  harness.navigation.handleKeyUp("PageUp");
  assert.equal(harness.state.smoothZoomFrame, null);
  assert.equal(harness.state.smoothZoomKeys.size, 0);
});

test("smooth keyboard zoom reverses for PageDown and cancels when both keys are held", () => {
  const harness = createHarness();
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageDown");

  harness.frames.get(harness.state.smoothZoomFrame)(16);
  const zoomedOut = harness.state.camera.scale;
  assert.ok(zoomedOut < 1);

  harness.navigation.startSmoothKeyboardZoom("PageUp");
  harness.frames.get(harness.state.smoothZoomFrame)(32);
  assert.equal(harness.state.camera.scale, zoomedOut);
});

test("smooth keyboard zoom stops itself once the setting is turned off", () => {
  const harness = createHarness();
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageUp");

  harness.state.smoothZoomEnabled = false;
  harness.frames.get(harness.state.smoothZoomFrame)(16);

  assert.equal(harness.state.smoothZoomFrame, null);
  assert.equal(harness.state.camera.scale, 1);
});

test("losing window focus stops both smooth pan and smooth zoom", () => {
  const harness = createHarness();
  harness.state.smoothPanEnabled = true;
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowleft");
  harness.navigation.startSmoothKeyboardZoom("PageUp");

  harness.navigation.handleWindowBlur();

  assert.equal(harness.state.smoothPanFrame, null);
  assert.equal(harness.state.smoothZoomFrame, null);
  assert.equal(harness.state.smoothPanKeys.size, 0);
  assert.equal(harness.state.smoothZoomKeys.size, 0);
});
