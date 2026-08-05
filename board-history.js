"use strict";

(function exposeBirdViewBoardHistory(root, factory) {
  const history = factory();
  if (typeof module === "object" && module.exports) module.exports = history;
  root.BirdViewBoardHistory = history;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_MAX_ENTRIES = 10;
  const DEFAULT_MAX_ITEMS = 5000;

  function createBoardHistory({
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxItems = DEFAULT_MAX_ITEMS,
  } = {}) {
    const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES));
    const itemLimit = Math.max(1, Math.floor(Number(maxItems) || DEFAULT_MAX_ITEMS));
    const past = [];
    const future = [];
    let itemCount = 0;

    function record(snapshot) {
      const entry = normalizeSnapshot(snapshot);
      if (!entry || entry.items.length > itemLimit) return false;

      itemCount -= countItems(future);
      future.length = 0;
      past.push(entry);
      itemCount += entry.items.length;
      trimToLimits();
      return true;
    }

    function undo(currentSnapshot) {
      return move(past, future, currentSnapshot);
    }

    function redo(currentSnapshot) {
      return move(future, past, currentSnapshot);
    }

    function move(source, destination, currentSnapshot) {
      if (!source.length) return null;
      const target = source.pop();
      itemCount -= target.items.length;
      const current = normalizeSnapshot(currentSnapshot);
      if (current) {
        destination.push(current);
        itemCount += current.items.length;
      }
      trimToLimits();
      return target;
    }

    function clear() {
      past.length = 0;
      future.length = 0;
      itemCount = 0;
    }

    function trimToLimits() {
      while (
        past.length + future.length > entryLimit ||
        itemCount > itemLimit
      ) {
        const oldest = past.length ? past.shift() : future.shift();
        if (!oldest) break;
        itemCount -= oldest.items.length;
      }
    }

    return Object.freeze({
      canRedo: () => future.length > 0,
      canUndo: () => past.length > 0,
      clear,
      itemCount: () => itemCount,
      record,
      redo,
      size: () => past.length + future.length,
      undo,
    });
  }

  function countItems(entries) {
    return entries.reduce((total, entry) => total + entry.items.length, 0);
  }

  function normalizeSnapshot(snapshot) {
    const items = Array.isArray(snapshot?.items)
      ? snapshot.items.filter((item) => item && item.id).slice()
      : [];
    if (!items.length) return null;

    const rotations = new Map();
    if (snapshot.rotations instanceof Map) {
      for (const [id, rotation] of snapshot.rotations) {
        if (id && Number.isFinite(rotation)) rotations.set(id, rotation);
      }
    }

    const camera = snapshot.camera || {};
    return {
      items,
      rotations,
      camera: {
        x: finiteOrZero(camera.x),
        y: finiteOrZero(camera.y),
        scale: Number.isFinite(camera.scale) && camera.scale > 0 ? camera.scale : 1,
      },
      selectedItemId: snapshot.selectedItemId || null,
    };
  }

  function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
  }

  return Object.freeze({
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_ITEMS,
    createBoardHistory,
  });
});
