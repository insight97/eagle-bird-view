"use strict";

(function exposeBirdViewSelection(root, factory) {
  const core =
    root.BirdViewCore ||
    (typeof module === "object" && typeof require === "function"
      ? require("./bird-view-core.js")
      : null);
  const selection = factory(core);
  if (typeof module === "object" && module.exports) module.exports = selection;
  root.BirdViewSelection = selection;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const {
    findDirectionalNeighbor,
    findNearestNodeInRows,
    getViewportWorldCenter,
  } = core;

  function createSelectionNavigation(options = {}) {
    const {
      state,
      elements,
      onSelectNode,
      onClearSelection,
    } = options;

    if (!state || !elements?.viewport) {
      throw new Error("Selection navigation requires state and viewport");
    }

    function clearSelection() {
      const previousNode = state.selectedNode;
      state.selectedNode = null;
      state.verticalNavigation = null;
      onClearSelection?.(previousNode);
    }

    function setSelectedNode(node, { preserveVerticalNavigation = false } = {}) {
      if (!node) return;
      if (!preserveVerticalNavigation) state.verticalNavigation = null;
      const previousNode = state.selectedNode;
      const changed = node !== previousNode;
      state.selectedNode = node;
      onSelectNode?.(node, {
        changed,
        previousNode,
        preserveVerticalNavigation,
      });
    }

    function moveSelection(direction) {
      if (!direction || !state.selectedNode) return null;
      const [dx, dy] = direction;
      if (dy) {
        if (!state.verticalNavigation) {
          const currentRow = state.rows.find((row) => row.nodes.includes(state.selectedNode));
          const nodeIndex = currentRow?.nodes.indexOf(state.selectedNode) ?? -1;
          state.verticalNavigation = {
            preferredX: state.selectedNode.x + state.selectedNode.width / 2,
            edgeTarget:
              nodeIndex === 0
                ? "first"
                : nodeIndex === (currentRow?.nodes.length || 0) - 1
                  ? "last"
                  : null,
          };
        }
        const node = findDirectionalNeighbor(state.rows, state.selectedNode, direction, {
          preferredX: state.verticalNavigation.preferredX,
          edgeTarget: state.verticalNavigation.edgeTarget,
        });
        if (node) {
          setSelectedNode(node, { preserveVerticalNavigation: true });
          return node;
        }
        return null;
      }

      state.verticalNavigation = null;
      const node = findDirectionalNeighbor(state.rows, state.selectedNode, direction, {
        wrapRows: true,
        layoutDirection: state.layoutDirection,
      });
      if (node) setSelectedNode(node);
      return node || null;
    }

    function selectNodeAtViewportCenter() {
      const viewportCenter = getViewportWorldCenter(state.camera, {
        width: elements.viewport.clientWidth,
        height: elements.viewport.clientHeight,
      });
      const node = findNearestNodeInRows(state.rows, viewportCenter);
      if (node && node !== state.selectedNode) setSelectedNode(node);
    }

    return Object.freeze({
      clearSelection,
      moveSelection,
      selectNodeAtViewportCenter,
      setSelectedNode,
    });
  }

  return Object.freeze({ createSelectionNavigation });
});
