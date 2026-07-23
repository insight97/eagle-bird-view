"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSelectionNavigation } = require("../selection-navigation.js");

function createNode(id, x, y) {
  return { id, x, y, width: 100, height: 100 };
}

function createHarness() {
  const selections = [];
  const cleared = [];
  const state = {
    camera: { x: 0, y: 0, scale: 1 },
    layoutDirection: "ltr",
    rows: [],
    selectedNode: null,
    verticalNavigation: null,
  };
  const navigation = createSelectionNavigation({
    state,
    elements: { viewport: { clientWidth: 800, clientHeight: 600 } },
    onSelectNode(node, details) {
      selections.push({ node, details });
    },
    onClearSelection(node) {
      cleared.push(node);
    },
  });
  return { cleared, navigation, selections, state };
}

test("selection navigation wraps horizontally and preserves vertical edge intent", () => {
  const harness = createHarness();
  const first = createNode("first", 0, 0);
  const last = createNode("last", 120, 0);
  const nextFirst = createNode("next-first", 0, 120);
  const nextLast = createNode("next-last", 120, 120);
  harness.state.rows = [
    { top: 0, bottom: 100, nodes: [first, last] },
    { top: 120, bottom: 220, nodes: [nextFirst, nextLast] },
  ];
  harness.navigation.setSelectedNode(last);

  assert.equal(harness.navigation.moveSelection([1, 0]), nextFirst);
  assert.equal(harness.state.selectedNode, nextFirst);

  harness.navigation.setSelectedNode(last);
  assert.equal(harness.navigation.moveSelection([0, 1]), nextLast);
  assert.equal(harness.state.selectedNode, nextLast);
  assert.equal(harness.state.verticalNavigation.edgeTarget, "last");
});

test("selection navigation selects the nearest node at the viewport center", () => {
  const harness = createHarness();
  const node = createNode("center", 350, 250);
  harness.state.rows = [{ top: 250, bottom: 350, nodes: [node] }];

  harness.navigation.selectNodeAtViewportCenter();

  assert.equal(harness.state.selectedNode, node);
  assert.equal(harness.selections.length, 1);
  assert.equal(harness.selections[0].details.changed, true);
});

test("selection navigation clears selection state through its integration callback", () => {
  const harness = createHarness();
  const node = createNode("selected", 0, 0);
  harness.navigation.setSelectedNode(node);
  harness.navigation.clearSelection();

  assert.equal(harness.state.selectedNode, null);
  assert.equal(harness.state.verticalNavigation, null);
  assert.deepEqual(harness.cleared, [node]);
});
