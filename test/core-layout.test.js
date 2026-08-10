"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LAYOUT_GAP,
  MIN_LAYOUT_WIDTH,
  MIN_ROW_HEIGHT,
  ROW_GAP,
  TARGET_ROW_HEIGHT,
  VIDEO_CONTROLS_HEIGHT,
  createJustifiedLayout,
  findNodesNearViewport,
  getAspectRatio,
  insertExplorationRow,
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

test("createJustifiedLayout can place items from right to left", () => {
  const items = [
    { id: "first", width: 1000, height: 1000, ext: "jpg" },
    { id: "second", width: 1000, height: 1000, ext: "jpg" },
  ];
  const layout = createJustifiedLayout(items, "rtl");

  assert.equal(layout.direction, "rtl");
  assert.equal(layout.nodes[0].item.id, "first");
  assert.equal(layout.nodes[0].x, 1020);
  assert.equal(layout.nodes[1].x, 826);
});

test("createJustifiedLayout uses one item per row at the minimum width", () => {
  const items = [
    { id: "wide", width: 1600, height: 1000, ext: "jpg" },
    { id: "portrait", width: 100, height: 200, ext: "jpg" },
  ];
  const layout = createJustifiedLayout(items, "ltr", MIN_LAYOUT_WIDTH);

  assert.equal(layout.layoutWidth, MIN_LAYOUT_WIDTH);
  assert.equal(layout.rows.length, items.length);
  assert.deepEqual(layout.rows.map((row) => row.nodes.length), [1, 1]);
});

test("createJustifiedLayout supports an unlimited width single row", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `item-${index}`,
    width: 1600,
    height: 1000,
    ext: "jpg",
  }));
  const layout = createJustifiedLayout(items, "rtl", Infinity);

  assert.equal(layout.layoutWidth, Infinity);
  assert.equal(layout.rows.length, 1);
  assert.equal(layout.rows[0].nodes.length, items.length);
  assert.ok(layout.nodes.every(({ x, width }) => Number.isFinite(x) && width > 0));
});

test("createJustifiedLayout accepts compact spacing for seamless layouts", () => {
  const items = Array.from({ length: 14 }, (_, index) => ({
    id: `item-${index}`,
    width: 1000,
    height: 1000,
    ext: "jpg",
  }));
  const layout = createJustifiedLayout(items, "ltr", 1200, { gap: 4, rowGap: 8 });

  assert.equal(layout.gap, 4);
  assert.equal(layout.rowGap, 8);
  assert.equal(layout.nodes[1].x - layout.nodes[0].width, 4);
  assert.equal(layout.rows[1].top - layout.rows[0].bottom, 8);
});

test("createJustifiedLayout can remove video control height for seamless layouts", () => {
  const items = [
    { id: "video", width: 4000, height: 1000, ext: "mp4" },
    { id: "image", width: 4000, height: 1000, ext: "jpg" },
    { id: "next", width: 1000, height: 1000, ext: "jpg" },
  ];
  const layout = createJustifiedLayout(items, "ltr", 1200, {
    gap: 0,
    rowGap: 0,
    videoControlsHeight: 0,
  });
  const firstRowHeight = 1200 / 8;

  assert.equal(layout.videoControlsHeight, 0);
  assert.equal(layout.rows[0].videoControlsHeight, 0);
  assert.equal(layout.rows[1].top, firstRowHeight);
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
    firstRowHeight + VIDEO_CONTROLS_HEIGHT + ROW_GAP,
  );
  assert.equal(layout.nodes[0].isVideo, true);
  assert.equal(layout.nodes[1].x, layout.nodes[0].width + LAYOUT_GAP);
});

