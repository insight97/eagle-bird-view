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

    return Object.freeze({
      clear,
      getActiveNode: () => activeNode,
      getAnchorNode: () => anchorNode,
      getSelectedNodes: () => new Set(selectedNodes),
      isMultiple: () => selectedNodes.size > 1,
      selectNode,
    });
  }

  function createSelectionNavigation(options = {}) {
    const {
      state,
      elements,
      onSelectNode,
      onClearSelection,
      onSelectionChange,
    } = options;
    const getRows = options.getRows || (() => state.rows);

    if (!state || !elements?.viewport) {
      throw new Error("Selection navigation requires state and viewport");
    }

    const model = createSelectionModel({
      getOrderedNodes: () => getRows().flatMap((row) => row.nodes || []),
    });

    function sameNodes(first, second) {
      if (first.size !== second.size) return false;
      for (const node of first) {
        if (!second.has(node)) return false;
      }
      return true;
    }

    function syncState() {
      state.selectedNodes = model.getSelectedNodes();
      state.selectedNode = model.getActiveNode();
      state.selectionAnchor = model.getAnchorNode();
    }

    function notifySelectionChange(previous, snapshot, details = {}) {
      syncState();
      const selectionChanged = !sameNodes(previous.selectedNodes, snapshot.selectedNodes);
      const activeChanged = previous.activeNode !== snapshot.activeNode;
      const payload = {
        ...details,
        activeNode: snapshot.activeNode,
        changed: activeChanged,
        previousNode: previous.activeNode,
        previousSelectedNodes: previous.selectedNodes,
        selectedNodes: snapshot.selectedNodes,
        selectionChanged,
      };

      if (snapshot.activeNode) {
        if (activeChanged || selectionChanged) onSelectNode?.(snapshot.activeNode, payload);
      } else if (previous.activeNode) {
        onClearSelection?.(previous.activeNode, payload);
      }
      if (selectionChanged || activeChanged) onSelectionChange?.(payload);
      return payload;
    }

    function clearSelection() {
      const previous = {
        activeNode: model.getActiveNode(),
        selectedNodes: model.getSelectedNodes(),
      };
      const snapshot = model.clear();
      state.verticalNavigation = null;
      notifySelectionChange(previous, snapshot);
    }

    function setSelectedNode(node, { preserveVerticalNavigation = false } = {}) {
      if (!node) return;
      if (!preserveVerticalNavigation) state.verticalNavigation = null;
      const previous = {
        activeNode: model.getActiveNode(),
        selectedNodes: model.getSelectedNodes(),
      };
      const snapshot = model.selectNode(node);
      return notifySelectionChange(previous, snapshot, {
        preserveVerticalNavigation,
      });
    }

    function selectNode(node, modifiers = {}) {
      if (!node) return;
      state.verticalNavigation = null;
      const previous = {
        activeNode: model.getActiveNode(),
        selectedNodes: model.getSelectedNodes(),
      };
      const snapshot = model.selectNode(node, {
        ctrlKey: Boolean(modifiers.ctrlKey || modifiers.metaKey),
        shiftKey: Boolean(modifiers.shiftKey),
      });
      return notifySelectionChange(previous, snapshot, {
        source: modifiers.source,
      });
    }

    function moveSelection(direction) {
      const selectedNode = model.getActiveNode();
      if (!direction || !selectedNode) return null;
      const [dx, dy] = direction;
      if (dy) {
        if (!state.verticalNavigation) {
          const rows = getRows();
          const currentRow = rows.find((row) => row.nodes.includes(selectedNode));
          const nodeIndex = currentRow?.nodes.indexOf(selectedNode) ?? -1;
          state.verticalNavigation = {
            preferredX: selectedNode.x + selectedNode.width / 2,
            edgeTarget:
              nodeIndex === 0
                ? "first"
                : nodeIndex === (currentRow?.nodes.length || 0) - 1
                  ? "last"
                  : null,
          };
        }
        const node = findDirectionalNeighbor(getRows(), selectedNode, direction, {
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
      const node = findDirectionalNeighbor(getRows(), selectedNode, direction, {
        wrapRows: true,
        layoutDirection: state.layoutDirection,
      });
      if (node) setSelectedNode(node);
      return node || null;
    }

    function selectNodeAtViewportCenter() {
      if (model.isMultiple()) return;
      const viewportCenter = getViewportWorldCenter(state.camera, {
        width: elements.viewport.clientWidth,
        height: elements.viewport.clientHeight,
      });
      const node = findNearestNodeInRows(getRows(), viewportCenter);
      if (node && node !== model.getActiveNode()) setSelectedNode(node);
    }

    syncState();

    return Object.freeze({
      clearSelection,
      moveSelection,
      getActiveNode: () => model.getActiveNode(),
      getSelectedNodes: () => model.getSelectedNodes(),
      isMultipleSelection: () => model.isMultiple(),
      selectNode,
      selectNodeAtViewportCenter,
      setSelectedNode,
    });
  }

  return Object.freeze({ createSelectionNavigation });
});
