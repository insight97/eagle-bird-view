"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCameraNavigation } = require("../camera-navigation.js");

function createHarness(focusTargetHeight = 180, focusCallbacks = {}) {
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
    smoothPanVelocity: { x: 0, y: 0 },
    smoothZoomEnabled: false,
    smoothZoomSpeed: 1.5,
    keyboardAcceleration: 16,
    smoothZoomKeys: new Set(),
    smoothZoomFrame: null,
    smoothZoomLastTimestamp: null,
    smoothZoomVelocity: 0,
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
    ...focusCallbacks,
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

test("camera navigation allows zooming up to 1200 percent", () => {
  const harness = createHarness();

  harness.navigation.zoomAtPoint(400, 300, 100);

  assert.equal(harness.state.camera.scale, 12);
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

test("camera navigation reports the animated focus lifecycle", () => {
  const events = [];
  const harness = createHarness(180, {
    onFocusStart: () => events.push("start"),
    onFocusEnd: () => events.push("end"),
  });
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 120, bottom: 220, nodes: [node] }];
  harness.state.selectedNode = node;

  harness.navigation.focusSelectedNodeAtRowScale(node);

  assert.deepEqual(events, ["start"]);
  harness.frames.get(harness.state.cameraFocusFrame)(180);
  assert.deepEqual(events, ["start", "end"]);
});

test("camera navigation ends the focus lifecycle when canceled", () => {
  const events = [];
  const harness = createHarness(180, {
    onFocusStart: () => events.push("start"),
    onFocusEnd: () => events.push("end"),
  });
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  harness.state.rows = [{ top: 120, bottom: 220, nodes: [node] }];
  harness.state.selectedNode = node;

  harness.navigation.focusSelectedNodeAtRowScale(node);
  harness.navigation.cancelCameraFocus();

  assert.deepEqual(events, ["start", "end"]);
});

test("camera navigation can read rows from the board without state rows", () => {
  const harness = createHarness();
  const node = { x: 100, y: 120, width: 200, mediaHeight: 100, isVideo: false };
  const boardRows = [{ top: 120, bottom: 220, nodes: [node] }];
  delete harness.state.rows;
  harness.state.selectedNode = node;

  const navigation = createCameraNavigation({
    state: harness.state,
    elements: { viewport: { clientWidth: 800, clientHeight: 600 } },
    getBaseScale: () => 1,
    updateCamera: () => {},
    getRows: () => boardRows,
    requestAnimationFrame(callback) {
      callback(180);
      return 1;
    },
    cancelAnimationFrame() {},
    now: () => 0,
  });

  assert.doesNotThrow(() => navigation.focusSelectedNodeAtRowScale(node));
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

test("smooth keyboard pan accelerates and decelerates around key release", () => {
  const harness = createHarness();
  harness.state.smoothPanEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");

  const firstFrame = harness.state.smoothPanFrame;
  harness.frames.get(firstFrame)(16);
  assert.ok(harness.state.camera.x < 0);
  const xAtRelease = harness.state.camera.x;

  harness.navigation.handleKeyUp("ArrowRight");
  assert.notEqual(harness.state.smoothPanFrame, null);
  assert.equal(harness.centeredSelections(), 0);
  harness.frames.get(harness.state.smoothPanFrame)(32);
  assert.ok(harness.state.camera.x < xAtRelease);

  for (let timestamp = 48; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothPanFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }
  assert.equal(harness.state.smoothPanFrame, null);
  assert.equal(harness.centeredSelections(), 1);
});

test("smooth keyboard pan drops its imperceptible low-speed tail promptly", () => {
  let timestamp = 0;
  let endedAt = null;
  const harness = createHarness(180, {
    onSmoothPanEnd: () => {
      endedAt = timestamp;
    },
  });
  harness.state.smoothPanEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");

  for (timestamp = 16; timestamp <= 208; timestamp += 16) {
    harness.frames.get(harness.state.smoothPanFrame)(timestamp);
  }
  const releasedAt = timestamp - 16;
  const xAtRelease = harness.state.camera.x;
  harness.navigation.handleKeyUp("ArrowRight");

  for (timestamp = releasedAt + 16; timestamp <= releasedAt + 500; timestamp += 16) {
    const frame = harness.state.smoothPanFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }

  assert.ok(harness.state.camera.x < xAtRelease, "the release should still decelerate");
  assert.notEqual(endedAt, null, "the motion lifecycle should end");
  assert.ok(
    endedAt - releasedAt <= 160,
    `the low-speed tail held back settled work for ${endedAt - releasedAt}ms`,
  );
});

test("smooth keyboard pan reports release before its deceleration ends", () => {
  const events = [];
  const harness = createHarness(180, {
    onSmoothPanRelease: () => events.push("release"),
    onSmoothPanEnd: () => events.push("end"),
  });
  harness.state.smoothPanEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");
  harness.frames.get(harness.state.smoothPanFrame)(16);

  harness.navigation.handleKeyUp("ArrowRight");

  assert.deepEqual(events, ["release"]);
  assert.notEqual(harness.state.smoothPanFrame, null);
  for (let timestamp = 32; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothPanFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }
  assert.deepEqual(events, ["release", "end"]);
});

test("smooth keyboard pan adapts its braking at the maximum configured speed", () => {
  let timestamp = 0;
  let endedAt = null;
  const harness = createHarness(180, {
    onSmoothPanEnd: () => {
      endedAt = timestamp;
    },
  });
  harness.state.smoothPanEnabled = true;
  harness.state.smoothPanSpeed = 6000;
  harness.navigation.startSmoothKeyboardPan("arrowright");

  for (timestamp = 16; timestamp <= 1024; timestamp += 16) {
    harness.frames.get(harness.state.smoothPanFrame)(timestamp);
  }
  const releasedAt = timestamp - 16;
  harness.navigation.handleKeyUp("ArrowRight");

  for (timestamp = releasedAt + 16; timestamp <= releasedAt + 500; timestamp += 16) {
    const frame = harness.state.smoothPanFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }

  assert.notEqual(endedAt, null, "the high-speed pan lifecycle should end");
  assert.ok(
    endedAt - releasedAt <= 160,
    `high-speed pan held back settled work for ${endedAt - releasedAt}ms`,
  );
});

test("smooth keyboard pan uses the shared keyboard acceleration", () => {
  const slow = createHarness();
  const fast = createHarness();
  slow.state.smoothPanEnabled = true;
  slow.state.keyboardAcceleration = 6;
  fast.state.smoothPanEnabled = true;
  fast.state.keyboardAcceleration = 24;

  slow.navigation.startSmoothKeyboardPan("arrowright");
  fast.navigation.startSmoothKeyboardPan("arrowright");
  slow.frames.get(slow.state.smoothPanFrame)(16);
  fast.frames.get(fast.state.smoothPanFrame)(16);

  assert.ok(fast.state.camera.x < slow.state.camera.x);
});

test("smooth keyboard pan still starts at the minimum speed and acceleration", () => {
  const harness = createHarness();
  harness.state.smoothPanEnabled = true;
  harness.state.smoothPanSpeed = 120;
  harness.state.keyboardAcceleration = 1;

  harness.navigation.startSmoothKeyboardPan("arrowright");
  harness.frames.get(harness.state.smoothPanFrame)(16);

  assert.ok(harness.state.camera.x < 0);
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

test("smooth keyboard zoom accelerates while held and decelerates after release", () => {
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
  assert.notEqual(harness.state.smoothZoomFrame, null);
  assert.equal(harness.state.smoothZoomKeys.size, 0);

  const scaleAtRelease = harness.state.camera.scale;
  const releaseFrame = harness.state.smoothZoomFrame;
  harness.frames.get(releaseFrame)(48);
  assert.ok(harness.state.camera.scale > scaleAtRelease);

  for (let timestamp = 64; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothZoomFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }
  assert.equal(harness.state.smoothZoomFrame, null);
  assert.equal(harness.state.smoothZoomVelocity, 0);
});

test("smooth keyboard zoom reports release before its deceleration ends", () => {
  const events = [];
  const harness = createHarness(180, {
    onSmoothZoomRelease: () => events.push("release"),
    onSmoothZoomEnd: () => events.push("end"),
  });
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageUp");
  harness.frames.get(harness.state.smoothZoomFrame)(16);

  harness.navigation.handleKeyUp("PageUp");

  assert.deepEqual(events, ["release"]);
  assert.notEqual(harness.state.smoothZoomFrame, null);
  for (let timestamp = 32; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothZoomFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }
  assert.deepEqual(events, ["release", "end"]);
});

test("smooth keyboard zoom adapts its braking at the maximum configured speed", () => {
  let timestamp = 0;
  let endedAt = null;
  const harness = createHarness(180, {
    onSmoothZoomEnd: () => {
      endedAt = timestamp;
    },
  });
  harness.state.smoothZoomEnabled = true;
  harness.state.smoothZoomSpeed = 60;
  harness.navigation.startSmoothKeyboardZoom("PageUp");

  for (timestamp = 16; timestamp <= 1024; timestamp += 16) {
    harness.frames.get(harness.state.smoothZoomFrame)(timestamp);
  }
  const releasedAt = timestamp - 16;
  harness.navigation.handleKeyUp("PageUp");

  for (timestamp = releasedAt + 16; timestamp <= releasedAt + 800; timestamp += 16) {
    const frame = harness.state.smoothZoomFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }

  assert.notEqual(endedAt, null, "the high-speed zoom lifecycle should end");
  assert.ok(
    endedAt - releasedAt <= 160,
    `high-speed zoom held back settled work for ${endedAt - releasedAt}ms`,
  );
});

test("smooth keyboard zoom reads the viewport once per gesture", () => {
  let viewportReads = 0;
  const harness = createHarness(180, {
    getViewportSize: () => {
      viewportReads += 1;
      return { width: 1000, height: 500 };
    },
  });
  harness.state.smoothZoomEnabled = true;

  harness.navigation.startSmoothKeyboardZoom("PageUp");
  harness.frames.get(harness.state.smoothZoomFrame)(16);
  harness.frames.get(harness.state.smoothZoomFrame)(32);

  assert.equal(viewportReads, 1);
  assert.ok(
    Math.abs((500 - harness.state.camera.x) / harness.state.camera.scale - 500) < 0.001,
  );
  assert.ok(
    Math.abs((250 - harness.state.camera.y) / harness.state.camera.scale - 250) < 0.001,
  );
});

test("smooth keyboard zoom uses the configured acceleration response", () => {
  const slow = createHarness();
  const fast = createHarness();
  slow.state.smoothZoomEnabled = true;
  slow.state.keyboardAcceleration = 6;
  fast.state.smoothZoomEnabled = true;
  fast.state.keyboardAcceleration = 24;

  slow.navigation.startSmoothKeyboardZoom("PageUp");
  fast.navigation.startSmoothKeyboardZoom("PageUp");
  slow.frames.get(slow.state.smoothZoomFrame)(16);
  fast.frames.get(fast.state.smoothZoomFrame)(16);

  assert.ok(fast.state.camera.scale > slow.state.camera.scale);
});

test("smooth keyboard zoom reports its active lifecycle", () => {
  let starts = 0;
  let ends = 0;
  const harness = createHarness(180, {
    onSmoothZoomStart: () => { starts += 1; },
    onSmoothZoomEnd: () => { ends += 1; },
  });

  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageUp");
  assert.equal(starts, 1);
  assert.equal(ends, 0);

  harness.navigation.handleKeyUp("PageUp");
  for (let timestamp = 16; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothZoomFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }

  assert.equal(starts, 1);
  assert.equal(ends, 1);
});

test("smooth keyboard pan reports its active lifecycle", () => {
  let starts = 0;
  let ends = 0;
  const harness = createHarness(180, {
    onSmoothPanStart: () => { starts += 1; },
    onSmoothPanEnd: () => { ends += 1; },
  });

  harness.state.smoothPanEnabled = true;
  harness.navigation.startSmoothKeyboardPan("arrowright");
  assert.equal(starts, 1);
  assert.equal(ends, 0);

  harness.navigation.handleKeyUp("arrowright");
  for (let timestamp = 16; timestamp <= 1000; timestamp += 16) {
    const frame = harness.state.smoothPanFrame;
    if (frame === null) break;
    harness.frames.get(frame)(timestamp);
  }

  assert.equal(starts, 1);
  assert.equal(ends, 1);
});

test("smooth keyboard zoom brakes when both directions are held", () => {
  const harness = createHarness();
  harness.state.smoothZoomEnabled = true;
  harness.navigation.startSmoothKeyboardZoom("PageDown");

  harness.frames.get(harness.state.smoothZoomFrame)(16);
  const zoomedOut = harness.state.camera.scale;
  assert.ok(zoomedOut < 1);

  harness.navigation.startSmoothKeyboardZoom("PageUp");
  harness.frames.get(harness.state.smoothZoomFrame)(32);
  assert.ok(harness.state.camera.scale < zoomedOut);
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
  assert.deepEqual(harness.state.smoothPanVelocity, { x: 0, y: 0 });
});
