"use strict";

(function exposeBirdViewCore(root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  root.BirdViewCore = core;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
  const VIDEO_CONTROLS_HEIGHT = 14;
  const LAYOUT_WIDTH = 1200;
  const TARGET_ROW_HEIGHT = 180;
  const MIN_ROW_HEIGHT = 140;
  const MAX_ROW_HEIGHT = 220;
  const LAYOUT_GAP = 14;

  function getAspectRatio(item) {
    const width = Number(item.width);
    const height = Number(item.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return 16 / 10;
    }
    return width / height;
  }

  function createJustifiedLayout(items) {
    const nodes = [];
    const rows = [];
    let row = [];
    let aspectRatioSum = 0;
    let y = 0;

    const commitRow = (justify) => {
      if (!row.length) return;
      const gapWidth = LAYOUT_GAP * Math.max(0, row.length - 1);
      const fittedHeight = (LAYOUT_WIDTH - gapWidth) / aspectRatioSum;
      let rowHeight = justify ? fittedHeight : TARGET_ROW_HEIGHT;
      rowHeight = Math.min(MAX_ROW_HEIGHT, rowHeight);

      if (rowHeight < MIN_ROW_HEIGHT) {
        const widthAtMinimumHeight = aspectRatioSum * MIN_ROW_HEIGHT + gapWidth;
        if (widthAtMinimumHeight <= LAYOUT_WIDTH) rowHeight = MIN_ROW_HEIGHT;
      }

      let x = 0;
      let rowHasVideo = false;
      const layoutRow = { top: y, bottom: y + rowHeight, nodes: [] };
      for (const entry of row) {
        const width = entry.aspectRatio * rowHeight;
        const node = {
          item: entry.item,
          x,
          y,
          width,
          height: rowHeight,
          mediaHeight: rowHeight,
          isVideo: entry.isVideo,
          rotation: 0,
        };
        nodes.push(node);
        layoutRow.nodes.push(node);
        x += width + LAYOUT_GAP;
        rowHasVideo ||= entry.isVideo;
      }

      rows.push(layoutRow);
      y += rowHeight + (rowHasVideo ? VIDEO_CONTROLS_HEIGHT : 0) + LAYOUT_GAP;
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
    createJustifiedLayout,
    findNodesNearViewport,
    getAspectRatio,
  });
});
