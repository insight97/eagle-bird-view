"use strict";

(function exposeBirdViewCore(root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  root.BirdViewCore = core;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
  const VIDEO_CONTROLS_HEIGHT = 8;
  const VIDEO_AUTOPLAY_MIN_HEIGHT = 320;
  const LAYOUT_WIDTH = 1200;
  const MIN_LAYOUT_WIDTH = 240;
  const MAX_LAYOUT_WIDTH = 2400;
  const TARGET_ROW_HEIGHT = 180;
  const MIN_ROW_HEIGHT = 140;
  const MAX_ROW_HEIGHT = 220;
  const LAYOUT_GAP = 14;
  const ROW_GAP = 32;
  const DEFAULT_LAYOUT_DIRECTION = "ltr";
  const LABEL_MIN_ZOOM = 0.3;
  const LABEL_MIN_SCALE = 1;
  const LABEL_DETAILS_MIN_ZOOM = 0.5;
  const LABEL_DETAILS_MIN_SCALE = 1.5;
  const CROSS_ROW_FOCUS_MIN_DURATION = 240;
  const CROSS_ROW_FOCUS_MAX_DURATION = 420;
  const CROSS_ROW_FOCUS_DISTANCE_FACTOR = 0.1;
  const CROSS_ROW_FOCUS_SCALE_FACTOR = 100;
  // Eagle originals are full-resolution masters: a painting can be 5374x7589
  // (40 MP, 156 MiB once decoded to RGBA), which on its own overruns Chromium's
  // image decode cache. Every raster then misses the cache and re-decodes the
  // master on a compositor tile worker, which is what drops frames while the
  // camera moves. Cards paint a bounded raster instead, sized in power-of-two
  // steps so a small zoom change does not churn through re-rasters.
  // The ceiling only binds when a card paints larger than this on screen, which
  // at 1200% zoom means one or two cards. Past it the master itself is used,
  // since a raster that large stops being a saving.
  const MIN_RASTER_DIMENSION = 512;
  const MAX_RASTER_DIMENSION = 4096;
  // Preload roughly two passes ahead of the camera, so a load that starts now
  // has until the node reaches the viewport to finish.
  const PRELOAD_LEAD_FACTOR = 2;
  const EXPLORATION_RANK_WEIGHTS = Object.freeze([40, 25, 17, 11, 7]);
  const AI_EXPLORATION_RATIOS = Object.freeze([0, 25, 50, 75, 100]);
  const EXPLORATION_DIVERSITY_STRENGTHS = Object.freeze([0, 25, 50, 75, 100]);
  const DEFAULT_MAX_EXPLORATION_ITEMS = 12;
  const MIN_EXPLORATION_ITEMS = 3;
  const MAX_EXPLORATION_ITEMS = 50;
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
  const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
  const WASD_TO_ARROW = { w: "arrowup", s: "arrowdown", a: "arrowleft", d: "arrowright" };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function directionFor(key) {
    const normalizedKey = String(key || "").toLowerCase();
    return ARROW_DIRECTIONS[normalizedKey] || ARROW_DIRECTIONS[WASD_TO_ARROW[normalizedKey]];
  }

  function getArrowKeyAction(event, { playingVideo = false } = {}) {
    if (!ARROW_KEYS.has(event?.key)) return null;
    if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey) {
      return playingVideo ? "video-control" : "focus-selection";
    }
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return "viewport-pan";
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    return "free-pan";
  }

  function shouldAutoplayVideo(node, scale, minimumHeight = VIDEO_AUTOPLAY_MIN_HEIGHT) {
    const screenHeight = Number(node?.mediaHeight) * Number(scale);
    const threshold = Number(minimumHeight);
    return Boolean(
      node?.isVideo &&
        Number.isFinite(screenHeight) &&
        Number.isFinite(threshold) &&
        screenHeight >= threshold,
    );
  }

  // How many pixels along the longest edge a card is allowed to raster at the
  // given on-screen size. Quantised so panning and small zoom steps keep hitting
  // the same budget, and only a real zoom-in pays for a sharper raster.
  function getRasterDimensionBudget(screenLongEdge, options = {}) {
    const {
      minDimension = MIN_RASTER_DIMENSION,
      maxDimension = MAX_RASTER_DIMENSION,
    } = options;
    const floor = Math.max(1, Number(minDimension) || MIN_RASTER_DIMENSION);
    const ceiling = Math.max(floor, Number(maxDimension) || MAX_RASTER_DIMENSION);
    const needed = Number(screenLongEdge);
    if (!Number.isFinite(needed) || needed <= 0) return floor;
    let budget = floor;
    while (budget < needed && budget < ceiling) budget *= 2;
    return Math.min(budget, ceiling);
  }

  // Returns the size a card should raster its original at, or null when the
  // source is already within budget and can be painted untouched.
  function getRasterTargetSize(sourceWidth, sourceHeight, screenLongEdge, options = {}) {
    const width = Number(sourceWidth);
    const height = Number(sourceHeight);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    const budget = getRasterDimensionBudget(screenLongEdge, options);
    const sourceLongEdge = Math.max(width, height);
    if (sourceLongEdge <= budget) return null;
    const ratio = budget / sourceLongEdge;
    return {
      budget,
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
    };
  }

  // Media has to start loading before it is on screen, or a fast pan outruns it.
  // Extending the preload band evenly costs work in three directions the camera
  // is leaving, so the lead goes only where the camera is heading, sized by how
  // far it travelled last pass. A node's screen position is
  // `camera.x + node.x * scale`, so a rising camera.x reveals content on the
  // left and a falling one reveals it on the right.
  function getPreloadMargins(travel, baseMargin = 0, maxLead = Infinity) {
    const base = Math.max(0, Number(baseMargin) || 0);
    const limit = Math.max(0, Number(maxLead) || 0);
    const x = Number(travel?.x) || 0;
    const y = Number(travel?.y) || 0;
    const leadX = Math.min(Math.abs(x) * PRELOAD_LEAD_FACTOR, limit);
    const leadY = Math.min(Math.abs(y) * PRELOAD_LEAD_FACTOR, limit);
    return {
      left: x > 0 ? base + leadX : base,
      right: x < 0 ? base + leadX : base,
      top: y > 0 ? base + leadY : base,
      bottom: y < 0 ? base + leadY : base,
    };
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

  function getNodeScreenCenter(node, camera) {
    return {
      x: camera.x + (node.x + node.width / 2) * camera.scale,
      y: camera.y + (node.y + node.mediaHeight / 2) * camera.scale,
    };
  }

  function reanchorCameraToNode(camera, node, screenCenter) {
    return {
      ...camera,
      x: screenCenter.x - (node.x + node.width / 2) * camera.scale,
      y: screenCenter.y - (node.y + node.mediaHeight / 2) * camera.scale,
    };
  }

  function centerCameraAtPoint(camera, point, viewport) {
    return {
      ...camera,
      x: viewport.width / 2 - point.x * camera.scale,
      y: viewport.height / 2 - point.y * camera.scale,
    };
  }

  function interpolateCamera(start, target, progress) {
    const normalizedProgress = clamp(progress, 0, 1);
    const eased = 1 - (1 - normalizedProgress) ** 3;
    return {
      x: start.x + (target.x - start.x) * eased,
      y: start.y + (target.y - start.y) * eased,
      scale: start.scale + (target.scale - start.scale) * eased,
    };
  }

  function getCrossRowFocusDuration(start, target) {
    const distance = Math.hypot(
      Number(target?.x) - Number(start?.x),
      Number(target?.y) - Number(start?.y),
    );
    const startScale = Number(start?.scale);
    const targetScale = Number(target?.scale);
    const scaleRatio =
      startScale > 0 && targetScale > 0
        ? Math.abs(Math.log(targetScale / startScale))
        : 0;
    return clamp(
      CROSS_ROW_FOCUS_MIN_DURATION +
        distance * CROSS_ROW_FOCUS_DISTANCE_FACTOR +
        scaleRatio * CROSS_ROW_FOCUS_SCALE_FACTOR,
      CROSS_ROW_FOCUS_MIN_DURATION,
      CROSS_ROW_FOCUS_MAX_DURATION,
    );
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

  function findDirectionalNeighbor(rows, node, direction, options = {}) {
    if (!node || !direction) return null;
    const rowIndex = rows.findIndex((row) => row.nodes.includes(node));
    if (rowIndex < 0) return null;
    const [dx, dy] = direction;
    if (dx) {
      const horizontalNodes = [...rows[rowIndex].nodes].sort((first, second) => first.x - second.x);
      const nodeIndex = horizontalNodes.indexOf(node);
      const neighbor = horizontalNodes[nodeIndex + dx];
      if (neighbor || !options.wrapRows) return neighbor || null;

      const layoutDirection = normalizeLayoutDirection(options.layoutDirection);
      const movesInLayoutOrder = layoutDirection === "ltr" ? dx > 0 : dx < 0;
      const targetRow = rows[rowIndex + (movesInLayoutOrder ? 1 : -1)];
      if (!targetRow) return null;
      const targetNodes = [...targetRow.nodes].sort((first, second) => first.x - second.x);
      return targetNodes[dx > 0 ? 0 : targetNodes.length - 1] || null;
    }
    if (!dy) return null;
    const currentRow = rows[rowIndex];
    const targetRow = rows[rowIndex + dy];
    if (!targetRow) return null;
    const nodeIndex = currentRow.nodes.indexOf(node);
    if (options.edgeTarget === "first") {
      return targetRow.nodes[0] || null;
    }
    if (options.edgeTarget === "last") {
      return targetRow.nodes.at(-1) || null;
    }
    if (options.edgeTarget !== null && nodeIndex === 0) {
      return targetRow.nodes[0] || null;
    }
    if (options.edgeTarget !== null && nodeIndex === currentRow.nodes.length - 1) {
      return targetRow.nodes.at(-1) || null;
    }
    return findNearestNodeToPoint(targetRow.nodes, {
      x: Number.isFinite(options.preferredX) ? options.preferredX : node.x + node.width / 2,
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

  function selectAiExplorationItems(
    candidates,
    maxItems = 0,
    { diversityStrength = 0 } = {},
  ) {
    const normalizedMaxItems = normalizeMaxAiExplorationItems(maxItems);
    if (!Array.isArray(candidates) || normalizedMaxItems < 1) return [];
    const uniqueCandidates = [];
    const candidateIds = new Set();
    for (const candidate of candidates) {
      const item = candidate?.item?.id ? candidate.item : null;
      if (!item?.id || !Number.isFinite(Number(candidate.aiScore))) continue;
      if (candidateIds.has(item.id)) continue;
      candidateIds.add(item.id);
      uniqueCandidates.push({
        item,
        aiScore: clamp(Number(candidate.aiScore), 0, 1),
        responseIndex: uniqueCandidates.length,
      });
      if (uniqueCandidates.length >= MAX_EXPLORATION_ITEMS * 4) break;
    }
    const normalizedDiversityStrength = normalizeExplorationDiversityStrength(diversityStrength);
    if (normalizedDiversityStrength === 0) {
      return uniqueCandidates.slice(0, normalizedMaxItems).map(({ item }) => item);
    }

    const remaining = [...uniqueCandidates];
    const selected = [];
    const representedKeys = new Set();
    const connectionCounts = new Map();
    while (remaining.length && selected.length < normalizedMaxItems) {
      const scored = remaining
        .map((candidate) => {
          const keys = getCandidateDiversityKeys(candidate.item);
          const novelKeys = keys.filter((key) => !representedKeys.has(key));
          const repeatedKeys = keys.filter((key) => representedKeys.has(key));
          const responseRank =
            1 - candidate.responseIndex / Math.max(1, uniqueCandidates.length - 1);
          const relevance = (candidate.aiScore + responseRank) / 2;
          const novelty = Math.min(1, novelKeys.length / 3);
          const repetition = repeatedKeys.reduce(
            (sum, key) => sum + (connectionCounts.get(key) || 0),
            0,
          );
          const diversity = novelty - Math.min(1, repetition / 2) * 0.7;
          const strength = normalizedDiversityStrength / 100;
          return {
            candidate,
            index: candidate.responseIndex,
            score: relevance * (1 - strength * 0.5) + diversity * strength * 0.5,
          };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const [{ candidate }] = scored;
      const candidateIndex = remaining.indexOf(candidate);
      remaining.splice(candidateIndex, 1);
      selected.push(candidate.item);
      for (const key of getCandidateDiversityKeys(candidate.item)) {
        representedKeys.add(key);
        connectionCounts.set(key, (connectionCounts.get(key) || 0) + 1);
      }
    }
    return selected;
  }

  function selectDiverseExplorationRow(
    candidates,
    pivot,
    random = Math.random,
    layoutWidth = LAYOUT_WIDTH,
    maxItems = DEFAULT_MAX_EXPLORATION_ITEMS,
    { maxAiItems = Infinity, diversityStrength = 0 } = {},
  ) {
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const normalizedMaxItems = normalizeExplorationItemLimit(maxItems);
    const normalizedMaxAiItems = normalizeMaxAiExplorationItems(maxAiItems);
    const normalizedDiversityStrength = normalizeExplorationDiversityStrength(diversityStrength);
    const pivotFolders = new Set(pivot.folders || []);
    const pivotTags = new Set(pivot.tags || []);
    const eligible = candidates
      .map((item) => describeExplorationCandidate(item, pivotFolders, pivotTags))
      .filter(({ sharedKeys, aiScore }) => sharedKeys.length > 0 || aiScore !== null);
    const selected = [];
    const selectedCandidates = [];
    const representedNovelKeys = new Set();
    const connectionCounts = new Map();
    let aspectRatioSum = 0;

    while (eligible.length) {
      let pool = eligible;
      const selectedAiCount = selectedCandidates.filter(({ aiScore }) => aiScore !== null).length;
      if (selectedAiCount >= normalizedMaxAiItems) {
        pool = pool.filter(({ aiScore }) => aiScore === null);
      }
      if (!pool.length) break;
      const bridgeCandidates = pool.filter(({ novelKeys }) => novelKeys.length > 0);
      if (bridgeCandidates.length) pool = bridgeCandidates;
      const underConnectionLimit = pool.filter(({ sharedKeys }) =>
        sharedKeys.every((key) =>
          (connectionCounts.get(key) || 0) < getExplorationConnectionLimit(normalizedDiversityStrength),
        ),
      );
      if (underConnectionLimit.length) pool = underConnectionLimit;

      const scored = pool
        .map((candidate) => ({
          candidate,
          score: getExplorationScore(
            candidate,
            representedNovelKeys,
            connectionCounts,
            normalizedDiversityStrength,
          ),
          tieBreaker: random(),
        }))
        .sort(
          (a, b) =>
            compareExplorationScores(a.score, b.score) || b.tieBreaker - a.tieBreaker,
        );
      const shortlist = scored
        .slice(0, EXPLORATION_RANK_WEIGHTS.length)
        .map(({ candidate }) => candidate);
      const choice = shortlist[getWeightedRandomIndex(shortlist.length, random)];
      eligible.splice(eligible.indexOf(choice), 1);
      selectedCandidates.push(choice);
      selected.push(choice.item);
      aspectRatioSum += getAspectRatio(choice.item);
      for (const key of choice.novelKeys) representedNovelKeys.add(key);
      for (const key of choice.sharedKeys) {
        connectionCounts.set(key, (connectionCounts.get(key) || 0) + 1);
      }

      const gapWidth = LAYOUT_GAP * Math.max(0, selected.length - 1);
      const fittedHeight = (normalizedLayoutWidth - gapWidth) / aspectRatioSum;
      if (
        selected.length >= normalizedMaxItems ||
        (selected.length >= MIN_EXPLORATION_ITEMS &&
          (normalizedLayoutWidth === MIN_LAYOUT_WIDTH || fittedHeight <= TARGET_ROW_HEIGHT))
      ) {
        break;
      }
    }

    return selected;
  }

  function selectRandomExplorationRow(
    candidates,
    random = Math.random,
    layoutWidth = LAYOUT_WIDTH,
    maxItems = DEFAULT_MAX_EXPLORATION_ITEMS,
  ) {
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const normalizedMaxItems = normalizeExplorationItemLimit(maxItems);
    const remaining = [...candidates];
    const selected = [];
    let aspectRatioSum = 0;

    while (remaining.length) {
      const index = Math.floor(clamp(random(), 0, 1 - Number.EPSILON) * remaining.length);
      const [item] = remaining.splice(index, 1);
      selected.push(item);
      aspectRatioSum += getAspectRatio(item);

      const gapWidth = LAYOUT_GAP * Math.max(0, selected.length - 1);
      const fittedHeight = (normalizedLayoutWidth - gapWidth) / aspectRatioSum;
      if (
        selected.length >= normalizedMaxItems ||
        (selected.length >= MIN_EXPLORATION_ITEMS &&
          (normalizedLayoutWidth === MIN_LAYOUT_WIDTH || fittedHeight <= TARGET_ROW_HEIGHT))
      ) {
        break;
      }
    }

    return selected;
  }

  function shouldLoadUnratedRow(rows, camera, viewport, baseScale, minimumZoom = 0.8) {
    if (!rows.length || camera.scale < baseScale * minimumZoom) return false;
    const lastRow = rows.at(-1);
    const screenCenter = camera.y + ((lastRow.top + lastRow.bottom) / 2) * camera.scale;
    return screenCenter >= 0 && screenCenter <= viewport.height;
  }

  function getExplorationScore(
    candidate,
    representedNovelKeys,
    connectionCounts,
    diversityStrength = 0,
  ) {
    const unrepresentedKeys = candidate.novelKeys.filter(
      (key) => !representedNovelKeys.has(key),
    );
    const repeatedKeys = candidate.sharedKeys.reduce(
      (sum, key) => sum + (connectionCounts.get(key) || 0),
      0,
    );
    return {
      gain:
        Number(unrepresentedKeys.some((key) => key.startsWith("folder:"))) +
        Number(unrepresentedKeys.some((key) => key.startsWith("tag:"))) +
        Number(unrepresentedKeys.includes("source:ai")),
      repeated: Math.max(
        0,
        ...candidate.sharedKeys.map((key) => connectionCounts.get(key) || 0),
      ),
      diversityBonus:
        (unrepresentedKeys.filter((key) => !key.startsWith("source:")).length - repeatedKeys) *
        (diversityStrength / 100),
      overlap: candidate.rowOverlap,
      aiScore: candidate.aiScore || 0,
    };
  }

  function compareExplorationScores(a, b) {
    return (
      b.gain - a.gain ||
      b.diversityBonus - a.diversityBonus ||
      a.repeated - b.repeated ||
      b.aiScore - a.aiScore ||
      a.overlap - b.overlap
    );
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
    const candidateItem = item?.item?.id ? item.item : item;
    const aiScore = Number.isFinite(Number(item?.aiScore))
      ? clamp(Number(item.aiScore), 0, 1)
      : null;
    const folderKeys = (candidateItem.folders || []).map((value) => `folder:${value}`);
    const tagKeys = (candidateItem.tags || []).map((value) => `tag:${value}`);
    const sharedKeys = [
      ...folderKeys.filter((key) => pivotFolders.has(key.slice(7))),
      ...tagKeys.filter((key) => pivotTags.has(key.slice(4))),
    ];
    const novelKeys = [
      ...folderKeys.filter((key) => !pivotFolders.has(key.slice(7))),
      ...tagKeys.filter((key) => !pivotTags.has(key.slice(4))),
    ];
    if (aiScore !== null) novelKeys.push("source:ai");
    return {
      item: candidateItem,
      aiScore,
      sharedKeys,
      novelKeys,
      rowOverlap: sharedKeys.length,
    };
  }

  function normalizeMaxAiExplorationItems(maxItems) {
    if (maxItems === Infinity) return Infinity;
    const value = Number(maxItems);
    return Number.isFinite(value) ? clamp(Math.floor(value), 0, MAX_EXPLORATION_ITEMS) : Infinity;
  }

  function normalizeAiExplorationRatio(ratio) {
    const value = Number(ratio);
    if (!Number.isFinite(value)) return 0;
    return AI_EXPLORATION_RATIOS.reduce((closest, candidate) =>
      Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
    );
  }

  function normalizeExplorationDiversityStrength(strength) {
    const value = Number(strength);
    if (!Number.isFinite(value)) return 0;
    return EXPLORATION_DIVERSITY_STRENGTHS.reduce((closest, candidate) =>
      Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest,
    );
  }

  function getExplorationConnectionLimit(diversityStrength) {
    return diversityStrength >= 75 ? 1 : 2;
  }

  function getCandidateDiversityKeys(item) {
    return [...new Set([
      ...(item?.folders || []).map((value) => `folder:${value}`),
      ...(item?.tags || []).map((value) => `tag:${value}`),
    ])];
  }

  function getAiExplorationItemLimit(maxItems, ratio) {
    const normalizedMaxItems = normalizeExplorationItemLimit(maxItems);
    return Math.round(normalizedMaxItems * normalizeAiExplorationRatio(ratio) / 100);
  }

  function normalizeLayoutDirection(direction) {
    return direction === "rtl" ? "rtl" : DEFAULT_LAYOUT_DIRECTION;
  }

  function normalizeLayoutWidth(layoutWidth) {
    if (layoutWidth === Infinity) return Infinity;
    const value = Number(layoutWidth);
    return Number.isFinite(value) ? clamp(value, MIN_LAYOUT_WIDTH, MAX_LAYOUT_WIDTH) : LAYOUT_WIDTH;
  }

  function normalizeExplorationItemLimit(maxItems) {
    const value = Number(maxItems);
    return Number.isFinite(value)
      ? clamp(Math.floor(value), MIN_EXPLORATION_ITEMS, MAX_EXPLORATION_ITEMS)
      : DEFAULT_MAX_EXPLORATION_ITEMS;
  }

  function createJustifiedLayout(
    items,
    direction = DEFAULT_LAYOUT_DIRECTION,
    layoutWidth = LAYOUT_WIDTH,
    layoutOptions = {},
  ) {
    const normalizedDirection = normalizeLayoutDirection(direction);
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const { gap, rowGap, videoControlsHeight } = normalizeLayoutOptions(layoutOptions);
    const nodes = [];
    const rows = [];
    let row = [];
    let aspectRatioSum = 0;
    let y = 0;

    const commitRow = (justify) => {
      if (!row.length) return;
      const layoutRow = createLayoutRow(
        row.map(({ item }) => item),
        y,
        justify,
        normalizedDirection,
        normalizedLayoutWidth,
        { gap, videoControlsHeight },
      );
      nodes.push(...layoutRow.nodes);
      rows.push(layoutRow);
      y += getRowAdvance(layoutRow, rowGap);
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

      const gapWidth = gap * Math.max(0, row.length - 1);
      const fittedHeight = (normalizedLayoutWidth - gapWidth) / aspectRatioSum;
      if (normalizedLayoutWidth === MIN_LAYOUT_WIDTH || fittedHeight <= TARGET_ROW_HEIGHT) {
        commitRow(true);
      }
    }

    commitRow(false);
    return {
      nodes,
      rows,
      direction: normalizedDirection,
      layoutWidth: normalizedLayoutWidth,
      gap,
      rowGap,
      videoControlsHeight,
    };
  }

  function insertExplorationRow(
    layout,
    afterRow,
    items,
    direction = layout.direction || DEFAULT_LAYOUT_DIRECTION,
    layoutWidth = layout.layoutWidth ?? LAYOUT_WIDTH,
    layoutOptions = {},
  ) {
    const normalizedDirection = normalizeLayoutDirection(direction);
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const { gap, rowGap, videoControlsHeight } = normalizeLayoutOptions({
      gap: layout.gap,
      rowGap: layout.rowGap,
      videoControlsHeight: layout.videoControlsHeight,
      ...layoutOptions,
    });
    const rowIndex = layout.rows.indexOf(afterRow);
    if (rowIndex < 0) throw new Error("Exploration anchor row is not part of the layout");
    if (!items.length) {
      return {
        ...layout,
        direction: normalizedDirection,
        layoutWidth: normalizedLayoutWidth,
        insertedRow: null,
        insertedRows: [],
        shift: 0,
      };
    }

    const top = afterRow.bottom + getRowControlsHeight(afterRow) + rowGap;
    const itemGroups = splitExplorationItemsIntoRows(
      items,
      normalizedLayoutWidth,
      gap,
    );
    const insertedRows = [];
    let nextTop = top;
    for (const group of itemGroups) {
      const insertedRow = createLayoutRow(
        group,
        nextTop,
        isFilledRow(group, normalizedLayoutWidth, { gap }),
        normalizedDirection,
        normalizedLayoutWidth,
        { gap, videoControlsHeight },
      );
      insertedRows.push(insertedRow);
      nextTop += getRowAdvance(insertedRow, rowGap);
    }
    const shift = nextTop - top;
    for (let index = rowIndex + 1; index < layout.rows.length; index += 1) {
      const row = layout.rows[index];
      row.top += shift;
      row.bottom += shift;
      for (const node of row.nodes) node.y += shift;
    }
    layout.rows.splice(rowIndex + 1, 0, ...insertedRows);
    layout.nodes = layout.rows.flatMap((row) => row.nodes);
    return {
      ...layout,
      direction: normalizedDirection,
      layoutWidth: normalizedLayoutWidth,
      gap,
      rowGap,
      videoControlsHeight,
      insertedRow: insertedRows[0],
      insertedRows,
      shift,
    };
  }

  function createLayoutRow(
    items,
    y,
    justify,
    direction = DEFAULT_LAYOUT_DIRECTION,
    layoutWidth = LAYOUT_WIDTH,
    layoutOptions = {},
  ) {
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const { gap, videoControlsHeight } = normalizeLayoutOptions(layoutOptions);
    const entries = items.map((item) => ({
      item,
      aspectRatio: getAspectRatio(item),
      isVideo: VIDEO_EXTENSIONS.has(String(item.ext || "").toLowerCase()),
    }));
    const aspectRatioSum = entries.reduce((sum, entry) => sum + entry.aspectRatio, 0);
    const gapWidth = gap * Math.max(0, entries.length - 1);
    const fittedHeight = (normalizedLayoutWidth - gapWidth) / aspectRatioSum;
    let rowHeight = justify ? fittedHeight : Math.min(TARGET_ROW_HEIGHT, fittedHeight);
    rowHeight = Math.min(MAX_ROW_HEIGHT, rowHeight);

    if (rowHeight < MIN_ROW_HEIGHT) {
      const widthAtMinimumHeight = aspectRatioSum * MIN_ROW_HEIGHT + gapWidth;
      if (widthAtMinimumHeight <= normalizedLayoutWidth) rowHeight = MIN_ROW_HEIGHT;
    }

    const rowWidth = aspectRatioSum * rowHeight + gapWidth;
    let x = direction === "rtl"
      ? Number.isFinite(normalizedLayoutWidth)
        ? normalizedLayoutWidth
        : rowWidth
      : 0;
    const layoutRow = {
      top: y,
      bottom: y + rowHeight,
      nodes: [],
      videoControlsHeight,
    };
    for (const entry of entries) {
      const width = entry.aspectRatio * rowHeight;
      if (direction === "rtl") x -= width;
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
      x += direction === "rtl" ? -gap : width + gap;
    }
    return layoutRow;
  }

  function isFilledRow(items, layoutWidth = LAYOUT_WIDTH, layoutOptions = {}) {
    const normalizedLayoutWidth = normalizeLayoutWidth(layoutWidth);
    const { gap } = normalizeLayoutOptions(layoutOptions);
    const aspectRatioSum = items.reduce((sum, item) => sum + getAspectRatio(item), 0);
    const gapWidth = gap * Math.max(0, items.length - 1);
    return (normalizedLayoutWidth - gapWidth) / aspectRatioSum <= TARGET_ROW_HEIGHT;
  }

  function splitExplorationItemsIntoRows(items, layoutWidth, gap) {
    if (layoutWidth === MIN_LAYOUT_WIDTH) return items.map((item) => [item]);

    const groups = [];
    let group = [];
    let aspectRatioSum = 0;
    for (const item of items) {
      group.push(item);
      aspectRatioSum += getAspectRatio(item);
      const gapWidth = gap * Math.max(0, group.length - 1);
      const fittedHeight = (layoutWidth - gapWidth) / aspectRatioSum;
      if (fittedHeight <= TARGET_ROW_HEIGHT) {
        groups.push(group);
        group = [];
        aspectRatioSum = 0;
      }
    }
    if (group.length) groups.push(group);
    return groups;
  }

  function getRowAdvance(row, rowGap = ROW_GAP) {
    return row.bottom - row.top + getRowControlsHeight(row) + normalizeLayoutSpacing(rowGap, ROW_GAP);
  }

  function normalizeLayoutSpacing(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function normalizeLayoutOptions(options = {}) {
    return {
      gap: normalizeLayoutSpacing(options.gap, LAYOUT_GAP),
      rowGap: normalizeLayoutSpacing(options.rowGap, ROW_GAP),
      videoControlsHeight: normalizeLayoutSpacing(
        options.videoControlsHeight,
        VIDEO_CONTROLS_HEIGHT,
      ),
    };
  }

  function getRowControlsHeight(row) {
    if (!row.nodes.some(({ isVideo }) => isVideo)) return 0;
    return normalizeLayoutSpacing(row.videoControlsHeight, VIDEO_CONTROLS_HEIGHT);
  }

  function getRowFocusScale(
    baseScale,
    rowHeight,
    { targetHeight = TARGET_ROW_HEIGHT, emphasis = 0.9 } = {},
  ) {
    const safeBaseScale = Number(baseScale);
    const safeRowHeight = Number(rowHeight);
    const safeTargetHeight = Number(targetHeight);
    const safeEmphasis = Number(emphasis);
    if (
      !Number.isFinite(safeBaseScale) ||
      !Number.isFinite(safeRowHeight) ||
      !Number.isFinite(safeTargetHeight) ||
      !Number.isFinite(safeEmphasis) ||
      safeBaseScale <= 0 ||
      safeRowHeight <= 0 ||
      safeTargetHeight <= 0 ||
      safeEmphasis <= 0
    ) {
      return safeBaseScale > 0 ? safeBaseScale : 0;
    }
    return safeBaseScale * (safeTargetHeight / safeRowHeight) * safeEmphasis;
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
    AI_EXPLORATION_RATIOS,
    EXPLORATION_DIVERSITY_STRENGTHS,
    LAYOUT_GAP,
    ROW_GAP,
    DEFAULT_MAX_EXPLORATION_ITEMS,
    LAYOUT_WIDTH,
    MAX_LAYOUT_WIDTH,
    MAX_EXPLORATION_ITEMS,
    MAX_ROW_HEIGHT,
    MIN_EXPLORATION_ITEMS,
    MIN_LAYOUT_WIDTH,
    MIN_RASTER_DIMENSION,
    MAX_RASTER_DIMENSION,
    MIN_ROW_HEIGHT,
    TARGET_ROW_HEIGHT,
    VIDEO_AUTOPLAY_MIN_HEIGHT,
    VIDEO_CONTROLS_HEIGHT,
    VIDEO_EXTENSIONS,
    clamp,
    centerCameraAtPoint,
    createJustifiedLayout,
    directionFor,
    getArrowKeyAction,
    getCrossRowFocusDuration,
    findNearestNodeToPoint,
    findNearestNodeInRows,
    findDirectionalNeighbor,
    findNodesNearViewport,
    formatFileSize,
    formatItemDimensions,
    getAspectRatio,
    getAiExplorationItemLimit,
    getItemRating,
    getNextRating,
    getRowFocusScale,
    getLabelRect,
    getLabelDetailLevel,
    getPanLayerTranslation,
    getPreloadMargins,
    getRasterDimensionBudget,
    getRasterTargetSize,
    getWrappedGridTranslation,
    getViewportWorkInterval,
    getTagColorStyle,
    normalizeTags,
    normalizeAiExplorationRatio,
    normalizeExplorationDiversityStrength,
    normalizeTagColor,
    rankTagMatches,
    resizeCamera,
    shouldAutoplayVideo,
    getViewportPanDelta,
    getViewportWorldCenter,
    insertExplorationRow,
    interpolateCamera,
    isPlayingVideo,
    selectDiverseExplorationRow,
    selectAiExplorationItems,
    selectRandomExplorationRow,
    shouldLoadUnratedRow,
    zoomCameraAtPoint,
    getNodeScreenCenter,
    reanchorCameraToNode,
  });
});
