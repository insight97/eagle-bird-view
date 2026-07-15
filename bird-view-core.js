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
      const dx = Math.max(node.x - point.x, 0, point.x - (node.x + node.width));
      const dy = Math.max(node.y - point.y, 0, point.y - (node.y + node.height));
      const edgeDistance = dx ** 2 + dy ** 2;
      const center = getNodeCenter(node);
      const centerDistance = (center.x - point.x) ** 2 + (center.y - point.y) ** 2;
      if (
        !nearest ||
        edgeDistance < nearest.edgeDistance ||
        (edgeDistance === nearest.edgeDistance && centerDistance < nearest.centerDistance)
      ) {
        nearest = { node, edgeDistance, centerDistance };
      }
    }
    return nearest?.node || null;
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
    clamp,
    createJustifiedLayout,
    directionFor,
    findNearestNodeToPoint,
    findNodesNearViewport,
    getAspectRatio,
    getLabelRect,
    getViewportPanDelta,
    getViewportWorldCenter,
    isPlayingVideo,
    zoomCameraAtPoint,
  });
});
