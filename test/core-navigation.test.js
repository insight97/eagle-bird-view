"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  directionFor,
  findDirectionalNode,
  findNodeAtPoint,
  getLabelRect,
  getViewportPanDelta,
  getViewportWorldCenter,
  shouldPanSelection,
  zoomCameraAtPoint,
} = require("../bird-view-core.js");

test("getLabelRect projects a node into rounded screen coordinates", () => {
  assert.deepEqual(
    getLabelRect(
      { x: 10.2, y: 20.4, width: 100.2 },
      { x: 5, y: -3, scale: 1.5 },
    ),
    { left: 20, top: 1, width: 150, height: 22 },
  );
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

test("selection pans only when the selected item is shorter than the viewport", () => {
  const node = { height: 200 };
  assert.equal(shouldPanSelection(401, node, 2), true);
  assert.equal(shouldPanSelection(400, node, 2), false);
  assert.equal(shouldPanSelection(399, node, 2), false);
});

test("findNodeAtPoint selects only an item beneath the viewport center", () => {
  const first = { x: 0, y: 0, width: 100, height: 100 };
  const second = { x: 120, y: 0, width: 100, height: 100 };
  const center = getViewportWorldCenter(
    { x: -190, y: 0, scale: 2 },
    { width: 100, height: 100 },
  );

  assert.deepEqual(center, { x: 120, y: 25 });
  assert.equal(findNodeAtPoint([first, second], center), second);
  assert.equal(findNodeAtPoint([first, second], { x: 110, y: 50 }), null);
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

test("findDirectionalNode selects aligned nodes and ignores off-axis candidates", () => {
  const current = { x: 0, y: 0, width: 100, height: 100 };
  const aligned = { x: 130, y: 10, width: 100, height: 80 };
  const diagonal = { x: 110, y: 130, width: 100, height: 100 };

  assert.equal(findDirectionalNode([current, diagonal, aligned], current, 1, 0), aligned);
  assert.equal(findDirectionalNode([current, aligned], current, -1, 0), null);
});

test("vertical selection never skips an adjacent row", () => {
  const current = { x: 0, y: 0, width: 100, height: 100 };
  const adjacentOffAxis = { x: 140, y: 120, width: 100, height: 100 };
  const fartherAligned = { x: 0, y: 240, width: 100, height: 100 };

  assert.equal(
    findDirectionalNode([current, adjacentOffAxis, fartherAligned], current, 0, 1),
    null,
  );
});

test("vertical selection chooses an aligned item from the adjacent row", () => {
  const current = { x: 100, y: 120, width: 100, height: 100 };
  const adjacentAligned = { x: 80, y: 0, width: 100, height: 100 };
  const fartherAligned = { x: 100, y: -120, width: 100, height: 100 };

  assert.equal(
    findDirectionalNode([fartherAligned, adjacentAligned, current], current, 0, -1),
    adjacentAligned,
  );
});
