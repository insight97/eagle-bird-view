"use strict";

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm"]);
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 8;
const CARD_WIDTH = 280;
const VIDEO_CONTROLS_HEIGHT = 24;
const CARD_MAX_MEDIA_HEIGHT = 230;
const CARD_MIN_MEDIA_HEIGHT = 150;
const CARD_GAP = 32;

const state = {
  camera: { x: 0, y: 0, scale: 1 },
  nodes: [],
  toastTimer: null,
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
  elements.reloadButton = document.querySelector("#reload-button");
  elements.fitButton = document.querySelector("#fit-button");
  elements.resetButton = document.querySelector("#reset-button");
  elements.itemCount = document.querySelector("#item-count");
  elements.zoomLabel = document.querySelector("#zoom-label");
  elements.toast = document.querySelector("#toast");

  elements.reloadButton.addEventListener("click", loadSelectedItems);
  elements.fitButton.addEventListener("click", fitAll);
  elements.resetButton.addEventListener("click", resetZoom);
  elements.viewport.addEventListener("pointerdown", beginPan);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", updateCamera);

  state.camera.scale = getBaseScale();
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

  elements.reloadButton.disabled = true;
  elements.reloadButton.textContent = "載入中…";

  try {
    const items = await eagle.item.getSelected();

    if (!items.length) {
      clearBoard();
      showToast("Eagle 目前沒有選取素材。", true);
      return;
    }

    renderItems(items);
    requestAnimationFrame(fitAll);
    showToast(`已載入 ${items.length} 個素材。`);
  } catch (error) {
    console.error("Failed to load selected Eagle items", error);
    showToast(`無法讀取 Eagle 素材：${error.message || error}`, true);
  } finally {
    elements.reloadButton.disabled = false;
    elements.reloadButton.textContent = "載入目前選取";
  }
}

function renderItems(items) {
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.nodes = [];

  const viewportWidth = Math.max(elements.viewport.clientWidth, 720);
  const columns = Math.max(1, Math.min(5, Math.floor(viewportWidth / (CARD_WIDTH + CARD_GAP))));

  items.forEach((item, index) => {
    const aspectRatio = getAspectRatio(item);
    const mediaHeight = clamp(CARD_WIDTH / aspectRatio, CARD_MIN_MEDIA_HEIGHT, CARD_MAX_MEDIA_HEIGHT);
    const isVideo = VIDEO_EXTENSIONS.has(String(item.ext || "").toLowerCase());
    const row = Math.floor(index / columns);
    const column = index % columns;
    const node = {
      item,
      x: column * (CARD_WIDTH + CARD_GAP),
      y: row * (CARD_MAX_MEDIA_HEIGHT + VIDEO_CONTROLS_HEIGHT + CARD_GAP),
      width: CARD_WIDTH,
      height: mediaHeight,
      mediaHeight,
      isVideo,
      rotation: 0,
    };

    node.element = createMediaCard(node);
    node.label = createMediaLabel(node);
    state.nodes.push(node);
    elements.world.append(node.element);
    elements.labels.append(node.label);
    positionNode(node);
  });

  updateBoardMeta();
  updateLabels();
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
  card.title = `${item.name || "未命名"}（雙擊在 Eagle 開啟）`;
  frame.className = "media-frame";
  frame.style.height = `${node.mediaHeight}px`;
  image.src = item.thumbnailURL || item.fileURL;
  image.alt = item.name || "Eagle 素材";
  image.loading = "lazy";
  image.draggable = false;
  node.mediaElement = image;
  image.addEventListener("error", () => {
    image.alt = "無法顯示縮圖";
  });

  frame.append(image);
  card.append(frame);

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
    frame.append(playButton);
  }

  card.addEventListener("dblclick", (event) => {
    if (event.target.closest("video, button")) return;
    openInEagle(item);
  });

  return card;
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
  rotateLeft.title = "向左旋轉 90°";
  rotateLeft.setAttribute("aria-label", `將 ${item.name || "媒體"} 向左旋轉 90 度`);
  rotateRight.className = "media-rotate";
  rotateRight.type = "button";
  rotateRight.textContent = "↷";
  rotateRight.title = "向右旋轉 90°";
  rotateRight.setAttribute("aria-label", `將 ${item.name || "媒體"} 向右旋轉 90 度`);
  rotateLeft.addEventListener("click", () => rotateMedia(node, -90));
  rotateRight.addEventListener("click", () => rotateMedia(node, 90));
  actions.append(type, rotateLeft, rotateRight);
  label.append(name, actions);
  return label;
}

function rotateMedia(node, degrees) {
  node.rotation = (node.rotation + degrees + 360) % 360;
  applyMediaRotation(node);
}

function applyMediaRotation(node) {
  if (!node.mediaElement) return;
  const isQuarterTurn = node.rotation % 180 !== 0;
  const fitScale = isQuarterTurn
    ? Math.min(node.width / node.mediaHeight, node.mediaHeight / node.width)
    : 1;
  node.mediaElement.style.transform = `rotate(${node.rotation}deg) scale(${fitScale})`;
}

