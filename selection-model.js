"use strict";

(function exposeBirdViewSelectionModel(root, factory) {
  const selectionModel = factory();
  if (typeof module === "object" && module.exports) module.exports = selectionModel;
  root.BirdViewSelectionModel = selectionModel;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function createSelectionModel(options = {}) {
    const getOrderedNodes = options.getOrderedNodes || (() => []);
    let selectedNodes = new Set();
    let activeNode = null;
    let anchorNode = null;

    function snapshot() {
      return {
        activeNode,
        anchorNode,
        selectedNodes: new Set(selectedNodes),
      };
    }

    function selectNode(node, { ctrlKey = false, shiftKey = false } = {}) {
      if (!node) return snapshot();
      if (shiftKey) {
        const anchor = anchorNode || activeNode || node;
        const orderedNodes = getOrderedNodes() || [];
        const anchorIndex = orderedNodes.indexOf(anchor);
        const nodeIndex = orderedNodes.indexOf(node);
        if (anchorIndex >= 0 && nodeIndex >= 0) {
          const start = Math.min(anchorIndex, nodeIndex);
          const end = Math.max(anchorIndex, nodeIndex);
          selectedNodes = new Set(orderedNodes.slice(start, end + 1));
        } else {
          selectedNodes = new Set([node]);
        }
        activeNode = node;
        if (!anchorNode) anchorNode = anchor;
        return snapshot();
      }

      if (ctrlKey) {
        if (selectedNodes.has(node)) selectedNodes.delete(node);
        else selectedNodes.add(node);
        activeNode = selectedNodes.has(node)
          ? node
          : [...selectedNodes][selectedNodes.size - 1] || null;
        anchorNode = node;
        return snapshot();
      }

      selectedNodes = new Set([node]);
      activeNode = node;
      anchorNode = node;
      return snapshot();
    }

    function clear() {
      selectedNodes = new Set();
      activeNode = null;
      anchorNode = null;
      return snapshot();
    }

    function contains(node) {
      return selectedNodes.has(node);
    }

    return Object.freeze({
      clear,
      contains,
      getActiveNode: () => activeNode,
      getAnchorNode: () => anchorNode,
      getSelectedNodes: () => new Set(selectedNodes),
      isMultiple: () => selectedNodes.size > 1,
      selectNode,
    });
  }

  return Object.freeze({ createSelectionModel });
});
