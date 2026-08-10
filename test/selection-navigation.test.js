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

test("selection navigation can read rows from the board without state rows", () => {
  const selections = [];
  const boardRows = [];
  const state = {
    camera: { x: 0, y: 0, scale: 1 },
    layoutDirection: "ltr",
    selectedNode: null,
    verticalNavigation: null,
  };
  const node = createNode("center", 350, 250);
  boardRows.push({ top: 250, bottom: 350, nodes: [node] });
  const navigation = createSelectionNavigation({
    state,
    elements: { viewport: { clientWidth: 800, clientHeight: 600 } },
    getRows: () => boardRows,
    onSelectNode(node) {
      selections.push(node);
    },
  });

  navigation.selectNodeAtViewportCenter();

  assert.equal(state.selectedNode, node);
  assert.deepEqual(selections, [node]);
});

test("selection navigation clears selection state through its integration callback", () => {
  const harness = createHarness();
  const node = createNode("selected", 0, 0);
  harness.navigation.setSelectedNode(node);
  harness.navigation.clearSelection();

  assert.equal(harness.state.selectedNode, null);
  assert.deepEqual([...harness.state.selectedNodes], []);
  assert.equal(harness.state.selectionAnchor, null);
  assert.equal(harness.state.verticalNavigation, null);
  assert.deepEqual(harness.cleared, [node]);
});

test("selection navigation owns normal, ctrl, and shift selection transitions", () => {
  const harness = createHarness();
  const first = createNode("first", 0, 0);
  const second = createNode("second", 120, 0);
  const third = createNode("third", 240, 0);
  harness.state.rows = [{ top: 0, bottom: 100, nodes: [first, second, third] }];

  harness.navigation.selectNode(second);
  assert.deepEqual([...harness.navigation.getSelectedNodes()], [second]);
  assert.equal(harness.state.selectedNode, second);
  assert.equal(harness.state.selectionAnchor, second);

  harness.navigation.selectNode(first, { ctrlKey: true });
  assert.deepEqual([...harness.navigation.getSelectedNodes()], [second, first]);
  assert.equal(harness.state.selectedNode, first);
  assert.equal(harness.state.selectionAnchor, first);
  assert.equal(harness.navigation.isMultipleSelection(), true);

  harness.navigation.selectNode(first, { ctrlKey: true });
  assert.deepEqual([...harness.navigation.getSelectedNodes()], [second]);
  assert.equal(harness.state.selectedNode, second);

  harness.navigation.selectNode(third, { shiftKey: true });
  assert.deepEqual([...harness.navigation.getSelectedNodes()], [first, second, third]);
  assert.equal(harness.state.selectedNode, third);
  assert.equal(harness.state.selectionAnchor, first);
});

test("viewport-center selection does not replace a multiple selection", () => {
  const harness = createHarness();
  const first = createNode("first", 350, 250);
  const second = createNode("second", 0, 0);
  harness.state.rows = [
    { top: 0, bottom: 100, nodes: [second] },
    { top: 250, bottom: 350, nodes: [first] },
  ];

  harness.navigation.selectNode(second);
  harness.navigation.selectNode(first, { ctrlKey: true });
  harness.navigation.selectNodeAtViewportCenter();

  assert.deepEqual([...harness.navigation.getSelectedNodes()], [second, first]);
  assert.equal(harness.state.selectedNode, first);
});
