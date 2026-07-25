"use strict";

(function exposeBirdViewBoard(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const board = factory(core);
  if (typeof module === "object" && module.exports) module.exports = board;
  root.BirdViewBoard = board;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const { createJustifiedLayout, insertExplorationRow } = core;

  function createBoardState() {
    let nodes = [];
    let rows = [];

    function snapshot() {
      return { nodes, rows };
    }

    function replace(items, config) {
      const layout = createJustifiedLayout(
        items,
        config.direction,
        config.layoutWidth,
        config,
      );
      nodes = layout.nodes;
      rows = layout.rows;
      return snapshot();
    }

    function append(items, config) {
      if (!items.length) return snapshot();
      if (!rows.length) return replace(items, config);

      const selectedLayout = createJustifiedLayout(
        items,
        config.direction,
        config.layoutWidth,
        config,
      );
      let layout = { nodes, rows, ...config };
      for (const row of selectedLayout.rows) {
        layout = insertExplorationRow(
          layout,
          layout.rows.at(-1),
          row.nodes.map(({ item }) => item),
          config.direction,
          config.layoutWidth,
          config,
        );
      }
      nodes = layout.nodes;
      rows = layout.rows;
      return snapshot();
    }

    function insertAfter(anchorNode, items, config) {
      const anchorRow = rows.find((row) => row.nodes.includes(anchorNode));
      if (!anchorRow) return null;

      const layout = insertExplorationRow(
        { nodes, rows, ...config },
        anchorRow,
        items,
        config.direction,
        config.layoutWidth,
        config,
      );
      nodes = layout.nodes;
      rows = layout.rows;
      return snapshot();
    }

    function relayout(items, config, rotations = new Map()) {
      const layout = createJustifiedLayout(
        items,
        config.direction,
        config.layoutWidth,
        config,
      );
      for (const node of layout.nodes) {
        node.rotation = rotations.get(node.item.id) || 0;
      }
      nodes = layout.nodes;
      rows = layout.rows;
      return snapshot();
    }

    function clear() {
      nodes = [];
      rows = [];
      return snapshot();
    }

    return Object.freeze({
      get nodes() {
        return nodes;
      },
      get rows() {
        return rows;
      },
      snapshot,
      replace,
      append,
      insertAfter,
      relayout,
      clear,
    });
  }

  return Object.freeze({ createBoardState });
});
