"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoardState } = require("../board-state.js");

const config = {
  direction: "ltr",
  layoutWidth: 240,
  gap: 14,
  rowGap: 32,
  videoControlsHeight: 0,
};

function item(id, width = 160, height = 100) {
  return { id, name: id, ext: "jpg", width, height };
}

test("replace and append commit one board snapshot", () => {
  const board = createBoardState();
  const first = item("first");
  const second = item("second");
  const third = item("third");

  board.replace([first, second], config);
  assert.deepEqual(board.nodes.map(({ item: value }) => value.id), ["first", "second"]);
  assert.equal(board.rows.length, 2);

  const snapshot = board.append([third], config);
  assert.equal(snapshot.nodes, board.nodes);
  assert.deepEqual(board.nodes.map(({ item: value }) => value.id), ["first", "second", "third"]);
  assert.equal(board.rows.length, 3);
});

test("insertAfter anchors the new row and shifts later rows", () => {
  const board = createBoardState();
  const first = item("first");
  const second = item("second");
  const third = item("third");

  board.replace([first, second, third], config);
  const anchor = board.nodes[0];
  const previousLastTop = board.rows.at(-1).top;

  const snapshot = board.insertAfter(anchor, [item("inserted")], config);

  assert.ok(snapshot);
  assert.deepEqual(board.nodes.map(({ item: value }) => value.id), [
    "first",
    "inserted",
    "second",
    "third",
  ]);
  assert.ok(board.rows.at(-1).top > previousLastTop);
  assert.equal(board.insertAfter({ item: { id: "missing" } }, [item("ignored")], config), null);
});

test("relayout preserves node rotations and clear removes the board", () => {
  const board = createBoardState();
  const first = item("first");
  const second = item("second");

  board.replace([first, second], config);
  const rotations = new Map([["first", 90]]);
  board.relayout([first, second], config, rotations);

  assert.equal(board.nodes[0].rotation, 90);
  assert.equal(board.nodes[1].rotation, 0);

  board.clear();
  assert.deepEqual(board.nodes, []);
  assert.deepEqual(board.rows, []);
});
