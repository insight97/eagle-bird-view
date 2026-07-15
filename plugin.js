"use strict";

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 8;
const VIDEO_CONTROLS_HEIGHT = 14;
const LAYOUT_WIDTH = 1200;
const TARGET_ROW_HEIGHT = 180;
const MIN_ROW_HEIGHT = 140;
const MAX_ROW_HEIGHT = 220;
const LAYOUT_GAP = 14;
const KEYBOARD_PAN_STEP = 240;
const KEYBOARD_ZOOM_FACTOR = 1.5;
const ARROW_DIRECTIONS = {
  arrowup: [0, -1],
  arrowdown: [0, 1],
  arrowleft: [-1, 0],
  arrowright: [1, 0],
};
const WASD_TO_ARROW = { w: "arrowup", s: "arrowdown", a: "arrowleft", d: "arrowright" };
const KEYBOARD_SEEK_STEP = 5;
const KEYBOARD_VOLUME_STEP = 0.05;
const PAN_START_THRESHOLD = 4;
const ORIGINAL_IMAGE_ZOOM = 2;
const MAX_CONCURRENT_IMAGE_LOADS = 4;
const RESOURCE_RELEASE_VIEWPORTS = 3;

function directionFor(key) {
  return ARROW_DIRECTIONS[key] || ARROW_DIRECTIONS[WASD_TO_ARROW[key]];
}

const state = {
  camera: { x: 0, y: 0, scale: 1 },
  nodes: [],
  rows: [],
  mountedNodes: new Set(),
  materializedNodes: new Set(),
  mediaLoadQueue: [],
  activeMediaLoads: 0,
  mode: "free",
  selectedNode: null,
  toastTimer: null,
  cameraFrame: null,
  started: false,
  eagleReady: false,
};

const elements = {};

if (typeof eagle !== "undefined" && typeof eagle.onPluginCreate === "function") {
  eagle.onPluginCreate(() => {
    state.eagleReady = true;
    if (elements.viewport) startEagleIntegration();
  });
}

document.addEventListener("DOMContentLoaded", setup);

function setup() {
  elements.viewport = document.querySelector("#viewport");
  elements.world = document.querySelector("#world");
  elements.labels = document.querySelector("#labels");
  elements.emptyState = document.querySelector("#empty-state");
  elements.modeLabel = document.querySelector("#mode-label");
  elements.itemCount = document.querySelector("#item-count");
  elements.zoomLabel = document.querySelector("#zoom-label");
  elements.toast = document.querySelector("#toast");

  elements.viewport.addEventListener("pointerdown", beginPan);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", updateCamera);

  state.camera.scale = getBaseScale();
  updateModeMeta();
  updateCamera();
  if (
    typeof eagle === "undefined" ||
    typeof eagle.onPluginCreate !== "function" ||
    state.eagleReady
  ) {
    startEagleIntegration();
  }
}

function startEagleIntegration() {
  if (state.started) return;
  state.started = true;

  if (typeof eagle === "undefined") {
    showToast("請從 Eagle 的外掛開發者模式開啟 Bird View。", true);
    return;
  }

  loadSelectedItems();

  if (typeof eagle.onLibraryChanged === "function") {
    eagle.onLibraryChanged(() => {
      clearBoard();
      showToast("Eagle 資料庫已切換，請重新選取素材。", false);
    });
  }
}

async function loadSelectedItems() {
  if (typeof eagle === "undefined") {
    showToast("目前不在 Eagle 外掛環境中。", true);
    return;
  }

  try {
    const items = await eagle.item.getSelected();

    if (!items.length) {
      clearBoard();
      showToast("Eagle 目前沒有選取素材。", true);
      return;
    }

    renderItems(items);
    requestAnimationFrame(focusFirstItem);
    showToast(`已載入 ${items.length} 個素材。`);
  } catch (error) {
    console.error("Failed to load selected Eagle items", error);
    showToast(`無法讀取 Eagle 素材：${error.message || error}`, true);
  }
}

