"use strict";

(function exposeBirdViewCore(root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  root.BirdViewCore = core;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
  const VIDEO_CONTROLS_HEIGHT = 10;
  const LAYOUT_WIDTH = 1200;
  const TARGET_ROW_HEIGHT = 180;
  const MIN_ROW_HEIGHT = 140;
  const MAX_ROW_HEIGHT = 220;
  const LAYOUT_GAP = 14;
  const ARROW_DIRECTIONS = {
    arrowup: [0, -1],
    arrowdown: [0, 1],
    arrowleft: [-1, 0],
    arrowright: [1, 0],
  };
  const WASD_TO_ARROW = { w: "arrowup", s: "arrowdown", a: "arrowleft", d: "arrowright" };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function directionFor(key) {
    const normalizedKey = String(key || "").toLowerCase();
    return ARROW_DIRECTIONS[normalizedKey] || ARROW_DIRECTIONS[WASD_TO_ARROW[normalizedKey]];
  }

  function getViewportPanDelta(key, viewport, fraction = 2 / 3) {
    const direction = directionFor(key);
    if (!direction) return null;
    const magnitude = (direction[0] ? viewport.width : viewport.height) * fraction;
    return {
      x: direction[0] ? direction[0] * -magnitude : 0,
      y: direction[1] ? direction[1] * -magnitude : 0,
    };
  }

  function getViewportWorldCenter(camera, viewport) {
    return {
      x: (viewport.width / 2 - camera.x) / camera.scale,
      y: (viewport.height / 2 - camera.y) / camera.scale,
    };
  }

  function findNearestNodeToPoint(nodes, point) {
    let nearest = null;
    for (const node of nodes) {
      nearest = chooseNearestMatch(nearest, describeNodeDistance(node, point));
    }
    return nearest?.node || null;
  }

  function findNearestNodeInRows(rows, point) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (getRowSelectionBottom(rows[middle]) < point.y) low = middle + 1;
      else high = middle;
    }

    let above = low - 1;
    let below = low;
    let nearest = null;
    while (above >= 0 || below < rows.length) {
      const aboveDistance =
        above >= 0 ? getRowVerticalDistanceSquared(rows[above], point.y) : Infinity;
      const belowDistance =
        below < rows.length ? getRowVerticalDistanceSquared(rows[below], point.y) : Infinity;
      const minimumDistance = Math.min(aboveDistance, belowDistance);
      if (nearest && minimumDistance > nearest.edgeDistance) break;

      const row = aboveDistance <= belowDistance ? rows[above--] : rows[below++];
      for (const node of row.nodes) {
        nearest = chooseNearestMatch(nearest, describeNodeDistance(node, point));
      }
    }
    return nearest?.node || null;
  }

  function describeNodeDistance(node, point) {
    const dx = Math.max(node.x - point.x, 0, point.x - (node.x + node.width));
    const dy = Math.max(node.y - point.y, 0, point.y - (node.y + node.height));
    const center = getNodeCenter(node);
    return {
      node,
      edgeDistance: dx ** 2 + dy ** 2,
      centerDistance: (center.x - point.x) ** 2 + (center.y - point.y) ** 2,
    };
  }

  function chooseNearestMatch(current, candidate) {
    if (
      !current ||
      candidate.edgeDistance < current.edgeDistance ||
      (candidate.edgeDistance === current.edgeDistance &&
        candidate.centerDistance < current.centerDistance)
    ) {
      return candidate;
    }
    return current;
  }

  function getRowVerticalDistanceSquared(row, y) {
    const dy = Math.max(row.top - y, 0, y - getRowSelectionBottom(row));
    return dy ** 2;
  }

  function getRowSelectionBottom(row) {
    return row.bottom + getRowControlsHeight(row);
  }

  function isPlayingVideo(video) {
    return Boolean(video && !video.paused);
  }

  function zoomCameraAtPoint(camera, point, factor, baseScale, minZoom, maxZoom) {
    const worldX = (point.x - camera.x) / camera.scale;
    const worldY = (point.y - camera.y) / camera.scale;
    const scale = clamp(camera.scale * factor, baseScale * minZoom, baseScale * maxZoom);
    return {
      scale,
      x: point.x - worldX * scale,
      y: point.y - worldY * scale,
    };
  }

  function getNodeCenter(node) {
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }

  function getLabelRect(node, camera) {
    return {
      left: Math.round(camera.x + node.x * camera.scale),
      top: Math.round(camera.y + node.y * camera.scale - 27),
      width: Math.round(node.width * camera.scale),
      height: 22,
    };
  }

  function getSelectionRect(node, camera, gap = 2) {
    const left = Math.round(camera.x + node.x * camera.scale);
    const top = Math.round(camera.y + node.y * camera.scale);
    const right = Math.round(camera.x + (node.x + node.width) * camera.scale);
    const bottom = Math.round(camera.y + (node.y + node.height) * camera.scale);
    return {
      left: left - gap,
      top: top - gap,
      width: right - left + gap * 2,
      height: bottom - top + gap * 2,
    };
  }

  function getAspectRatio(item) {
    const width = Number(item.width);
    const height = Number(item.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return 16 / 10;
    }
    return width / height;
  }

  function selectDiverseExplorationRow(candidates, pivot) {
    const pivotFolders = new Set(pivot.folders || []);
    const pivotTags = new Set(pivot.tags || []);
    const eligible = candidates
      .map((item) => describeExplorationCandidate(item, pivotFolders, pivotTags, pivot.id))
      .filter(({ sharedKeys }) => sharedKeys.length > 0);
    const selected = [];
    const representedNovelKeys = new Set();
    const connectionCounts = new Map();
    let aspectRatioSum = 0;

    while (eligible.length) {
      let pool = eligible;
      const bridgeCandidates = pool.filter(({ novelKeys }) => novelKeys.length > 0);
      if (bridgeCandidates.length) pool = bridgeCandidates;
      const underConnectionLimit = pool.filter(({ sharedKeys }) =>
        sharedKeys.every((key) => (connectionCounts.get(key) || 0) < 2),
      );
      if (underConnectionLimit.length) pool = underConnectionLimit;

      pool.sort((a, b) => {
        const aGain = a.novelKeys.filter((key) => !representedNovelKeys.has(key)).length;
        const bGain = b.novelKeys.filter((key) => !representedNovelKeys.has(key)).length;
        const aRepeated = Math.max(0, ...a.sharedKeys.map((key) => connectionCounts.get(key) || 0));
        const bRepeated = Math.max(0, ...b.sharedKeys.map((key) => connectionCounts.get(key) || 0));
        return (
          bGain - aGain ||
          aRepeated - bRepeated ||
          a.rowOverlap - b.rowOverlap ||
          a.tieBreaker - b.tieBreaker
        );
      });

      const choice = pool[0];
      eligible.splice(eligible.indexOf(choice), 1);
      selected.push(choice.item);
      aspectRatioSum += getAspectRatio(choice.item);
      for (const key of choice.novelKeys) representedNovelKeys.add(key);
      for (const key of choice.sharedKeys) {
        connectionCounts.set(key, (connectionCounts.get(key) || 0) + 1);
      }

      const gapWidth = LAYOUT_GAP * Math.max(0, selected.length - 1);
      const fittedHeight = (LAYOUT_WIDTH - gapWidth) / aspectRatioSum;
      if (fittedHeight <= TARGET_ROW_HEIGHT) break;
    }

    return selected;
  }

  function describeExplorationCandidate(item, pivotFolders, pivotTags, pivotId) {
    const folderKeys = (item.folders || []).map((value) => `folder:${value}`);
    const tagKeys = (item.tags || []).map((value) => `tag:${value}`);
    const sharedKeys = [
      ...folderKeys.filter((key) => pivotFolders.has(key.slice(7))),
      ...tagKeys.filter((key) => pivotTags.has(key.slice(4))),
    ];
    const novelKeys = [
      ...folderKeys.filter((key) => !pivotFolders.has(key.slice(7))),
      ...tagKeys.filter((key) => !pivotTags.has(key.slice(4))),
    ];
    return {
      item,
      sharedKeys,
      novelKeys,
      rowOverlap: sharedKeys.length,
      tieBreaker: stableHash(`${pivotId || ""}:${item.id || ""}`),
    };
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function createJustifiedLayout(items) {
    const nodes = [];
    const rows = [];
    let row = [];
    let aspectRatioSum = 0;
    let y = 0;

    const commitRow = (justify) => {
      if (!row.length) return;
      const layoutRow = createLayoutRow(row.map(({ item }) => item), y, justify);
      nodes.push(...layoutRow.nodes);
      rows.push(layoutRow);
      y += getRowAdvance(layoutRow);
      row = [];
      aspectRatioSum = 0;
    };

    for (const item of items) {
      const aspectRatio = getAspectRatio(item);
      row.push({
        item,
        aspectRatio,
        isVideo: VIDEO_EXTENSIONS.has(String(item.ext || "").toLowerCase()),
      });
      aspectRatioSum += aspectRatio;

      const gapWidth = LAYOUT_GAP * Math.max(0, row.length - 1);
      const fittedHeight = (LAYOUT_WIDTH - gapWidth) / aspectRatioSum;
      if (fittedHeight <= TARGET_ROW_HEIGHT) commitRow(true);
    }

    commitRow(false);
    return { nodes, rows };
  }

  function insertExplorationRow(layout, afterRow, items) {
    const rowIndex = layout.rows.indexOf(afterRow);
    if (rowIndex < 0) throw new Error("Exploration anchor row is not part of the layout");
    if (!items.length) return { ...layout, insertedRow: null, shift: 0 };

    const top = afterRow.bottom + getRowControlsHeight(afterRow) + LAYOUT_GAP;
    const insertedRow = createLayoutRow(items, top, isFilledRow(items));
    const shift = getRowAdvance(insertedRow);
    for (let index = rowIndex + 1; index < layout.rows.length; index += 1) {
      const row = layout.rows[index];
      row.top += shift;
      row.bottom += shift;
      for (const node of row.nodes) node.y += shift;
    }
    layout.rows.splice(rowIndex + 1, 0, insertedRow);
    layout.nodes = layout.rows.flatMap((row) => row.nodes);
    return { ...layout, insertedRow, shift };
  }

  function createLayoutRow(items, y, justify) {
    const entries = items.map((item) => ({
      item,
      aspectRatio: getAspectRatio(item),
      isVideo: VIDEO_EXTENSIONS.has(String(item.ext || "").toLowerCase()),
    }));
    const aspectRatioSum = entries.reduce((sum, entry) => sum + entry.aspectRatio, 0);
    const gapWidth = LAYOUT_GAP * Math.max(0, entries.length - 1);
    const fittedHeight = (LAYOUT_WIDTH - gapWidth) / aspectRatioSum;
    let rowHeight = justify ? fittedHeight : TARGET_ROW_HEIGHT;
    rowHeight = Math.min(MAX_ROW_HEIGHT, rowHeight);

    if (rowHeight < MIN_ROW_HEIGHT) {
      const widthAtMinimumHeight = aspectRatioSum * MIN_ROW_HEIGHT + gapWidth;
      if (widthAtMinimumHeight <= LAYOUT_WIDTH) rowHeight = MIN_ROW_HEIGHT;
    }

    let x = 0;
    const layoutRow = { top: y, bottom: y + rowHeight, nodes: [] };
    for (const entry of entries) {
      const width = entry.aspectRatio * rowHeight;
      layoutRow.nodes.push({
        item: entry.item,
        x,
        y,
        width,
        height: rowHeight,
        mediaHeight: rowHeight,
        isVideo: entry.isVideo,
        rotation: 0,
      });
      x += width + LAYOUT_GAP;
    }
    return layoutRow;
  }

  function isFilledRow(items) {
    const aspectRatioSum = items.reduce((sum, item) => sum + getAspectRatio(item), 0);
    const gapWidth = LAYOUT_GAP * Math.max(0, items.length - 1);
    return (LAYOUT_WIDTH - gapWidth) / aspectRatioSum <= TARGET_ROW_HEIGHT;
  }

  function getRowAdvance(row) {
    return row.bottom - row.top + getRowControlsHeight(row) + LAYOUT_GAP;
  }

  function getRowControlsHeight(row) {
    return row.nodes.some(({ isVideo }) => isVideo) ? VIDEO_CONTROLS_HEIGHT : 0;
  }

  function findNodesNearViewport(rows, camera, viewport, screenMargin) {
    if (!rows.length) return [];
    const left = (-camera.x - screenMargin) / camera.scale;
    const top = (-camera.y - screenMargin) / camera.scale;
    const right = (viewport.width - camera.x + screenMargin) / camera.scale;
    const bottom = (viewport.height - camera.y + screenMargin) / camera.scale;
    let low = 0;
    let high = rows.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].bottom < top) low = middle + 1;
      else high = middle;
    }

    const nodes = [];
    for (let index = low; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.top > bottom) break;
      for (const node of row.nodes) {
        if (node.x + node.width >= left && node.x <= right) nodes.push(node);
      }
    }
    return nodes;
  }

  return Object.freeze({
    LAYOUT_GAP,
    LAYOUT_WIDTH,
    MAX_ROW_HEIGHT,
    MIN_ROW_HEIGHT,
    TARGET_ROW_HEIGHT,
    VIDEO_CONTROLS_HEIGHT,
    VIDEO_EXTENSIONS,
    clamp,
    createJustifiedLayout,
    directionFor,
    findNearestNodeToPoint,
    findNearestNodeInRows,
    findNodesNearViewport,
    getAspectRatio,
    getLabelRect,
    getSelectionRect,
    getViewportPanDelta,
    getViewportWorldCenter,
    insertExplorationRow,
    isPlayingVideo,
    selectDiverseExplorationRow,
    zoomCameraAtPoint,
  });
});
