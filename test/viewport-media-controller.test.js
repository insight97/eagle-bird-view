"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createViewportMediaController } = require("../viewport-media-controller.js");

function createNode(
  id,
  {
    x = 0,
    width = 100,
    mediaHeight = 400,
    isVideo = false,
    isAudio = false,
    isPdfPage = false,
  } = {},
) {
  return {
    item: { id, ...(isPdfPage ? { isPdfPage } : {}) },
    x,
    y: 0,
    width,
    mediaHeight,
    height: mediaHeight,
    isVideo,
    isAudio,
  };
}

function createHarness({ nodes, selectedNode = null } = {}) {
  const timers = new Map();
  const calls = [];
  let nextTimerId = 0;
  let clock = 0;
  let renderRequests = 0;
  const state = {
    camera: { x: 0, y: 0, scale: 1 },
    nodes: nodes || [createNode("near")],
    selectedNode,
  };
  const materializer = {
    sync(plan) {
      calls.push({ type: "coverage", plan });
    },
    syncQuality(plan) {
      calls.push({ type: "quality", plan });
    },
  };
  const controller = createViewportMediaController({
    window: {
      setTimeout(callback, delay) {
        nextTimerId += 1;
        timers.set(nextTimerId, { callback, delay });
        return nextTimerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    now: () => clock,
    getSnapshot: () => ({
      rows: [{ top: 0, bottom: 400, nodes: state.nodes }],
      camera: state.camera,
      viewport: { width: 600, height: 400 },
      selectedNode: state.selectedNode,
      pixelRatio: 1,
    }),
    materializer,
    onSettled: () => calls.push({ type: "settled" }),
    requestRender: () => {
      renderRequests += 1;
    },
  });

  return {
    calls,
    controller,
    state,
    get pendingDelays() {
      return [...timers.values()].map(({ delay }) => delay);
    },
    get renderRequests() {
      return renderRequests;
    },
    advance(ms) {
      clock += ms;
    },
    fire() {
      const [id] = timers.keys();
      if (id === undefined) throw new Error("nothing scheduled");
      const { callback } = timers.get(id);
      timers.delete(id);
      callback();
    },
  };
}

test("a settled camera performs media coverage before the full maintenance callback", () => {
  const harness = createHarness();

  harness.controller.cameraChanged();
  harness.fire();

  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage", "settled"]);
});

test("continuous pan owns directional coverage and defers originals until it ends", () => {
  const near = createNode("near");
  const ahead = createNode("ahead", { x: 950 });
  const harness = createHarness({ nodes: [near, ahead] });

  harness.controller.cameraChanged();
  harness.fire();
  harness.calls.length = 0;

  harness.controller.beginMotion("pan");
  harness.state.camera = { x: -200, y: 0, scale: 1 };
  harness.controller.cameraChanged();
  harness.fire();

  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage"]);
  const panPlan = harness.calls[0].plan;
  assert.deepEqual(panPlan.loadNodes, [near, ahead]);
  assert.equal(panPlan.deferOriginals(near), true);
  assert.equal(panPlan.deferOriginals(ahead), true);
  assert.equal(panPlan.preserveOriginals, true);

  harness.calls.length = 0;
  harness.controller.endMotion("pan");

  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage", "settled"]);
  assert.equal(harness.calls[0].plan.preserveOriginals, false);
  assert.equal(harness.renderRequests, 1);
});

test("continuous pan refreshes media coverage within 120ms", () => {
  const harness = createHarness();

  harness.controller.cameraChanged();
  harness.fire();
  harness.calls.length = 0;

  harness.controller.beginMotion("pan");
  harness.state.camera = { x: -200, y: 0, scale: 1 };
  harness.controller.cameraChanged();

  assert.equal(harness.pendingDelays.length, 1);
  assert.ok(
    harness.pendingDelays[0] <= 120,
    `newly visible cards waited ${harness.pendingDelays[0]}ms for coverage`,
  );
});

test("continuous zoom evaluates quality but defers new originals until it settles", () => {
  const node = createNode("zoomed");
  const harness = createHarness({ nodes: [node] });

  harness.controller.beginMotion("zoom");
  harness.controller.cameraChanged();
  assert.deepEqual(harness.pendingDelays, [0]);
  harness.fire();

  assert.deepEqual(harness.calls.map(({ type }) => type), ["quality"]);
  assert.deepEqual(harness.calls[0].plan.loadNodes, [node]);
  assert.equal(harness.calls[0].plan.getQuality(node), "original");
  const zoomPlan = harness.calls[0].plan;
  assert.equal(zoomPlan.deferOriginals(node), true);
  assert.equal(
    zoomPlan.deferElementFallback(),
    true,
    "camera motion also keeps the blocking element fallback deferred",
  );

  harness.calls.length = 0;
  harness.controller.endMotion("zoom");
  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage", "settled"]);
  assert.equal(zoomPlan.deferElementFallback(), false, "a live plan sees the end of motion");
  assert.equal(harness.calls[0].plan.deferElementFallback(), false);
  assert.equal(harness.calls[0].plan.deferOriginals(node), false);

  harness.calls.length = 0;
  harness.controller.beginMotion("zoom");
  assert.deepEqual(harness.pendingDelays, [0], "a later zoom must not inherit an old throttle");
});

test("PDF pages always keep original quality so their canvas render is not canceled", () => {
  const page = createNode("manual:page:1", { mediaHeight: 180, isPdfPage: true });
  const harness = createHarness({ nodes: [page] });

  harness.controller.cameraChanged();
  harness.fire();

  const plan = harness.calls[0].plan;
  assert.equal(plan.getQuality(page), "original");
  assert.equal(plan.deferOriginals(page), false);
});

test("zooming in prewarms only the selected card", () => {
  const selected = createNode("selected", { x: 250 });
  const neighbor = createNode("neighbor", { x: 400 });
  const harness = createHarness({ nodes: [selected, neighbor], selectedNode: selected });

  harness.controller.beginMotion("zoom");
  harness.state.camera = { x: 0, y: 0, scale: 1.1 };
  harness.controller.cameraChanged();
  harness.fire();

  const zoomInPlan = harness.calls.at(-1).plan;
  assert.equal(zoomInPlan.prewarmRaster(selected), true);
  assert.equal(zoomInPlan.prewarmRaster(neighbor), false);
  assert.equal(zoomInPlan.prioritizeOriginal(selected), true);
  assert.equal(zoomInPlan.prioritizeOriginal(neighbor), false);

  harness.calls.length = 0;
  harness.state.camera = { x: 0, y: 0, scale: 0.9 };
  harness.controller.cameraChanged();
  harness.advance(120);
  harness.fire();

  assert.equal(harness.calls.at(-1).plan.prewarmRaster(selected), false);
});

test("zooming in prewarms the card nearest the viewport center when none is selected", () => {
  const edge = createNode("edge", { x: 0 });
  const center = createNode("center", { x: 250 });
  const harness = createHarness({ nodes: [edge, center] });

  harness.controller.beginMotion("zoom");
  harness.state.camera = { x: 0, y: 0, scale: 1.1 };
  harness.controller.cameraChanged();
  harness.fire();

  const plan = harness.calls.at(-1).plan;
  assert.equal(plan.prewarmRaster(center), true);
  assert.equal(plan.prewarmRaster(edge), false);
  assert.equal(plan.prioritizeOriginal(center), true);
  assert.equal(plan.prioritizeOriginal(edge), false);
});

test("focus suppresses viewport work until the motion ends", () => {
  const harness = createHarness();

  harness.controller.beginMotion("focus");
  harness.controller.cameraChanged();

  assert.deepEqual(harness.pendingDelays, []);
  assert.deepEqual(harness.calls, []);

  harness.controller.endMotion("focus");
  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage", "settled"]);
});

test("discrete motion uses its semantic mode, then settles through the idle window", () => {
  const harness = createHarness();

  harness.controller.noteMotion("pan");
  harness.controller.cameraChanged();
  harness.fire();
  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage"]);
  assert.equal(harness.calls[0].plan.preserveOriginals, true);

  harness.calls.length = 0;
  harness.advance(180);
  harness.fire();

  assert.deepEqual(harness.calls.map(({ type }) => type), ["coverage", "settled"]);
  assert.equal(harness.calls[0].plan.preserveOriginals, false);
});

test("selection can request an original while video quality stays thumbnail", () => {
  const selected = createNode("selected", { mediaHeight: 100 });
  const video = createNode("video", { mediaHeight: 500, isVideo: true });
  const harness = createHarness({ nodes: [selected, video], selectedNode: selected });

  harness.controller.cameraChanged();
  harness.fire();

  const plan = harness.calls[0].plan;
  assert.equal(plan.getQuality(selected), "original");
  assert.equal(plan.getQuality(video), "thumbnail");
});

test("selection keeps audio quality at thumbnail while playback stays available", () => {
  const audio = createNode("audio", { mediaHeight: 500, isAudio: true });
  const harness = createHarness({ nodes: [audio], selectedNode: audio });

  harness.controller.cameraChanged();
  harness.fire();

  assert.equal(harness.calls[0].plan.getQuality(audio), "thumbnail");
});