function renderItems(items) {
  exitSelectionMode();
  releaseAllMediaCards();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.mountedNodes.clear();
  const layout = createJustifiedLayout(items);
  state.nodes = layout.nodes;
  state.rows = layout.rows;

  state.nodes.forEach((node) => {
    node.label = createMediaLabel(node);
    elements.labels.append(node.label);
  });

  updateBoardMeta();
  updateLabels();
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

function mountMediaCard(node) {
  if (!node.element) {
    node.element = createMediaCard(node);
    positionNode(node);
    state.materializedNodes.add(node);
  }
  if (!node.element.isConnected) elements.world.append(node.element);
  state.mountedNodes.add(node);
}

function unmountMediaCard(node) {
  node.element?.remove();
  state.mountedNodes.delete(node);
}

function releaseMediaCard(node) {
  node.pendingMediaQuality = null;
  node.mediaLoadQueued = false;
  if (node.mediaLoading) finishMediaLoad(node);

  if (node.videoElement) {
    node.videoElement.pause();
    node.videoElement.removeAttribute("src");
    node.videoElement.load();
  }
  node.previewImage?.removeAttribute("src");
  node.element?.remove();
  state.mountedNodes.delete(node);
  state.materializedNodes.delete(node);

  node.element = null;
  node.frame = null;
  node.previewImage = null;
  node.playButton = null;
  node.startPlayback = null;
  node.videoElement = null;
  node.togglePlayback = null;
  node.mediaElement = null;
  node.loadMedia = null;
  node.startMediaLoad = null;
  node.mediaLoaded = false;
  node.mediaQuality = null;
  node.originalImageURL = null;
  node.fallbackURL = null;
  node.height = node.mediaHeight;
}

function releaseAllMediaCards() {
  for (const node of [...state.materializedNodes]) releaseMediaCard(node);
  state.mediaLoadQueue = [];
}

function createMediaCard(node) {
  const { item } = node;
  const extension = String(item.ext || "").toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const card = document.createElement("article");
  const frame = document.createElement("div");
  const image = document.createElement("img");

  card.className = "media-card";
  card.dataset.itemId = item.id;
  card.title = isVideo
    ? `${item.name || "未命名"}（雙擊播放或暫停）`
    : item.name || "未命名";
  frame.className = "media-frame";
  frame.style.height = `${node.mediaHeight}px`;
  const originalImageURL = !isVideo ? item.fileURL : null;
  const fallbackURL = item.thumbnailURL || item.fileURL;
  image.alt = item.name || "Eagle 素材";
  image.decoding = "async";
  image.draggable = false;
  image.style.visibility = "hidden";
  node.mediaElement = image;
  node.mediaLoaded = false;
  node.mediaQuality = null;
  node.originalImageURL = originalImageURL;
  node.fallbackURL = fallbackURL;
  node.loadMedia = (quality = "thumbnail") => queueMediaLoad(node, quality);
  node.startMediaLoad = () => {
    const quality = node.pendingMediaQuality || "thumbnail";
    node.pendingMediaQuality = null;
    node.mediaLoadQueued = false;
    node.mediaLoading = true;
    node.loadingQuality = quality;
    const mediaURL = quality === "original" ? originalImageURL : fallbackURL;
    if (!mediaURL) {
      finishMediaLoad(node);
      return;
    }
    image.src = mediaURL;
  };
  image.addEventListener("load", () => {
    node.mediaLoaded = true;
    node.mediaQuality = node.loadingQuality;
    image.style.visibility = "visible";
    applyMediaRotation(node);
    finishMediaLoad(node);
  });
  image.addEventListener("error", () => {
    if (node.loadingQuality === "original" && fallbackURL) {
      node.loadingQuality = "thumbnail";
      image.src = fallbackURL;
      return;
    }
    image.alt = "無法顯示縮圖";
    finishMediaLoad(node);
  });

  frame.append(image);
  card.append(frame);
  node.frame = frame;
  node.previewImage = image;

  if (isVideo) {
    const playButton = document.createElement("button");
    playButton.className = "play-button";
    playButton.type = "button";
    playButton.textContent = "▶";
    playButton.setAttribute("aria-label", `播放 ${item.name || "影片"}`);
    playButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    playButton.addEventListener("click", (event) => {
      event.stopPropagation();
      startVideo(frame, image, playButton, item, node);
    });
    node.playButton = playButton;
    node.startPlayback = () => startVideo(frame, image, playButton, item, node);
    frame.append(playButton);
  }

  card.addEventListener("dblclick", (event) => {
    if (!node.isVideo || event.target.closest("button, input")) return;
    event.preventDefault();
    if (node.togglePlayback) {
      node.togglePlayback();
    } else {
      node.startPlayback?.();
    }
  });

  return card;
}

function queueMediaLoad(node, requestedQuality) {
  const quality =
    requestedQuality === "original" && node.originalImageURL ? "original" : "thumbnail";
  if (node.mediaQuality === "original") return;
  if (node.mediaLoaded && node.mediaQuality === quality) return;
  if (
    node.pendingMediaQuality !== "original" ||
    quality === "original"
  ) {
    node.pendingMediaQuality = quality;
  }
  if (node.mediaLoading || node.mediaLoadQueued) return;

  node.mediaLoadQueued = true;
  state.mediaLoadQueue.push(node);
  pumpMediaLoadQueue();
}

function pumpMediaLoadQueue() {
  while (
    state.activeMediaLoads < MAX_CONCURRENT_IMAGE_LOADS &&
    state.mediaLoadQueue.length
  ) {
    const node = state.mediaLoadQueue.shift();
    if (!node?.startMediaLoad || !node.mediaLoadQueued) continue;
    state.activeMediaLoads += 1;
    node.startMediaLoad();
  }
}

function finishMediaLoad(node) {
  if (!node.mediaLoading) return;
  node.mediaLoading = false;
  node.loadingQuality = null;
  state.activeMediaLoads = Math.max(0, state.activeMediaLoads - 1);
  if (node.pendingMediaQuality) queueMediaLoad(node, node.pendingMediaQuality);
  pumpMediaLoadQueue();
}

function createMediaLabel(node) {
  const { item } = node;
  const label = document.createElement("div");
  const name = document.createElement("span");
  const type = document.createElement("span");
  const actions = document.createElement("span");
  const rotateLeft = document.createElement("button");
  const rotateRight = document.createElement("button");

  label.className = "media-label";
  name.className = "media-name";
  name.textContent = item.name || "未命名";
  type.className = "media-extension";
  type.textContent = String(item.ext || "FILE").toUpperCase();
  actions.className = "media-label-actions";
  rotateLeft.className = "media-rotate";
  rotateLeft.type = "button";
  rotateLeft.textContent = "↶";
  rotateLeft.title = "左鍵旋轉 90°，右鍵旋轉 45°";
  rotateLeft.setAttribute("aria-label", `將 ${item.name || "媒體"} 向左旋轉`);
  rotateRight.className = "media-rotate";
  rotateRight.type = "button";
  rotateRight.textContent = "↷";
  rotateRight.title = "左鍵旋轉 90°，右鍵旋轉 45°";
  rotateRight.setAttribute("aria-label", `將 ${item.name || "媒體"} 向右旋轉`);
  bindRotationButton(rotateLeft, node, -1);
  bindRotationButton(rotateRight, node, 1);
  actions.append(type, rotateLeft, rotateRight);
  label.append(name, actions);
  return label;
}

function bindRotationButton(button, node, direction) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    rotateMedia(node, direction * 90);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    rotateMedia(node, direction * 45);
  });
}

