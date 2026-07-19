"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  centerCameraAtPoint,
  directionFor,
  createJustifiedLayout,
  findDirectionalNeighbor,
  findNearestNodeInRows,
  findNearestNodeToPoint,
  formatFileSize,
  formatItemDimensions,
  getItemRating,
  getNextRating,
  getLabelDetailLevel,
  getLabelRect,
  getPanLayerTranslation,
  getWrappedGridTranslation,
  getViewportWorkInterval,
  getTagColorStyle,
  getViewportPanDelta,
  getViewportWorldCenter,
  isPlayingVideo,
  normalizeTags,
  normalizeTagColor,
  rankTagMatches,
  resizeCamera,
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

test("centerCameraAtPoint keeps a selected item centered at the current zoom", () => {
  const camera = centerCameraAtPoint(
    { x: 20, y: 30, scale: 2 },
    { x: 300, y: 200 },
    { width: 1000, height: 600 },
  );

  assert.deepEqual(camera, { x: -100, y: -100, scale: 2 });
  assert.deepEqual(getViewportWorldCenter(camera, { width: 1000, height: 600 }), {
    x: 300,
    y: 200,
  });
});

test("getItemRating accepts Eagle stars and clamps invalid values", () => {
  assert.equal(getItemRating({ star: 3 }), 3);
  assert.equal(getItemRating({ star: "5" }), 5);
  assert.equal(getItemRating({ rating: 2 }), 2);
  assert.equal(getItemRating({ star: 9 }), 5);
  assert.equal(getItemRating({ star: -1 }), 0);
  assert.equal(getItemRating({ star: "unknown" }), 0);
});

test("item dimensions and file sizes use compact readable labels", () => {
  assert.equal(formatItemDimensions({ width: 1920, height: 1080 }), "1920 × 1080");
  assert.equal(formatItemDimensions({ width: 0, height: 1080 }), "");
  assert.equal(formatFileSize(850), "850 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(2.4 * 1024 * 1024), "2.4 MB");
  assert.equal(formatFileSize(), "");
});

test("getNextRating selects a star and clears the active rating", () => {
  assert.equal(getNextRating(2, 4), 4);
  assert.equal(getNextRating(4, 4), 0);
  assert.equal(getNextRating(0, 9), 5);
});

test("normalizeTags trims, removes blanks, and preserves unique order", () => {
  assert.deepEqual(normalizeTags([" UI ", "", "Photo", "UI", null]), ["UI", "Photo"]);
  assert.deepEqual(normalizeTags(), []);
});

test("rankTagMatches puts exact and prefix matches before other contains matches", () => {
  assert.deepEqual(
    rankTagMatches(["Web Design", "Designer", "Design", "UI Design", "Photo"], "design"),
    ["Design", "Designer", "UI Design", "Web Design"],
  );
});

test("label details progressively hide as media gets smaller", () => {
  assert.equal(getLabelDetailLevel(0.5, 1.5), "details");
  assert.equal(getLabelDetailLevel(0.49, 1.5), "name");
  assert.equal(getLabelDetailLevel(0.5, 1.49), "name");
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

test("getTagColorStyle returns Chromium-compatible explicit colors", () => {
  assert.deepEqual(getTagColorStyle("blue"), {
    color: "#7aa5df",
    background: "rgba(93, 145, 216, 0.24)",
  });
  assert.deepEqual(getTagColorStyle("#abc"), {
    color: "#b9c7d5",
    background: "rgba(170, 187, 204, 0.24)",
  });
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

test("getPanLayerTranslation reuses label positions only while scale is unchanged", () => {
  const anchor = { x: 10, y: 20, scale: 2 };
  assert.deepEqual(getPanLayerTranslation({ x: 35, y: 5, scale: 2 }, anchor), {
    x: 25,
    y: -15,
  });
  assert.equal(getPanLayerTranslation({ x: 35, y: 5, scale: 3 }, anchor), null);
  assert.equal(getPanLayerTranslation({ x: 35, y: 5, scale: 2 }, null), null);
});

test("getWrappedGridTranslation keeps an oversized grid layer covering the viewport", () => {
  assert.deepEqual(getWrappedGridTranslation({ x: 25, y: -30 }, 24, 768), {
    x: 1,
    y: 18,
  });
  assert.deepEqual(getWrappedGridTranslation({ x: -800, y: 800 }, 24, 768), {
    x: 16,
    y: 8,
  });
});

test("viewport maintenance slows down during active panning", () => {
  assert.equal(getViewportWorkInterval(false), 100);
  assert.equal(getViewportWorkInterval(true), 250);
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

test("directional navigation stays in rows and stops at their edges", () => {
  const topLeft = { x: 0, y: 0, width: 100, height: 100 };
  const topMiddle = { x: 114, y: 0, width: 100, height: 100 };
  const topRight = { x: 428, y: 0, width: 400, height: 100 };
  const bottomLeft = { x: 0, y: 132, width: 100, height: 100 };
  const bottomMiddle = { x: 114, y: 132, width: 220, height: 100 };
  const bottomRight = { x: 348, y: 132, width: 300, height: 100 };
  const rows = [
    { top: 0, bottom: 100, nodes: [topLeft, topMiddle, topRight] },
    { top: 132, bottom: 232, nodes: [bottomLeft, bottomMiddle, bottomRight] },
  ];

  assert.equal(findDirectionalNeighbor(rows, topLeft, [1, 0]), topMiddle);
  assert.equal(findDirectionalNeighbor(rows, topLeft, [-1, 0]), null);
  assert.equal(findDirectionalNeighbor(rows, topLeft, [0, 1]), bottomLeft);
  assert.equal(findDirectionalNeighbor(rows, topMiddle, [0, 1]), bottomMiddle);
  assert.equal(findDirectionalNeighbor(rows, topRight, [0, 1]), bottomRight);
  assert.equal(findDirectionalNeighbor(rows, bottomRight, [0, -1]), topRight);
  assert.equal(findDirectionalNeighbor(rows, bottomRight, [0, 1]), null);
});

test("vertical navigation can preserve a horizontal anchor across rows", () => {
  const topMiddle = { x: 114, y: 0, width: 100, height: 100 };
  const bottomMiddle = { x: 114, y: 132, width: 220, height: 100 };
  const rows = [
    { top: 0, bottom: 100, nodes: [{ x: 0, y: 0, width: 100, height: 100 }, topMiddle] },
    {
      top: 132,
      bottom: 232,
      nodes: [{ x: 0, y: 132, width: 100, height: 100 }, bottomMiddle, { x: 348, y: 132, width: 300, height: 100 }],
    },
  ];

  assert.equal(
    findDirectionalNeighbor(rows, topMiddle, [0, 1], {
      preferredX: topMiddle.x + topMiddle.width / 2,
      edgeTarget: null,
    }),
    bottomMiddle,
  );
  assert.equal(
    findDirectionalNeighbor(rows, bottomMiddle, [0, -1], {
      preferredX: topMiddle.x + topMiddle.width / 2,
      edgeTarget: null,
    }),
    topMiddle,
  );
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

test("resizeCamera preserves relative zoom and the world point at viewport center", () => {
  const camera = { x: -100, y: 20, scale: 2 };
  const previousViewport = { width: 800, height: 600 };
  const nextViewport = { width: 500, height: 400 };
  const center = getViewportWorldCenter(camera, previousViewport);
  const resized = resizeCamera(camera, previousViewport, nextViewport, 1, 0.5);

  assert.equal(resized.scale, 1);
  assert.deepEqual(getViewportWorldCenter(resized, nextViewport), center);
});