test("createJustifiedLayout reserves controls for MP3 audio cards", () => {
  const layout = createJustifiedLayout([
    { id: "audio", width: 4000, height: 1000, ext: "MP3" },
    { id: "image", width: 4000, height: 1000, ext: "jpg" },
    { id: "next", width: 1000, height: 1000, ext: "jpg" },
  ]);

  assert.equal(layout.nodes[0].isVideo, false);
  assert.equal(layout.nodes[0].isAudio, true);
  assert.equal(
    layout.rows[1].top,
    layout.rows[0].bottom + VIDEO_CONTROLS_HEIGHT + ROW_GAP,
  );
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

test("insertExplorationRow inserts below its anchor and shifts later rows", () => {
  const initialItems = Array.from({ length: 14 }, (_, index) => ({
    id: `initial-${index}`,
    width: 100,
    height: 100,
    ext: "jpg",
  }));
  const layout = createJustifiedLayout(initialItems);
  const anchorRow = layout.rows[0];
  const originalNextRow = layout.rows[1];
  const originalNextTop = originalNextRow.top;
  const originalNextNodeY = originalNextRow.nodes[0].y;
  const anchorNodeY = anchorRow.nodes[0].y;
  const explorationItems = Array.from({ length: 4 }, (_, index) => ({
    id: `explore-${index}`,
    width: 200,
    height: 100,
    ext: index === 0 ? "mp4" : "jpg",
  }));

  const result = insertExplorationRow(layout, anchorRow, explorationItems);

  assert.equal(result.rows[1], result.insertedRow);
  assert.equal(result.rows[2], originalNextRow);
  assert.equal(result.insertedRow.top, anchorRow.bottom + ROW_GAP);
  assert.equal(originalNextRow.top, originalNextTop + result.shift);
  assert.equal(originalNextRow.nodes[0].y, originalNextNodeY + result.shift);
  assert.equal(anchorRow.nodes[0].y, anchorNodeY);
  assert.equal(
    result.shift,
    result.insertedRow.bottom - result.insertedRow.top + VIDEO_CONTROLS_HEIGHT + ROW_GAP,
  );
  assert.deepEqual(
    result.nodes.slice(anchorRow.nodes.length, anchorRow.nodes.length + 4),
    result.insertedRow.nodes,
  );
});

test("insertExplorationRow splits a long exploration result into readable rows", () => {
  const layout = createJustifiedLayout([
    { id: "anchor", width: 1600, height: 800, ext: "jpg" },
  ]);
  const explorationItems = Array.from({ length: 10 }, (_, index) => ({
    id: `explore-${index}`,
    width: 1600,
    height: 800,
    ext: "jpg",
  }));

  const result = insertExplorationRow(layout, layout.rows[0], explorationItems);

  assert.ok(result.insertedRows.length > 1);
  assert.ok(
    result.insertedRows.every((row) => row.bottom - row.top >= MIN_ROW_HEIGHT),
  );
  assert.deepEqual(
    result.insertedRows.flatMap((row) => row.nodes.map(({ item }) => item.id)),
    explorationItems.map(({ id }) => id),
  );
});

test("insertExplorationRow keeps the minimum-width layout to one item per row", () => {
  const layout = createJustifiedLayout(
    [{ id: "anchor", width: 1000, height: 1000, ext: "jpg" }],
    "ltr",
    MIN_LAYOUT_WIDTH,
  );
  const result = insertExplorationRow(
    layout,
    layout.rows[0],
    [
      { id: "first", width: 1000, height: 1000, ext: "jpg" },
      { id: "second", width: 1000, height: 1000, ext: "jpg" },
    ],
    "ltr",
    MIN_LAYOUT_WIDTH,
  );

  assert.equal(result.insertedRows.length, 2);
  assert.deepEqual(result.insertedRows.map((row) => row.nodes.length), [1, 1]);
  assert.equal(result.rows[1], result.insertedRows[0]);
  assert.equal(result.rows[2], result.insertedRows[1]);
});

test("repeated exploration keeps the newest row directly below the same anchor", () => {
  const layout = createJustifiedLayout([
    { id: "anchor", width: 100, height: 100, ext: "jpg" },
  ]);
  const anchorRow = layout.rows[0];
  const firstItems = [{ id: "first", width: 200, height: 100, ext: "jpg" }];
  const secondItems = [{ id: "second", width: 200, height: 100, ext: "jpg" }];

  const firstResult = insertExplorationRow(layout, anchorRow, firstItems);
  const firstRow = firstResult.insertedRow;
  const secondResult = insertExplorationRow(firstResult, anchorRow, secondItems);

  assert.equal(secondResult.rows[0], anchorRow);
  assert.equal(secondResult.rows[1], secondResult.insertedRow);
  assert.equal(secondResult.rows[1].nodes[0].item.id, "second");
  assert.equal(secondResult.rows[2], firstRow);
  assert.equal(secondResult.rows[2].nodes[0].item.id, "first");
});