function rotateMedia(node, degrees) {
  node.rotation = (node.rotation + degrees + 360) % 360;
  applyMediaRotation(node);
}

function applyMediaRotation(node) {
  if (!node.mediaElement) return;
  if (node.rotation === 0) {
    node.mediaElement.style.transform = "none";
    return;
  }
  const frame = node.element?.querySelector(".media-frame");
  const frameWidth = frame?.clientWidth || node.width;
  const frameHeight = frame?.clientHeight || node.mediaHeight;
  const radians = (node.rotation * Math.PI) / 180;
  const rotatedWidth =
    Math.abs(frameWidth * Math.cos(radians)) +
    Math.abs(frameHeight * Math.sin(radians));
  const rotatedHeight =
    Math.abs(frameWidth * Math.sin(radians)) +
    Math.abs(frameHeight * Math.cos(radians));
  const fitScale = Math.min(frameWidth / rotatedWidth, frameHeight / rotatedHeight);
  node.mediaElement.style.transform = `rotate(${node.rotation}deg) scale(${fitScale})`;
}

function startVideo(frame, image, playButton, item, node) {
  if (node.videoElement) {
    node.togglePlayback?.();
    return;
  }
  const video = document.createElement("video");
  const controls = document.createElement("div");
  const toggleButton = document.createElement("button");
  const progress = document.createElement("input");
  const volumeControl = document.createElement("div");
  const volumeButton = document.createElement("button");
  const volumePopover = document.createElement("div");
  const volume = document.createElement("input");
  const volumeValue = document.createElement("span");

  video.src = item.fileURL;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "metadata";
  node.mediaElement = video;
  applyMediaRotation(node);
  controls.className = "video-controls";
  toggleButton.className = "video-toggle";
  toggleButton.type = "button";
  toggleButton.textContent = "❚❚";
  toggleButton.setAttribute("aria-label", "暫停");
  progress.className = "video-progress";
  progress.type = "range";
  progress.min = "0";
  progress.max = "1000";
  progress.value = "0";
  progress.setAttribute("aria-label", "影片播放進度");
  volumeControl.className = "volume-control";
  volumeButton.className = "volume-toggle";
  volumeButton.type = "button";
  volumeButton.textContent = "🔊";
  volumeButton.setAttribute("aria-label", "靜音");
  volumeButton.title = "靜音";
  volumePopover.className = "volume-popover";
  volume.className = "volume-slider";
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = String(video.volume);
  volume.setAttribute("aria-label", "音量");
  volumeValue.className = "volume-value";
  volumeValue.textContent = "100%";
  volumePopover.append(volume, volumeValue);
  volumeControl.append(volumeButton, volumePopover);

  controls.append(toggleButton, progress, volumeControl);
  let lastAudibleVolume = video.volume || 1;

  controls.addEventListener("dblclick", (event) => event.stopPropagation());

  const togglePlayback = () => {
    if (video.paused) {
      video.play().catch(() => showToast("無法播放這個影片。", true));
    } else {
      video.pause();
    }
  };
  node.videoElement = video;
  node.togglePlayback = togglePlayback;

  toggleButton.addEventListener("click", togglePlayback);
  video.addEventListener("play", () => {
    toggleButton.textContent = "❚❚";
    toggleButton.setAttribute("aria-label", "暫停");
  });
  video.addEventListener("pause", () => {
    toggleButton.textContent = "▶";
    toggleButton.setAttribute("aria-label", "播放");
  });
  video.addEventListener("timeupdate", () => {
    if (Number.isFinite(video.duration) && !progress.matches(":active")) {
      progress.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
  });
  progress.addEventListener("input", () => {
    if (Number.isFinite(video.duration)) {
      video.currentTime = (Number(progress.value) / 1000) * video.duration;
    }
  });
  volumeButton.addEventListener("click", () => {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = lastAudibleVolume;
      video.muted = false;
    } else {
      lastAudibleVolume = video.volume;
      video.muted = true;
    }
  });
  volume.addEventListener("input", () => {
    video.muted = false;
    video.volume = Number(volume.value);
    if (video.volume > 0) lastAudibleVolume = video.volume;
  });
  video.addEventListener("volumechange", () => {
    const audibleVolume = video.muted ? 0 : video.volume;
    const isMuted = audibleVolume === 0;
    volume.value = String(audibleVolume);
    volumeValue.textContent = `${Math.round(audibleVolume * 100)}%`;
    volumeButton.textContent = isMuted ? "🔇" : "🔊";
    volumeButton.setAttribute("aria-label", isMuted ? "取消靜音" : "靜音");
    volumeButton.title = isMuted ? "取消靜音" : "靜音";
  });
  video.addEventListener("error", () => {
    showToast("這個影片的容器或編碼無法由外掛播放器解碼。", true);
    video.remove();
    controls.remove();
    node.videoElement = null;
    node.togglePlayback = null;
    node.mediaElement = image;
    applyMediaRotation(node);
    frame.prepend(image);
    frame.append(playButton);
    node.height = node.mediaHeight;
    positionNode(node);
    updateLabels();
  });

  image.remove();
  playButton.remove();
  frame.prepend(video);
  frame.after(controls);
  node.height = node.mediaHeight + VIDEO_CONTROLS_HEIGHT;
  positionNode(node);
  updateLabels();
  video.play().catch(() => {
    showToast("瀏覽器阻擋自動播放，請按影片上的播放鍵。", false);
  });
}

