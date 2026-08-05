"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoardHistory } = require("../board-history.js");

function snapshot(id, itemCount = 1) {
  return {
    items: Array.from({ length: itemCount }, (_, index) => ({ id: `${id}-${index}` })),
    rotations: new Map([[`${id}-0`, 90]]),
    camera: { x: 12, y: -8, scale: 1.25 },
    selectedItemId: `${id}-0`,
  };
}

test("board history moves backward and forward through board stages", () => {
  const history = createBoardHistory();
  history.record(snapshot("first"));
  history.record(snapshot("second"));

  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
  assert.equal(history.undo(snapshot("current")).items[0].id, "second-0");
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), true);
  assert.equal(history.redo(snapshot("second")).items[0].id, "current-0");
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  assert.equal(history.undo(snapshot("current")).items[0].id, "second-0");
  assert.equal(history.undo(snapshot("second")).items[0].id, "first-0");
  assert.equal(history.undo(snapshot("first")), null);
});

test("board history keeps only lightweight snapshot data and isolates arrays", () => {
  const history = createBoardHistory();
  const item = { id: "item-0" };
  const items = [item];

  history.record({
    items,
    rotations: new Map([[item.id, 45]]),
    camera: { x: 1, y: 2, scale: 3 },
    selectedItemId: item.id,
    element: { nodeType: 1 },
  });
  items.length = 0;

  const restored = history.undo();
  assert.deepEqual(restored.items, [item]);
  assert.deepEqual([...restored.rotations], [[item.id, 45]]);
  assert.deepEqual(restored.camera, { x: 1, y: 2, scale: 3 });
  assert.equal(restored.selectedItemId, item.id);
  assert.equal("element" in restored, false);
});

test("board history trims old entries when stage or item limits are reached", () => {
  const history = createBoardHistory({ maxEntries: 2, maxItems: 3 });

  assert.equal(history.record(snapshot("first", 2)), true);
  assert.equal(history.record(snapshot("second", 2)), true);
  assert.equal(history.size(), 1);
  assert.equal(history.record(snapshot("third", 1)), true);
  assert.equal(history.record(snapshot("fourth", 1)), true);
  assert.equal(history.size(), 2);
  assert.equal(history.undo(snapshot("current", 1)).items[0].id, "fourth-0");
  assert.equal(history.redo(snapshot("fourth", 1)).items[0].id, "current-0");
});

test("recording a new stage after going backward starts a new history branch", () => {
  const history = createBoardHistory();
  history.record(snapshot("first"));
  assert.equal(history.undo(snapshot("second")).items[0].id, "first-0");

  history.record(snapshot("replacement"));

  assert.equal(history.canRedo(), false);
  assert.equal(history.redo(snapshot("first")), null);
});