function startVideo(frame, image, playButton, item, node) {
  const video = document.createElement("video");
  const controls = document.createElement("div");
  const toggleButton = document.createElement("button");
  const progress = document.createElement("input");
  const volumeButton = document.createElement("button");
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
  volumeButton.className = "volume-toggle";
  volumeButton.type = "button";
  volumeButton.textContent = "🔊";
  volumeButton.setAttribute("aria-label", "靜音");
  volume.className = "volume-slider";
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = String(video.volume);
  volume.setAttribute("aria-label", "音量");
  volumeValue.className = "volume-value";
  volumeValue.textContent = "100%";

  controls.append(toggleButton, progress, volumeButton, volume, volumeValue);

  controls.addEventListener("dblclick", (event) => event.stopPropagation());

  const togglePlayback = () => {
    if (video.paused) {
      video.play().catch(() => showToast("無法播放這個影片。", true));
    } else {
      video.pause();
    }
  };

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
    video.muted = !video.muted;
  });
  volume.addEventListener("input", () => {
    video.muted = false;
    video.volume = Number(volume.value);
  });
  video.addEventListener("volumechange", () => {
    const audibleVolume = video.muted ? 0 : video.volume;
    volume.value = String(audibleVolume);
    volumeValue.textContent = `${Math.round(audibleVolume * 100)}%`;
    volumeButton.textContent = audibleVolume === 0 ? "🔇" : audibleVolume < 0.5 ? "🔉" : "🔊";
    volumeButton.setAttribute("aria-label", video.muted ? "取消靜音" : "靜音");
  });
  video.addEventListener("error", () => {
    showToast("這個 MP4 的編碼無法由外掛播放器解碼，可雙擊卡片回到 Eagle。", true);
    video.remove();
    controls.remove();
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

async function openInEagle(item) {
  try {
    await eagle.item.open(item.id, { window: true });
  } catch (error) {
    console.error("Failed to open item in Eagle", error);
    showToast("無法在 Eagle 開啟這個素材。", true);
  }
}

function beginPan(event) {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.target.closest("button, input")) return;

  event.preventDefault();
  const startPointer = { x: event.clientX, y: event.clientY };
  const startCamera = { ...state.camera };
  elements.viewport.classList.add("is-panning");
  elements.viewport.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    state.camera.x = startCamera.x + moveEvent.clientX - startPointer.x;
    state.camera.y = startCamera.y + moveEvent.clientY - startPointer.y;
    updateCamera();
  };

  const end = () => {
    elements.viewport.classList.remove("is-panning");
    elements.viewport.removeEventListener("pointermove", move);
    elements.viewport.removeEventListener("pointerup", end);
    elements.viewport.removeEventListener("pointercancel", end);
  };

  elements.viewport.addEventListener("pointermove", move);
  elements.viewport.addEventListener("pointerup", end);
  elements.viewport.addEventListener("pointercancel", end);
}

function handleWheel(event) {
  event.preventDefault();
  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const worldX = (pointerX - state.camera.x) / state.camera.scale;
  const worldY = (pointerY - state.camera.y) / state.camera.scale;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  const baseScale = getBaseScale();
  const nextScale = clamp(
    state.camera.scale * zoomFactor,
    baseScale * MIN_ZOOM,
    baseScale * MAX_ZOOM,
  );

  state.camera.scale = nextScale;
  state.camera.x = pointerX - worldX * nextScale;
  state.camera.y = pointerY - worldY * nextScale;
  updateCamera();
}

function fitAll() {
  if (!state.nodes.length) return;
  const bounds = getNodeBounds();
  const padding = 64;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scaleX = (viewportWidth - padding * 2) / Math.max(bounds.width, 1);
  const scaleY = (viewportHeight - padding * 2) / Math.max(bounds.height, 1);
  const baseScale = getBaseScale();
  const scale = clamp(
    Math.min(scaleX, scaleY),
    baseScale * MIN_ZOOM,
    baseScale * MAX_ZOOM,
  );

  state.camera.scale = scale;
  state.camera.x = (viewportWidth - bounds.width * scale) / 2 - bounds.left * scale;
  state.camera.y = (viewportHeight - bounds.height * scale) / 2 - bounds.top * scale;
  updateCamera();
}

function resetZoom() {
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const center = screenToWorld(
    elements.viewport.getBoundingClientRect().left + viewportWidth / 2,
    elements.viewport.getBoundingClientRect().top + viewportHeight / 2,
  );

  state.camera.scale = getBaseScale();
  state.camera.x = viewportWidth / 2 - center.x * state.camera.scale;
  state.camera.y = viewportHeight / 2 - center.y * state.camera.scale;
  updateCamera();
}

function clearBoard() {
  state.nodes = [];
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
  elements.world.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.scale})`;
  elements.zoomLabel.textContent = `${Math.round((state.camera.scale / getBaseScale()) * 100)}%`;
  elements.viewport.style.backgroundPosition = `${state.camera.x}px ${state.camera.y}px`;
  const gridSize = Math.max(8, 24 * state.camera.scale);
  elements.viewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
  updateLabels();
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
  node.element.style.width = `${node.width}px`;
  node.element.style.height = `${node.height}px`;
  node.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
}

function getNodeBounds() {
  const left = Math.min(...state.nodes.map((node) => node.x));
  const top = Math.min(...state.nodes.map((node) => node.y));
  const right = Math.max(...state.nodes.map((node) => node.x + node.width));
  const bottom = Math.max(
    ...state.nodes.map(
      (node) =>
        node.y + node.mediaHeight + (node.isVideo ? VIDEO_CONTROLS_HEIGHT : 0),
    ),
  );
  return { left, top, width: right - left, height: bottom - top };
}

function getBaseScale() {
  const padding = 64;
  const viewportWidth = Math.max(elements.viewport?.clientWidth || 0, 1);
  const viewportHeight = Math.max(elements.viewport?.clientHeight || 0, 1);
  const referenceHeight = state.nodes.length
    ? Math.max(
        ...state.nodes.map(
          (node) => node.mediaHeight + (node.isVideo ? VIDEO_CONTROLS_HEIGHT : 0),
        ),
      )
    : CARD_MAX_MEDIA_HEIGHT + VIDEO_CONTROLS_HEIGHT;
  const widthScale = (viewportWidth - padding * 2) / CARD_WIDTH;
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
