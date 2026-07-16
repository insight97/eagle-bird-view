"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  directionFor,
  createJustifiedLayout,
  findNearestNodeInRows,
  findNearestNodeToPoint,
  getItemRating,
  getLabelDetailLevel,
  getLabelRect,
  getViewportPanDelta,
  getViewportWorldCenter,
  isPlayingVideo,
  normalizeTagColor,
  zoomCameraAtPoint,
} = require("../bird-view-core.js");

test("getLabelRect projects a node into rounded screen coordinates", () => {
  assert.deepEqual(
    getLabelRect(
      { x: 10.2, y: 20.4, width: 100.2 },
      { x: 5, y: -3, scale: 1.5 },
    ),
    { left: 20, top: -23, width: 150, height: 46 },
  );
});

test("getItemRating accepts Eagle stars and clamps invalid values", () => {
  assert.equal(getItemRating({ star: 3 }), 3);
  assert.equal(getItemRating({ star: "5" }), 5);
  assert.equal(getItemRating({ rating: 2 }), 2);
  assert.equal(getItemRating({ star: 9 }), 5);
  assert.equal(getItemRating({ star: -1 }), 0);
  assert.equal(getItemRating({ star: "unknown" }), 0);
});

test("label details progressively hide as media gets smaller", () => {
  assert.equal(getLabelDetailLevel(0.7, 1.7), "details");
  assert.equal(getLabelDetailLevel(0.5, 1.2), "name");
  assert.equal(getLabelDetailLevel(0.2, 3), "hidden");
  assert.equal(getLabelDetailLevel(1, 0.9), "hidden");
});

test("normalizeTagColor maps Eagle colors and falls back safely", () => {
  assert.equal(normalizeTagColor("blue"), "#5d91d8");
  assert.equal(normalizeTagColor("#ABC"), "#abc");
  assert.equal(normalizeTagColor("#12abef"), "#12abef");
  assert.equal(normalizeTagColor("not-a-color"), "#858a93");
  assert.equal(normalizeTagColor(), "#858a93");
});

test("directionFor normalizes arrow keys and WASD", () => {
  assert.deepEqual(directionFor("ArrowLeft"), [-1, 0]);
  assert.deepEqual(directionFor("W"), [0, -1]);
  assert.equal(directionFor("Enter"), undefined);
});

test("getViewportPanDelta moves two-thirds of the relevant viewport axis", () => {
  assert.deepEqual(getViewportPanDelta("ArrowRight", { width: 900, height: 600 }), {
    x: -600,
    y: 0,
  });
  assert.deepEqual(getViewportPanDelta("ArrowUp", { width: 900, height: 600 }), {
    x: 0,
    y: 400,
  });
});

test("findNearestNodeToPoint prefers the item beneath the viewport center", () => {
  const first = { x: 0, y: 0, width: 100, height: 100 };
  const second = { x: 120, y: 0, width: 100, height: 100 };
  const center = getViewportWorldCenter(
    { x: -190, y: 0, scale: 2 },
    { width: 100, height: 100 },
  );

  assert.deepEqual(center, { x: 120, y: 25 });
  assert.equal(findNearestNodeToPoint([first, second], center), second);
  assert.equal(findNearestNodeToPoint([first, second], { x: 109, y: 50 }), first);
  assert.equal(findNearestNodeToPoint([first, second], { x: 111, y: 50 }), second);
});

test("row-indexed nearest selection matches a full node scan", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    id: `item-${index}`,
    width: 100 + (index % 5) * 70,
    height: 100 + (index % 3) * 40,
    ext: index % 9 === 0 ? "mp4" : "jpg",
  }));
  const layout = createJustifiedLayout(items);
  const points = [
    { x: 400, y: 90 },
    { x: 1100, y: 350 },
    { x: -500, y: 700 },
    { x: 2000, y: 1200 },
    { x: 600, y: 10000 },
  ];

  for (const point of points) {
    assert.equal(
      findNearestNodeInRows(layout.rows, point),
      findNearestNodeToPoint(layout.nodes, point),
    );
  }
  assert.equal(findNearestNodeInRows([], { x: 0, y: 0 }), null);
});

test("video controls take over ctrl arrows only during playback", () => {
  assert.equal(isPlayingVideo(null), false);
  assert.equal(isPlayingVideo({ paused: true }), false);
  assert.equal(isPlayingVideo({ paused: false }), true);
});

test("zoomCameraAtPoint preserves the world coordinate beneath the pointer", () => {
  const camera = { x: 30, y: -20, scale: 2 };
  const point = { x: 330, y: 180 };
  const before = {
    x: (point.x - camera.x) / camera.scale,
    y: (point.y - camera.y) / camera.scale,
  };
  const next = zoomCameraAtPoint(camera, point, 1.5, 2, 0.08, 8);

  assert.equal((point.x - next.x) / next.scale, before.x);
  assert.equal((point.y - next.y) / next.scale, before.y);
  assert.equal(next.scale, 3);
});

test("zoomCameraAtPoint clamps zoom to the configured range", () => {
  assert.equal(zoomCameraAtPoint({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 100, 1, 0.08, 8).scale, 8);
  assert.equal(zoomCameraAtPoint({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 0.001, 1, 0.08, 8).scale, 0.08);
});
