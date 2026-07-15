"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LAYOUT_GAP,
  TARGET_ROW_HEIGHT,
  VIDEO_CONTROLS_HEIGHT,
  createJustifiedLayout,
  findNodesNearViewport,
  getAspectRatio,
} = require("../bird-view-core.js");

test("getAspectRatio accepts numeric strings and falls back for invalid dimensions", () => {
  assert.equal(getAspectRatio({ width: "300", height: "200" }), 1.5);
  assert.equal(getAspectRatio({ width: 0, height: 200 }), 1.6);
  assert.equal(getAspectRatio({ width: 300, height: "unknown" }), 1.6);
});

test("createJustifiedLayout keeps the final row at target height", () => {
  const item = { id: "one", width: 1600, height: 1000, ext: "jpg" };
  const layout = createJustifiedLayout([item]);

  assert.equal(layout.rows.length, 1);
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.nodes[0].height, TARGET_ROW_HEIGHT);
  assert.equal(layout.nodes[0].width, 288);
  assert.equal(layout.nodes[0].item, item);
});

test("createJustifiedLayout justifies completed rows and reserves video controls", () => {
  const items = [
    { id: "video", width: 4000, height: 1000, ext: "MP4" },
    { id: "image", width: 4000, height: 1000, ext: "jpg" },
    { id: "next", width: 1000, height: 1000, ext: "jpg" },
  ];
  const layout = createJustifiedLayout(items);
  const firstRowHeight = (1200 - LAYOUT_GAP) / 8;

  assert.equal(layout.rows.length, 2);
  assert.equal(layout.rows[0].bottom, firstRowHeight);
  assert.equal(
    layout.rows[1].top,
    firstRowHeight + VIDEO_CONTROLS_HEIGHT + LAYOUT_GAP,
  );
  assert.equal(layout.nodes[0].isVideo, true);
  assert.equal(layout.nodes[1].x, layout.nodes[0].width + LAYOUT_GAP);
});

test("findNodesNearViewport observes camera scale, boundaries, and margin", () => {
  const a = { x: 0, width: 100 };
  const b = { x: 120, width: 100 };
  const c = { x: 0, width: 100 };
  const rows = [
    { top: 0, bottom: 100, nodes: [a, b] },
    { top: 120, bottom: 220, nodes: [c] },
  ];
  const camera = { x: 0, y: 0, scale: 1 };

  assert.deepEqual(findNodesNearViewport(rows, camera, { width: 100, height: 100 }, 0), [a]);
  assert.deepEqual(findNodesNearViewport(rows, camera, { width: 100, height: 100 }, 20), [a, b, c]);
  assert.deepEqual(
    findNodesNearViewport(rows, { x: -180, y: 0, scale: 2 }, { width: 100, height: 100 }, 0),
    [a, b],
  );
});
