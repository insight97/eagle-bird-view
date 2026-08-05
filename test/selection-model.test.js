"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSelectionModel } = require("../selection-model.js");

function createHarness() {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
  const model = createSelectionModel({ getOrderedNodes: () => nodes });
  return { model, nodes };
}

test("selection model replaces the selection on a normal click", () => {
  const { model, nodes } = createHarness();

  model.selectNode(nodes[1]);
  assert.deepEqual([...model.getSelectedNodes()], [nodes[1]]);
  assert.equal(model.getActiveNode(), nodes[1]);
  assert.equal(model.getAnchorNode(), nodes[1]);

  model.selectNode(nodes[3]);
  assert.deepEqual([...model.getSelectedNodes()], [nodes[3]]);
  assert.equal(model.getActiveNode(), nodes[3]);
});

test("ctrl click toggles individual nodes and keeps an active node", () => {
  const { model, nodes } = createHarness();

  model.selectNode(nodes[0]);
  model.selectNode(nodes[2], { ctrlKey: true });
  model.selectNode(nodes[3], { ctrlKey: true });
  assert.deepEqual([...model.getSelectedNodes()], [nodes[0], nodes[2], nodes[3]]);
  assert.equal(model.getActiveNode(), nodes[3]);
  assert.equal(model.isMultiple(), true);

  model.selectNode(nodes[2], { ctrlKey: true });
  assert.deepEqual([...model.getSelectedNodes()], [nodes[0], nodes[3]]);
  assert.equal(model.getActiveNode(), nodes[3]);
  assert.equal(model.getAnchorNode(), nodes[2]);
});

test("shift click selects the interval from the anchor in board order", () => {
  const { model, nodes } = createHarness();

  model.selectNode(nodes[1]);
  model.selectNode(nodes[3], { shiftKey: true });
  assert.deepEqual([...model.getSelectedNodes()], [nodes[1], nodes[2], nodes[3]]);
  assert.equal(model.getActiveNode(), nodes[3]);

  model.selectNode(nodes[0], { shiftKey: true });
  assert.deepEqual([...model.getSelectedNodes()], [nodes[0], nodes[1]]);
  assert.equal(model.getAnchorNode(), nodes[1]);
});

test("clear removes the active node, anchor, and all selected nodes", () => {
  const { model, nodes } = createHarness();
  model.selectNode(nodes[1]);
  model.selectNode(nodes[2], { ctrlKey: true });

  model.clear();
  assert.deepEqual([...model.getSelectedNodes()], []);
  assert.equal(model.getActiveNode(), null);
  assert.equal(model.getAnchorNode(), null);
  assert.equal(model.isMultiple(), false);
});