function beginPan(event) {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.target.closest("button, input")) return;

  const startPointer = { x: event.clientX, y: event.clientY };
  const startCamera = { ...state.camera };
  let isPanning = event.button === 1;
  if (isPanning) {
    event.preventDefault();
    elements.viewport.classList.add("is-panning");
  }

  const move = (moveEvent) => {
    const deltaX = moveEvent.clientX - startPointer.x;
    const deltaY = moveEvent.clientY - startPointer.y;
    if (!isPanning && Math.hypot(deltaX, deltaY) < PAN_START_THRESHOLD) return;
    if (!isPanning) {
      isPanning = true;
      elements.viewport.classList.add("is-panning");
    }
    moveEvent.preventDefault();
    state.camera.x = startCamera.x + moveEvent.clientX - startPointer.x;
    state.camera.y = startCamera.y + moveEvent.clientY - startPointer.y;
    updateCamera();
  };

  const end = () => {
    elements.viewport.classList.remove("is-panning");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function handleWheel(event) {
  event.preventDefault();
  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  zoomAtPoint(pointerX, pointerY, zoomFactor);
}

function handleKeyDown(event) {
  if (state.mode === "selection" && (event.key === "Shift" || event.key === "Escape")) {
    event.preventDefault();
    exitSelectionMode();
    return;
  }

  if (
    state.mode === "selection" &&
    event.ctrlKey &&
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  ) {
    event.preventDefault();
    controlSelectedVideo(event.key);
    return;
  }

  if (isInteractiveTarget(event.target)) return;

  if (event.key === "Enter") {
    event.preventDefault();
    if (event.repeat) return;
    if (state.mode === "free") {
      enterSelectionMode();
    } else {
      activateSelectedNode();
    }
    return;
  }

  if (event.ctrlKey && (event.key === "PageUp" || event.key === "PageDown")) {
    event.preventDefault();
    const factor = event.key === "PageUp" ? KEYBOARD_ZOOM_FACTOR : 1 / KEYBOARD_ZOOM_FACTOR;
    zoomAtPoint(
      elements.viewport.clientWidth / 2,
      elements.viewport.clientHeight / 2,
      factor,
    );
    return;
  }

  if (state.mode === "free" && event.ctrlKey && ARROW_DIRECTIONS[event.key.toLowerCase()]) {
    event.preventDefault();
    panOneViewport(event.key);
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  const direction = directionFor(key);

  if (state.mode === "selection" && direction) {
    event.preventDefault();
    selectDirectionalNode(direction[0], direction[1]);
    return;
  }

  if (!direction) return;
  event.preventDefault();
  panBy(direction[0] * -KEYBOARD_PAN_STEP, direction[1] * -KEYBOARD_PAN_STEP);
}

function panBy(dx, dy) {
  state.camera.x += dx;
  state.camera.y += dy;
  updateCamera();
}

function panOneViewport(key) {
  const direction = ARROW_DIRECTIONS[key.toLowerCase()];
  if (!direction) return;
  const magnitude = direction[0] !== 0 ? elements.viewport.clientWidth : elements.viewport.clientHeight;
  panBy(direction[0] * -magnitude, direction[1] * -magnitude);
}

function enterSelectionMode() {
  if (!state.nodes.length) return;
  const viewportCenter = {
    x: (elements.viewport.clientWidth / 2 - state.camera.x) / state.camera.scale,
    y: (elements.viewport.clientHeight / 2 - state.camera.y) / state.camera.scale,
  };
  const closestNode = state.nodes.reduce((closest, node) => {
    const center = getNodeCenter(node);
    const distance = (center.x - viewportCenter.x) ** 2 + (center.y - viewportCenter.y) ** 2;
    return !closest || distance < closest.distance ? { node, distance } : closest;
  }, null)?.node;

  if (!closestNode) return;
  state.mode = "selection";
  setSelectedNode(closestNode);
  centerNode(closestNode);
  updateModeMeta();
}

function exitSelectionMode() {
  state.selectedNode?.element?.classList.remove("is-selected");
  state.selectedNode?.label?.classList.remove("is-selected");
  state.selectedNode = null;
  state.mode = "free";
  updateModeMeta();
}

function setSelectedNode(node) {
  if (!node || node === state.selectedNode) return;
  state.selectedNode?.element?.classList.remove("is-selected");
  state.selectedNode?.label?.classList.remove("is-selected");
  state.selectedNode = node;
  mountMediaCard(node);
  node.element.classList.add("is-selected");
  node.label.classList.add("is-selected");
  node.loadMedia("original");
}

function selectDirectionalNode(directionX, directionY) {
  const current = state.selectedNode;
  if (!current) return;
  const currentCenter = getNodeCenter(current);
  let bestMatch = null;

  for (const node of state.nodes) {
    if (node === current) continue;
    const overlapsNavigationAxis = directionX
      ? rangesOverlap(current.y, current.y + current.height, node.y, node.y + node.height)
      : rangesOverlap(current.x, current.x + current.width, node.x, node.x + node.width);
    if (!overlapsNavigationAxis) continue;
    const center = getNodeCenter(node);
    const deltaX = center.x - currentCenter.x;
    const deltaY = center.y - currentCenter.y;
    const forwardDistance = deltaX * directionX + deltaY * directionY;
    if (forwardDistance <= 0) continue;
    const crossDistance = Math.abs(deltaX * directionY - deltaY * directionX);
    const distance = Math.hypot(deltaX, deltaY);
    const anglePenalty = crossDistance / forwardDistance;
    const score = anglePenalty * LAYOUT_WIDTH * 4 + distance;

    if (!bestMatch || score < bestMatch.score) bestMatch = { node, score };
  }

  if (!bestMatch) return;
  setSelectedNode(bestMatch.node);
  centerNode(bestMatch.node);
}

function rangesOverlap(startA, endA, startB, endB) {
  return Math.min(endA, endB) > Math.max(startA, startB);
}

function activateSelectedNode() {
  const node = state.selectedNode;
  if (!node?.isVideo) return;
  if (node.togglePlayback) {
    node.togglePlayback();
  } else {
    node.startPlayback?.();
  }
  centerNode(node);
}

function controlSelectedVideo(key) {
  const video = state.selectedNode?.videoElement;
  if (!video) return;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!Number.isFinite(video.duration)) return;
    const direction = key === "ArrowRight" ? 1 : -1;
    video.currentTime = clamp(
      video.currentTime + direction * KEYBOARD_SEEK_STEP,
      0,
      video.duration,
    );
    return;
  }

  const direction = key === "ArrowUp" ? 1 : -1;
  video.muted = false;
  video.volume = clamp(
    video.volume + direction * KEYBOARD_VOLUME_STEP,
    0,
    1,
  );
}

