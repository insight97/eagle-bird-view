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
  const ROW_GAP = 32;
  const LABEL_MIN_ZOOM = 0.3;
  const LABEL_MIN_SCALE = 1;
  const LABEL_DETAILS_MIN_ZOOM = 0.5;
  const LABEL_DETAILS_MIN_SCALE = 1.5;
  const EXPLORATION_RANK_WEIGHTS = Object.freeze([40, 25, 17, 11, 7]);
  const TAG_COLOR_PALETTE = Object.freeze({
    red: "#e56b6f",
    orange: "#e99045",
    yellow: "#d4ad42",
    green: "#64b879",
    aqua: "#4db7b3",
    blue: "#5d91d8",
    purple: "#8b7bd8",
    pink: "#d978a6",
  });
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

  function centerCameraAtPoint(camera, point, viewport) {
    return {
      ...camera,
      x: viewport.width / 2 - point.x * camera.scale,
      y: viewport.height / 2 - point.y * camera.scale,
    };
  }

  function resizeCamera(camera, previousViewport, nextViewport, previousBaseScale, nextBaseScale) {
    const center = getViewportWorldCenter(camera, previousViewport);
    const zoom = camera.scale / previousBaseScale;
    const scale = nextBaseScale * zoom;
    return {
      scale,
      x: nextViewport.width / 2 - center.x * scale,
      y: nextViewport.height / 2 - center.y * scale,
    };
  }

  function getPanLayerTranslation(camera, anchorCamera) {
    if (!anchorCamera || camera.scale !== anchorCamera.scale) return null;
    return { x: camera.x - anchorCamera.x, y: camera.y - anchorCamera.y };
  }

  function getWrappedGridTranslation(camera, gridSize, overflow) {
    const wrap = (value) => ((value % gridSize) + gridSize) % gridSize;
    return {
      x: wrap(camera.x + overflow),
      y: wrap(camera.y + overflow),
    };
  }

  function getViewportWorkInterval(isPanning) {
    return isPanning ? 250 : 100;
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

  function findDirectionalNeighbor(rows, node, direction) {
    if (!node || !direction) return null;
    const rowIndex = rows.findIndex((row) => row.nodes.includes(node));
    if (rowIndex < 0) return null;
    const [dx, dy] = direction;
    if (dx) {
      const nodeIndex = rows[rowIndex].nodes.indexOf(node);
      return rows[rowIndex].nodes[nodeIndex + dx] || null;
    }
    if (!dy) return null;
    const targetRow = rows[rowIndex + dy];
    if (!targetRow) return null;
    return findNearestNodeToPoint(targetRow.nodes, {
      x: node.x + node.width / 2,
      y: (targetRow.top + targetRow.bottom) / 2,
    });
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
      top: Math.round(camera.y + node.y * camera.scale - 51),
      width: Math.round(node.width * camera.scale),
      height: 46,
    };
  }

  function getItemRating(item) {
    const rating = Number(item?.star ?? item?.rating);
    return Number.isFinite(rating) ? clamp(Math.round(rating), 0, 5) : 0;
  }

  function formatItemDimensions(item) {
    const width = Math.round(Number(item?.width));
    const height = Math.round(Number(item?.height));
    return width > 0 && height > 0 ? `${width} × ${height}` : "";
  }

  function formatFileSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "";
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const precision = size < 10 ? 1 : 0;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
  }

  function getNextRating(current, selected) {
    const normalizedCurrent = clamp(Math.round(Number(current) || 0), 0, 5);
    const normalizedSelected = clamp(Math.round(Number(selected) || 0), 0, 5);
    return normalizedCurrent === normalizedSelected ? 0 : normalizedSelected;
  }

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [
      ...new Set(
        tags
          .filter((tag) => tag !== null && tag !== undefined)
          .map(String)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
  }

  function rankTagMatches(tags, query) {
    const needle = String(query || "").trim().toLocaleLowerCase();
    const values = normalizeTags(tags);
    if (!needle) return values.sort((first, second) => first.localeCompare(second));
    return values
      .map((tag) => {
        const normalized = tag.toLocaleLowerCase();
        const matchIndex = normalized.indexOf(needle);
        return {
          tag,
          matchIndex,
          rank: normalized === needle ? 0 : normalized.startsWith(needle) ? 1 : 2,
        };
      })
      .filter(({ matchIndex }) => matchIndex >= 0)
      .sort(
        (first, second) =>
          first.rank - second.rank ||
          first.matchIndex - second.matchIndex ||
          first.tag.length - second.tag.length ||
          first.tag.localeCompare(second.tag),
      )
      .map(({ tag }) => tag);
  }

  function getLabelDetailLevel(zoom, scale) {
    if (zoom < LABEL_MIN_ZOOM || scale < LABEL_MIN_SCALE) return "hidden";
    return zoom >= LABEL_DETAILS_MIN_ZOOM && scale >= LABEL_DETAILS_MIN_SCALE
      ? "details"
      : "name";
  }

  function normalizeTagColor(color) {
    const value = String(color || "").trim().toLowerCase();
    if (TAG_COLOR_PALETTE[value]) return TAG_COLOR_PALETTE[value];
    return /^#[\da-f]{3}([\da-f]{3})?$/.test(value) ? value : "#858a93";
  }

  function getTagColorStyle(color) {
    const normalized = normalizeTagColor(color);
    const hex =
      normalized.length === 4
        ? normalized
            .slice(1)
            .split("")
            .map((value) => value + value)
            .join("")
        : normalized.slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    const outline = channels.map((channel) => Math.round(channel * 0.82 + 255 * 0.18));
    return {
      color: `#${outline.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
      background: `rgba(${channels.join(", ")}, 0.24)`,
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

  function selectDiverseExplorationRow(candidates, pivot, random = Math.random) {
    const pivotFolders = new Set(pivot.folders || []);
    const pivotTags = new Set(pivot.tags || []);
    const eligible = candidates
      .map((item) => describeExplorationCandidate(item, pivotFolders, pivotTags))
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

      const scored = pool
        .map((candidate) => ({
          candidate,
          score: getExplorationScore(candidate, representedNovelKeys, connectionCounts),
        }))
        .sort((a, b) => compareExplorationScores(a.score, b.score));
      const shortlist = scored
        .slice(0, EXPLORATION_RANK_WEIGHTS.length)
        .map(({ candidate }) => candidate);
      const choice = shortlist[getWeightedRandomIndex(shortlist.length, random)];
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

  function selectRandomExplorationRow(candidates, random = Math.random) {
    const remaining = [...candidates];
    const selected = [];
    let aspectRatioSum = 0;

    while (remaining.length) {
      const index = Math.floor(clamp(random(), 0, 1 - Number.EPSILON) * remaining.length);
      const [item] = remaining.splice(index, 1);
      selected.push(item);
      aspectRatioSum += getAspectRatio(item);

      const gapWidth = LAYOUT_GAP * Math.max(0, selected.length - 1);
      const fittedHeight = (LAYOUT_WIDTH - gapWidth) / aspectRatioSum;
      if (fittedHeight <= TARGET_ROW_HEIGHT) break;
    }

    return selected;
  }

  function shouldLoadUnratedRow(rows, camera, viewport, baseScale) {
    if (!rows.length || camera.scale <= baseScale) return false;
    const lastRow = rows.at(-1);
    const screenCenter = camera.y + ((lastRow.top + lastRow.bottom) / 2) * camera.scale;
    return screenCenter >= 0 && screenCenter <= viewport.height;
  }

  function getExplorationScore(candidate, representedNovelKeys, connectionCounts) {
    const unrepresentedKeys = candidate.novelKeys.filter(
      (key) => !representedNovelKeys.has(key),
    );
    return {
      gain:
        Number(unrepresentedKeys.some((key) => key.startsWith("folder:"))) +
        Number(unrepresentedKeys.some((key) => key.startsWith("tag:"))),
      repeated: Math.max(
        0,
        ...candidate.sharedKeys.map((key) => connectionCounts.get(key) || 0),
      ),
      overlap: candidate.rowOverlap,
    };
  }

  function compareExplorationScores(a, b) {
    return b.gain - a.gain || a.repeated - b.repeated || a.overlap - b.overlap;
  }

  function getWeightedRandomIndex(length, random) {
    const weights = EXPLORATION_RANK_WEIGHTS.slice(0, length);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = clamp(random(), 0, 1 - Number.EPSILON) * totalWeight;
    for (let index = 0; index < weights.length; index += 1) {
      threshold -= weights[index];
      if (threshold < 0) return index;
    }
    return weights.length - 1;
  }

  function describeExplorationCandidate(item, pivotFolders, pivotTags) {
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
    };
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

    const top = afterRow.bottom + getRowControlsHeight(afterRow) + ROW_GAP;
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
    return row.bottom - row.top + getRowControlsHeight(row) + ROW_GAP;
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
    ROW_GAP,
    LAYOUT_WIDTH,
    MAX_ROW_HEIGHT,
    MIN_ROW_HEIGHT,
    TARGET_ROW_HEIGHT,
    VIDEO_CONTROLS_HEIGHT,
    VIDEO_EXTENSIONS,
    clamp,
    centerCameraAtPoint,
    createJustifiedLayout,
    directionFor,
    findNearestNodeToPoint,
    findNearestNodeInRows,
    findDirectionalNeighbor,
    findNodesNearViewport,
    formatFileSize,
    formatItemDimensions,
    getAspectRatio,
    getItemRating,
    getNextRating,
    getLabelRect,
    getLabelDetailLevel,
    getPanLayerTranslation,
    getWrappedGridTranslation,
    getViewportWorkInterval,
    getTagColorStyle,
    normalizeTags,
    normalizeTagColor,
    rankTagMatches,
    resizeCamera,
    getViewportPanDelta,
    getViewportWorldCenter,
    insertExplorationRow,
    isPlayingVideo,
    selectDiverseExplorationRow,
    selectRandomExplorationRow,
    shouldLoadUnratedRow,
    zoomCameraAtPoint,
  });
});