function centerNode(node) {
  const center = getNodeCenter(node);
  state.camera.x = elements.viewport.clientWidth / 2 - center.x * state.camera.scale;
  state.camera.y = elements.viewport.clientHeight / 2 - center.y * state.camera.scale;
  updateCamera();
}

function getNodeCenter(node) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function updateModeMeta() {
  if (!elements.modeLabel) return;
  const isSelection = state.mode === "selection";
  elements.modeLabel.textContent = isSelection ? "選取模式" : "自由模式";
  elements.modeLabel.classList.toggle("is-selection", isSelection);
  elements.viewport?.classList.toggle("is-selection-mode", isSelection);
}

function zoomAtPoint(pointerX, pointerY, factor) {
  const worldX = (pointerX - state.camera.x) / state.camera.scale;
  const worldY = (pointerY - state.camera.y) / state.camera.scale;
  const baseScale = getBaseScale();
  const nextScale = clamp(
    state.camera.scale * factor,
    baseScale * MIN_ZOOM,
    baseScale * MAX_ZOOM,
  );

  state.camera.scale = nextScale;
  state.camera.x = pointerX - worldX * nextScale;
  state.camera.y = pointerY - worldY * nextScale;
  updateCamera();
}

function isInteractiveTarget(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function focusFirstItem() {
  const node = state.nodes[0];
  if (!node) return;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scale = getBaseScale();
  const displayHeight = node.mediaHeight + (node.isVideo ? VIDEO_CONTROLS_HEIGHT : 0);

  state.camera.scale = scale;
  state.camera.x = viewportWidth / 2 - (node.x + node.width / 2) * scale;
  state.camera.y = viewportHeight / 2 - (node.y + displayHeight / 2) * scale;
  updateCamera();
}

function clearBoard() {
  exitSelectionMode();
  releaseAllMediaCards();
  state.nodes = [];
  state.rows = [];
  state.mountedNodes.clear();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.camera = { x: 0, y: 0, scale: getBaseScale() };
  updateCamera();
  updateBoardMeta();
}

function updateBoardMeta() {
  const count = state.nodes.length;
  elements.itemCount.textContent = `${count} 個素材`;
  elements.emptyState.hidden = count > 0;
}

function updateCamera() {
  if (state.cameraFrame !== null) return;
  state.cameraFrame = requestAnimationFrame(renderCamera);
}

function renderCamera() {
  state.cameraFrame = null;
  elements.world.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.scale})`;
  elements.zoomLabel.textContent = `${Math.round((state.camera.scale / getBaseScale()) * 100)}%`;
  elements.viewport.style.backgroundPosition = `${state.camera.x}px ${state.camera.y}px`;
  const gridSize = Math.max(8, 24 * state.camera.scale);
  elements.viewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
  updateLabels();
  updateMediaVisibility();
}

function updateMediaVisibility() {
  const preloadMargin = 120;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scale = state.camera.scale;
  const mountMargin = Math.max(viewportWidth, viewportHeight);
  const visibleNodes = getNodesNearViewport(mountMargin);
  const nextMountedNodes = new Set(visibleNodes);
  const retainedNodes = new Set(
    getNodesNearViewport(mountMargin * RESOURCE_RELEASE_VIEWPORTS),
  );
  const zoom = scale / getBaseScale();

  for (const node of state.mountedNodes) {
    if (!nextMountedNodes.has(node) && node !== state.selectedNode) {
      unmountMediaCard(node);
    }
  }

  for (const node of visibleNodes) mountMediaCard(node);

  for (const node of [...state.materializedNodes]) {
    if (!retainedNodes.has(node) && node !== state.selectedNode) {
      releaseMediaCard(node);
    }
  }

  for (const node of visibleNodes) {
    const left = state.camera.x + node.x * scale;
    const top = state.camera.y + node.y * scale;
    const right = left + node.width * scale;
    const bottom = top + node.mediaHeight * scale;
    const isNearViewport =
      right >= -preloadMargin &&
      left <= viewportWidth + preloadMargin &&
      bottom >= -preloadMargin &&
      top <= viewportHeight + preloadMargin;

    if (isNearViewport) {
      const quality =
        !node.isVideo && (node === state.selectedNode || zoom >= ORIGINAL_IMAGE_ZOOM)
          ? "original"
          : "thumbnail";
      node.loadMedia(quality);
    }
  }
}

function getNodesNearViewport(screenMargin) {
  if (!state.rows.length) return [];
  const scale = state.camera.scale;
  const left = (-state.camera.x - screenMargin) / scale;
  const top = (-state.camera.y - screenMargin) / scale;
  const right = (elements.viewport.clientWidth - state.camera.x + screenMargin) / scale;
  const bottom = (elements.viewport.clientHeight - state.camera.y + screenMargin) / scale;
  let low = 0;
  let high = state.rows.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (state.rows[middle].bottom < top) low = middle + 1;
    else high = middle;
  }

  const nodes = [];
  for (let index = low; index < state.rows.length; index += 1) {
    const row = state.rows[index];
    if (row.top > bottom) break;
    for (const node of row.nodes) {
      if (node.x + node.width >= left && node.x <= right) nodes.push(node);
    }
  }
  return nodes;
}

function updateLabels() {
  if (!elements.labels) return;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scale = state.camera.scale;
  const zoom = scale / getBaseScale();

  for (const node of state.nodes) {
    const left = Math.round(state.camera.x + node.x * scale);
    const top = Math.round(state.camera.y + node.y * scale - 27);
    const width = Math.round(node.width * scale);
    const isVisible =
      zoom >= 0.28 &&
      left + width >= 0 &&
      left <= viewportWidth &&
      top + 22 >= 0 &&
      top <= viewportHeight;

    node.label.hidden = !isVisible;
    if (!isVisible) continue;
    node.label.style.left = `${left}px`;
    node.label.style.top = `${top}px`;
    node.label.style.width = `${Math.max(100, width)}px`;
  }
}

function positionNode(node) {
  if (!node.element) return;
  node.element.style.width = `${node.width}px`;
  node.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
}

function getBaseScale() {
  const padding = 64;
  const viewportWidth = Math.max(elements.viewport?.clientWidth || 0, 1);
  const viewportHeight = Math.max(elements.viewport?.clientHeight || 0, 1);
  const referenceHeight = state.nodes.length
    ? state.nodes[0].mediaHeight +
      (state.nodes[0].isVideo ? VIDEO_CONTROLS_HEIGHT : 0)
    : TARGET_ROW_HEIGHT + VIDEO_CONTROLS_HEIGHT;
  const referenceWidth = state.nodes[0]?.width || TARGET_ROW_HEIGHT * (16 / 10);
  const widthScale = (viewportWidth - padding * 2) / referenceWidth;
  const heightScale = (viewportHeight - padding * 2) / referenceHeight;
  return Math.max(0.01, Math.min(widthScale, heightScale));
}

function screenToWorld(clientX, clientY) {
  const rect = elements.viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.camera.x) / state.camera.scale,
    y: (clientY - rect.top - state.camera.y) / state.camera.scale,
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

function showToast(message, isError = false) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 3200);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
