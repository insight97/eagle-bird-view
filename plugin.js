"use strict";

const {
  TARGET_ROW_HEIGHT,
  VIDEO_CONTROLS_HEIGHT,
  VIDEO_EXTENSIONS,
  clamp,
  createJustifiedLayout,
  directionFor,
  findNearestNodeInRows,
  findNodesNearViewport,
  getItemRating,
  getNextRating,
  getLabelDetailLevel,
  getLabelRect,
  getPanLayerTranslation,
  getWrappedGridTranslation,
  getViewportWorkInterval,
  getTagColorStyle,
  getViewportPanDelta,
  getViewportWorldCenter,
  insertExplorationRow,
  isPlayingVideo,
  normalizeTags,
  normalizeTagColor,
  selectDiverseExplorationRow,
  zoomCameraAtPoint,
} = BirdViewCore;
const { MediaLoadQueue } = BirdViewMedia;
const { RelatedItemSource } = BirdViewExploration;
const { startVideoPlayer } = BirdViewVideo;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 8;
const KEYBOARD_PAN_STEP = 240;
const VIEWPORT_PAN_FRACTION = 2 / 3;
const KEYBOARD_ZOOM_FACTOR = 1.5;
const KEYBOARD_SEEK_STEP = 5;
const KEYBOARD_VOLUME_STEP = 0.05;
const PAN_START_THRESHOLD = 4;
const ORIGINAL_IMAGE_ZOOM = 1;
const MAX_CONCURRENT_IMAGE_LOADS = 4;
const RESOURCE_RELEASE_VIEWPORTS = 3;
const GRID_LAYER_OVERFLOW = 768;

const state = {
  camera: { x: 0, y: 0, scale: 1 },
  baseScale: 1,
  renderedScale: null,
  renderedBaseScale: null,
  gridSize: 24,
  nodes: [],
  rows: [],
  mountedNodes: new Set(),
  materializedNodes: new Set(),
  mountedLabelNodes: new Set(),
  labelCamera: null,
  selectedNode: null,
  toastTimer: null,
  cameraFrame: null,
  viewportWorkTimer: null,
  lastViewportWork: -Infinity,
  isPanning: false,
  explorationSource: null,
  explorationLoading: false,
  tagColors: new Map(),
  tagColorGeneration: 0,
  tagEditor: null,
  started: false,
  eagleReady: false,
};

const elements = {};
const mediaLoadQueue = new MediaLoadQueue({ maxConcurrent: MAX_CONCURRENT_IMAGE_LOADS });

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
  elements.grid = document.querySelector("#grid");
  elements.labels = document.querySelector("#labels");
  elements.emptyState = document.querySelector("#empty-state");
  elements.itemCount = document.querySelector("#item-count");
  elements.zoomLabel = document.querySelector("#zoom-label");
  elements.exploreButton = document.querySelector("#explore-button");
  elements.toast = document.querySelector("#toast");

  elements.viewport.addEventListener("pointerdown", beginPan);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", handleResize);
  elements.exploreButton.addEventListener("click", exploreNextRow);

  refreshBaseScale();
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

  state.explorationSource = new RelatedItemSource(eagle.item);
  updateExploreButton();
  loadTagColors();
  loadSelectedItems();

  if (typeof eagle.onLibraryChanged === "function") {
    eagle.onLibraryChanged(() => {
      clearBoard();
      state.explorationSource.clear();
      loadTagColors();
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
  clearSelection();
  releaseAllMediaCards();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";
  state.mountedNodes.clear();
  const layout = createJustifiedLayout(items);
  state.nodes = layout.nodes;
  state.rows = layout.rows;
  refreshBaseScale();

  updateBoardMeta();
  updateLabels();
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
  node.videoElement?.pause();
  node.element?.remove();
  state.mountedNodes.delete(node);
}

function releaseMediaCard(node) {
  node.mediaGeneration = (node.mediaGeneration || 0) + 1;
  mediaLoadQueue.dispose(node);

  if (node.videoElement) {
    node.videoElement.pause();
    node.videoElement.removeAttribute("src");
    node.videoElement.load();
  }
  node.preloadImage?.removeAttribute("src");
  node.previewImage?.removeAttribute("src");
  node.element?.remove();
  state.mountedNodes.delete(node);
  state.materializedNodes.delete(node);

  node.element = null;
  node.previewImage = null;
  node.preloadImage = null;
  node.startPlayback = null;
  node.videoElement = null;
  node.togglePlayback = null;
  node.mediaElement = null;
  node.loadMedia = null;
  node.height = node.mediaHeight;
}

function releaseAllMediaCards() {
  for (const node of [...state.materializedNodes]) releaseMediaCard(node);
}

function createMediaCard(node) {
  const { item } = node;
  const extension = String(item.ext || "").toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const card = document.createElement("article");
  const frame = document.createElement("div");
  const image = document.createElement("img");
  const mediaGeneration = (node.mediaGeneration || 0) + 1;
  node.mediaGeneration = mediaGeneration;

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
  node.loadMedia = (quality = "thumbnail") => mediaLoadQueue.request(node, quality);
  mediaLoadQueue.register(node, {
    hasOriginal: Boolean(originalImageURL),
    hasThumbnail: Boolean(fallbackURL),
    preferThumbnailFirst: Boolean(
      originalImageURL && fallbackURL && originalImageURL !== fallbackURL,
    ),
    cancel: (quality) => {
      if (quality !== "original" || !node.preloadImage) return;
      const originalImage = node.preloadImage;
      node.preloadImage = null;
      originalImage.removeAttribute("src");
    },
    start: (quality) => {
      const mediaURL = quality === "original" ? originalImageURL : fallbackURL;
      if (!mediaURL) {
        mediaLoadQueue.complete(node, quality, false);
        return;
      }
      if (quality === "original") {
        const originalImage = document.createElement("img");
        originalImage.alt = image.alt;
        originalImage.decoding = "async";
        originalImage.draggable = false;
        node.preloadImage = originalImage;
        originalImage.addEventListener("load", async () => {
          try {
            await originalImage.decode();
          } catch {
            // A completed load is still safe to reveal when decode() is unavailable.
          }
          if (
            node.mediaGeneration !== mediaGeneration ||
            node.preloadImage !== originalImage ||
            mediaLoadQueue.snapshot(node)?.loadingQuality !== "original"
          ) {
            return;
          }
          const previousImage = node.previewImage;
          originalImage.style.visibility = "visible";
          previousImage?.replaceWith(originalImage);
          node.previewImage = originalImage;
          node.preloadImage = null;
          if (node.mediaElement === previousImage) node.mediaElement = originalImage;
          applyMediaRotation(node);
          mediaLoadQueue.complete(node, "original", true);
        });
        originalImage.addEventListener("error", () => {
          if (
            node.mediaGeneration !== mediaGeneration ||
            node.preloadImage !== originalImage
          ) {
            return;
          }
          node.preloadImage = null;
          mediaLoadQueue.complete(node, "original", false);
        });
        originalImage.src = mediaURL;
        return;
      }
      image.src = mediaURL;
    },
  });
  image.addEventListener("load", () => {
    if (
      node.mediaGeneration !== mediaGeneration ||
      mediaLoadQueue.snapshot(node)?.loadingQuality !== "thumbnail"
    ) {
      return;
    }
    image.style.visibility = "visible";
    applyMediaRotation(node);
    mediaLoadQueue.complete(node, "thumbnail", true);
  });
  image.addEventListener("error", () => {
    if (
      node.mediaGeneration !== mediaGeneration ||
      mediaLoadQueue.snapshot(node)?.loadingQuality !== "thumbnail"
    ) {
      return;
    }
    image.alt = "無法顯示縮圖";
    mediaLoadQueue.complete(node, "thumbnail", false);
  });

  frame.append(image);
  card.append(frame);
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

function createMediaLabel(node) {
  const { item } = node;
  const label = document.createElement("div");
  const main = document.createElement("div");
  const metadata = document.createElement("div");
  const rating = document.createElement("span");
  const tags = document.createElement("span");
  const editTags = document.createElement("button");
  const name = document.createElement("span");
  const type = document.createElement("span");
  const actions = document.createElement("span");
  const rotateLeft = document.createElement("button");
  const rotateRight = document.createElement("button");

  label.className = "media-label";
  main.className = "media-label-main";
  metadata.className = "media-metadata";
  rating.className = "media-rating";
  tags.className = "media-tags";
  editTags.className = "media-tag-edit";
  editTags.type = "button";
  editTags.textContent = "+";
  editTags.title = "新增或移除標籤";
  editTags.setAttribute("aria-label", `編輯 ${item.name || "素材"} 的標籤`);
  editTags.dataset.editControl = "true";
  createRatingControls(rating, node);
  renderTagChips(tags, item.tags);
  editTags.addEventListener("pointerdown", (event) => event.stopPropagation());
  editTags.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!node.isSaving) openTagEditor(node, editTags);
  });
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
  metadata.append(rating, tags, editTags);
  main.append(name, actions);
  label.append(main, metadata);
  return label;
}

function createRatingControls(rating, node) {
  const currentRating = getItemRating(node.item);
  rating.setAttribute("aria-label", `評分 ${currentRating} 顆星`);
  for (let index = 1; index <= 5; index += 1) {
    const star = document.createElement("button");
    star.className = "media-rating-star";
    star.type = "button";
    star.textContent = "★";
    star.title = `${index} 顆星${index === currentRating ? "（再次點擊可清除）" : ""}`;
    star.setAttribute("aria-label", `設定為 ${index} 顆星`);
    star.dataset.editControl = "true";
    star.addEventListener("pointerdown", (event) => event.stopPropagation());
    star.addEventListener("pointerenter", () => paintRating(rating, index));
    star.addEventListener("pointerleave", () => paintRating(rating, getItemRating(node.item)));
    star.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (node.isSaving) return;
      setSelectedNode(node);
      const previousRating = getItemRating(node.item);
      node.item.star = getNextRating(previousRating, index);
      updateRatingControl(rating, node);
      await saveItemMetadata(node, {
        successMessage: node.item.star
          ? `已將「${node.item.name || "素材"}」設為 ${node.item.star} 顆星。`
          : `已清除「${node.item.name || "素材"}」的評分。`,
        rollback: () => {
          node.item.star = previousRating;
          updateRatingControl(rating, node);
        },
      });
    });
    rating.append(star);
  }
  paintRating(rating, currentRating);
}

function paintRating(rating, value) {
  for (const [index, star] of [...rating.children].entries()) {
    star.classList.toggle("is-filled", index < value);
  }
}

function updateRatingControl(rating, node) {
  const value = getItemRating(node.item);
  rating.setAttribute("aria-label", `評分 ${value} 顆星`);
  for (const [index, star] of [...rating.children].entries()) {
    const starValue = index + 1;
    star.title = `${starValue} 顆星${starValue === value ? "（再次點擊可清除）" : ""}`;
  }
  paintRating(rating, value);
}

function renderTagChips(tags, values) {
  const tagValues = normalizeTags(values);
  tags.replaceChildren(...tagValues.map(createTagChip));
  tags.title = tagValues.join(", ");
  tags.hidden = tagValues.length === 0;
}

function createTagChip(tag) {
  const chip = document.createElement("span");
  const style = getTagColorStyle(state.tagColors.get(tag));
  chip.className = "media-tag";
  chip.textContent = tag;
  chip.style.setProperty("--tag-outline", style.color);
  chip.style.setProperty("--tag-background", style.background);
  return chip;
}

async function saveItemMetadata(node, { rollback, successMessage }) {
  if (node.isSaving) return false;
  node.isSaving = true;
  setLabelSaving(node, true);
  try {
    if (typeof node.item.save !== "function") throw new Error("素材不支援儲存");
    const result = await node.item.save();
    if (result === false) throw new Error("Eagle 拒絕儲存變更");
    state.explorationSource?.clear();
    showToast(successMessage);
    return true;
  } catch (error) {
    rollback();
    console.error("Failed to save Eagle item metadata", error);
    showToast(`無法儲存素材資料：${error.message || error}`, true);
    return false;
  } finally {
    node.isSaving = false;
    setLabelSaving(node, false);
  }
}

function setLabelSaving(node, isSaving) {
  node.label?.classList.toggle("is-saving", isSaving);
  for (const control of node.label?.querySelectorAll("[data-edit-control]") || []) {
    control.disabled = isSaving;
  }
}

function openTagEditor(node, anchor) {
  closeTagEditor();
  setSelectedNode(node);
  const editor = document.createElement("div");
  const heading = document.createElement("div");
  const input = document.createElement("input");
  const options = document.createElement("div");
  const footer = document.createElement("div");
  const cancel = document.createElement("button");
  const save = document.createElement("button");
  const session = {
    node,
    anchor,
    editor,
    input,
    options,
    selected: new Set(normalizeTags(node.item.tags)),
    outsideHandler: null,
  };

  editor.className = "tag-editor";
  editor.setAttribute("role", "dialog");
  editor.setAttribute("aria-label", `編輯 ${node.item.name || "素材"} 的標籤`);
  heading.className = "tag-editor-heading";
  heading.textContent = "編輯標籤";
  input.className = "tag-editor-search";
  input.type = "search";
  input.placeholder = "搜尋或輸入新標籤";
  input.setAttribute("aria-label", "搜尋或輸入新標籤");
  options.className = "tag-editor-options";
  footer.className = "tag-editor-footer";
  cancel.className = "tag-editor-button";
  cancel.type = "button";
  cancel.textContent = "取消";
  save.className = "tag-editor-button is-primary";
  save.type = "button";
  save.textContent = "完成";

  input.addEventListener("input", () => renderTagEditorOptions(session));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTagEditor();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const tag = input.value.trim();
    if (!tag) return;
    const existingTag = normalizeTags([
      ...session.selected,
      ...state.tagColors.keys(),
    ]).find((candidate) => candidate.toLocaleLowerCase() === tag.toLocaleLowerCase());
    session.selected.add(existingTag || tag);
    input.value = "";
    renderTagEditorOptions(session);
  });
  cancel.addEventListener("click", closeTagEditor);
  save.addEventListener("click", () => commitTagEditor(session));
  editor.addEventListener("pointerdown", (event) => event.stopPropagation());
  footer.append(cancel, save);
  editor.append(heading, input, options, footer);
  elements.viewport.append(editor);
  state.tagEditor = session;
  renderTagEditorOptions(session);

  session.outsideHandler = (event) => {
    if (!editor.contains(event.target) && event.target !== anchor) closeTagEditor();
  };
  document.addEventListener("pointerdown", session.outsideHandler, true);
  requestAnimationFrame(() => {
    if (state.tagEditor !== session) return;
    positionTagEditor(session);
    input.focus();
  });
}

function renderTagEditorOptions(session) {
  const query = session.input.value.trim().toLocaleLowerCase();
  const candidates = normalizeTags([
    ...session.selected,
    ...normalizeTags(session.node.item.tags),
    ...state.tagColors.keys(),
  ])
    .filter((tag) => !query || tag.toLocaleLowerCase().includes(query))
    .sort((first, second) => {
      const selectedDifference = Number(session.selected.has(second)) - Number(session.selected.has(first));
      return selectedDifference || first.localeCompare(second);
    })
    .slice(0, 80);

  session.options.replaceChildren();
  if (query && !candidates.some((tag) => tag.toLocaleLowerCase() === query)) {
    const create = document.createElement("button");
    create.className = "tag-editor-create";
    create.type = "button";
    create.textContent = `建立「${session.input.value.trim()}」`;
    create.addEventListener("click", () => {
      session.selected.add(session.input.value.trim());
      session.input.value = "";
      renderTagEditorOptions(session);
    });
    session.options.append(create);
  }

  for (const tag of candidates) {
    const option = document.createElement("button");
    const marker = document.createElement("span");
    const chip = createTagChip(tag);
    const isSelected = session.selected.has(tag);
    option.className = "tag-editor-option";
    option.type = "button";
    option.setAttribute("aria-pressed", String(isSelected));
    marker.className = "tag-editor-check";
    marker.textContent = isSelected ? "✓" : "";
    option.append(marker, chip);
    option.addEventListener("click", () => {
      if (session.selected.has(tag)) session.selected.delete(tag);
      else session.selected.add(tag);
      renderTagEditorOptions(session);
    });
    session.options.append(option);
  }

  if (!session.options.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "tag-editor-empty";
    empty.textContent = "沒有符合的標籤";
    session.options.append(empty);
  }
}

function positionTagEditor(session) {
  const viewportRect = elements.viewport.getBoundingClientRect();
  const anchorRect = session.anchor.getBoundingClientRect();
  const width = session.editor.offsetWidth;
  const height = session.editor.offsetHeight;
  const anchorLeft = anchorRect.left - viewportRect.left;
  const anchorTop = anchorRect.top - viewportRect.top;
  const left = clamp(anchorLeft, 8, Math.max(8, viewportRect.width - width - 8));
  const below = anchorTop + anchorRect.height + 6;
  const top = below + height <= viewportRect.height - 8
    ? below
    : Math.max(8, anchorTop - height - 6);
  session.editor.style.left = `${Math.round(left)}px`;
  session.editor.style.top = `${Math.round(top)}px`;
}

async function commitTagEditor(session) {
  if (state.tagEditor !== session || session.node.isSaving) return;
  const previousTags = normalizeTags(session.node.item.tags);
  const nextTags = [...session.selected];
  closeTagEditor();
  if (
    previousTags.length === nextTags.length &&
    previousTags.every((tag, index) => tag === nextTags[index])
  ) {
    return;
  }

  session.node.item.tags = nextTags;
  const tags = session.node.label?.querySelector(".media-tags");
  if (tags) renderTagChips(tags, nextTags);
  const saved = await saveItemMetadata(session.node, {
    successMessage: `已更新「${session.node.item.name || "素材"}」的標籤。`,
    rollback: () => {
      session.node.item.tags = previousTags;
      const tags = session.node.label?.querySelector(".media-tags");
      if (tags) renderTagChips(tags, previousTags);
    },
  });
  if (saved) loadTagColors();
}

function closeTagEditor() {
  const session = state.tagEditor;
  if (!session) return;
  document.removeEventListener("pointerdown", session.outsideHandler, true);
  session.editor.remove();
  state.tagEditor = null;
}

async function loadTagColors() {
  const generation = ++state.tagColorGeneration;
  if (typeof eagle === "undefined" || typeof eagle.tag?.get !== "function") {
    state.tagColors = new Map();
    return;
  }

  try {
    const tags = await eagle.tag.get();
    if (generation !== state.tagColorGeneration) return;
    state.tagColors = new Map(
      tags
        .filter(({ name }) => name)
        .map(({ name, color }) => [name, normalizeTagColor(color)]),
    );
    releaseAllMediaLabels();
    updateLabels();
  } catch (error) {
    if (generation !== state.tagColorGeneration) return;
    state.tagColors = new Map();
    console.warn("Failed to load Eagle tag colors", error);
  }
}

function mountMediaLabel(node) {
  if (!node.label) node.label = createMediaLabel(node);
  if (!node.label.isConnected) elements.labels.append(node.label);
  node.label.classList.toggle("is-selected", node === state.selectedNode);
  state.mountedLabelNodes.add(node);
}

function releaseMediaLabel(node) {
  if (state.tagEditor?.node === node) closeTagEditor();
  node.label?.remove();
  node.label = null;
  state.mountedLabelNodes.delete(node);
}

function releaseAllMediaLabels() {
  for (const node of [...state.mountedLabelNodes]) releaseMediaLabel(node);
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
  startVideoPlayer({
    frame,
    image,
    playButton,
    item,
    node,
    controlsHeight: VIDEO_CONTROLS_HEIGHT,
    applyRotation: () => applyMediaRotation(node),
    onLayoutChange: () => {
      positionNode(node);
      updateLabels();
    },
    showToast,
  });
}

function beginPan(event) {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.target.closest("button, input")) return;

  const startPointer = { x: event.clientX, y: event.clientY };
  const startCamera = { ...state.camera };
  let hasStartedPanning = event.button === 1;
  if (hasStartedPanning) {
    event.preventDefault();
    startViewportPan();
  }

  const move = (moveEvent) => {
    const deltaX = moveEvent.clientX - startPointer.x;
    const deltaY = moveEvent.clientY - startPointer.y;
    if (!hasStartedPanning && Math.hypot(deltaX, deltaY) < PAN_START_THRESHOLD) return;
    if (!hasStartedPanning) {
      hasStartedPanning = true;
      startViewportPan();
    }
    moveEvent.preventDefault();
    state.camera.x = startCamera.x + moveEvent.clientX - startPointer.x;
    state.camera.y = startCamera.y + moveEvent.clientY - startPointer.y;
    updateCamera();
  };

  const end = () => {
    if (hasStartedPanning) finishViewportPan();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function startViewportPan() {
  closeTagEditor();
  state.isPanning = true;
  state.lastViewportWork = performance.now();
  elements.viewport.classList.add("is-panning");
  rescheduleViewportWork();
}

function finishViewportPan() {
  state.isPanning = false;
  elements.viewport.classList.remove("is-panning");
  flushViewportWork();
}

function handleWheel(event) {
  event.preventDefault();
  closeTagEditor();
  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  zoomAtPoint(pointerX, pointerY, zoomFactor);
}

function handleKeyDown(event) {
  if (isInteractiveTarget(event.target)) return;

  if (
    event.ctrlKey &&
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  ) {
    event.preventDefault();
    if (isPlayingVideo(state.selectedNode?.videoElement)) {
      controlSelectedVideo(event.key);
    } else {
      panOneViewport(event.key);
      selectNodeAtViewportCenter();
    }
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (event.repeat) return;
    activateSelectedNode();
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

  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  const direction = directionFor(key);

  if (!direction) return;
  event.preventDefault();
  panBy(direction[0] * -KEYBOARD_PAN_STEP, direction[1] * -KEYBOARD_PAN_STEP);
  selectNodeAtViewportCenter();
}

function panBy(dx, dy) {
  state.camera.x += dx;
  state.camera.y += dy;
  updateCamera();
}

function panOneViewport(key) {
  const delta = getViewportPanDelta(
    key,
    { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
    VIEWPORT_PAN_FRACTION,
  );
  if (delta) panBy(delta.x, delta.y);
}

function clearSelection() {
  state.selectedNode?.element?.classList.remove("is-selected");
  state.selectedNode?.label?.classList.remove("is-selected");
  state.selectedNode = null;
  updateExploreButton();
}

function setSelectedNode(node) {
  if (!node || node === state.selectedNode) return;
  state.selectedNode?.element?.classList.remove("is-selected");
  state.selectedNode?.label?.classList.remove("is-selected");
  state.selectedNode = node;
  mountMediaCard(node);
  node.element.classList.add("is-selected");
  node.label?.classList.add("is-selected");
  updateExploreButton();
}

async function exploreNextRow() {
  const pivotNode = state.selectedNode;
  const source = state.explorationSource;
  if (!pivotNode || !source || state.explorationLoading) return;
  const pivot = pivotNode.item;
  if (!(pivot.folders?.length || pivot.tags?.length)) {
    showToast("目前素材沒有資料夾或標籤，無法探索相關素材。", false);
    return;
  }

  const boardNodes = state.nodes;
  state.explorationLoading = true;
  updateExploreButton();
  try {
    const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
    const candidates = await source.findCandidates(pivot, excludedIds);
    if (state.nodes !== boardNodes) return;
    const selectedCandidates = selectDiverseExplorationRow(candidates, pivot);
    if (!selectedCandidates.length) {
      showToast(`找不到更多與「${pivot.name || "目前素材"}」相關的素材。`, false);
      return;
    }

    const items = await source.hydrate(selectedCandidates);
    if (state.nodes !== boardNodes) return;
    if (!items.length) {
      showToast("相關素材目前無法載入。", true);
      return;
    }

    const pivotRow = state.rows.find((row) => row.nodes.includes(pivotNode));
    if (!pivotRow) return;
    const layout = insertExplorationRow(
      { nodes: state.nodes, rows: state.rows },
      pivotRow,
      items,
    );
    state.nodes = layout.nodes;
    state.rows = layout.rows;
    for (const node of state.materializedNodes) positionNode(node);
    updateBoardMeta();
    updateMediaVisibility();
    updateLabels();
    showToast(`已根據「${pivot.name || "目前素材"}」加入 ${items.length} 個相關素材。`);
  } catch (error) {
    console.error("Failed to explore related Eagle items", error);
    showToast(`探索失敗：${error.message || error}`, true);
  } finally {
    state.explorationLoading = false;
    updateExploreButton();
  }
}

function updateExploreButton() {
  if (!elements.exploreButton) return;
  elements.exploreButton.disabled =
    state.explorationLoading || !state.explorationSource || !state.selectedNode;
  elements.exploreButton.textContent = state.explorationLoading
    ? "探索中…"
    : "探索下一列";
}

function selectNodeAtViewportCenter() {
  const center = getViewportWorldCenter(state.camera, {
    width: elements.viewport.clientWidth,
    height: elements.viewport.clientHeight,
  });
  const node = findNearestNodeInRows(state.rows, center);
  if (node && node !== state.selectedNode) setSelectedNode(node);
}

function activateSelectedNode() {
  const node = state.selectedNode;
  if (!node?.isVideo) return;
  if (node.togglePlayback) {
    node.togglePlayback();
  } else {
    node.startPlayback?.();
  }
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

function zoomAtPoint(pointerX, pointerY, factor) {
  const baseScale = getBaseScale();
  state.camera = zoomCameraAtPoint(
    state.camera,
    { x: pointerX, y: pointerY },
    factor,
    baseScale,
    MIN_ZOOM,
    MAX_ZOOM,
  );
  updateCamera();
}

function isInteractiveTarget(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, input, textarea, select, [contenteditable='true']"))
  );
}

function focusFirstItem() {
  const node = state.nodes[0];
  if (!node) return;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  refreshBaseScale();
  const scale = getBaseScale();
  const displayHeight = node.mediaHeight + (node.isVideo ? VIDEO_CONTROLS_HEIGHT : 0);

  state.camera.scale = scale;
  state.camera.x = viewportWidth / 2 - (node.x + node.width / 2) * scale;
  state.camera.y = viewportHeight / 2 - (node.y + displayHeight / 2) * scale;
  updateCamera();
  selectNodeAtViewportCenter();
}

function clearBoard() {
  clearSelection();
  releaseAllMediaCards();
  releaseAllMediaLabels();
  state.nodes = [];
  state.rows = [];
  state.mountedNodes.clear();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";
  refreshBaseScale();
  state.camera = { x: 0, y: 0, scale: getBaseScale() };
  updateCamera();
  updateBoardMeta();
  updateExploreButton();
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

function handleResize() {
  closeTagEditor();
  refreshBaseScale();
  updateCamera();
}

function renderCamera() {
  state.cameraFrame = null;
  const scaleChanged = state.renderedScale !== state.camera.scale;
  const baseScaleChanged = state.renderedBaseScale !== state.baseScale;
  if (scaleChanged) {
    const inverseScale = 1 / state.camera.scale;
    elements.world.style.setProperty("--media-border-width", `${inverseScale}px`);
    state.gridSize = Math.max(8, 24 * state.camera.scale);
    elements.grid.style.backgroundSize = `${state.gridSize}px ${state.gridSize}px`;
    state.renderedScale = state.camera.scale;
  }
  elements.world.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.scale})`;
  if (scaleChanged || baseScaleChanged) {
    elements.zoomLabel.textContent = `${Math.round((state.camera.scale / getBaseScale()) * 100)}%`;
    state.renderedBaseScale = state.baseScale;
  }
  const gridTranslation = getWrappedGridTranslation(
    state.camera,
    state.gridSize,
    GRID_LAYER_OVERFLOW,
  );
  elements.grid.style.transform = `translate3d(${gridTranslation.x}px, ${gridTranslation.y}px, 0)`;
  if (scaleChanged) updateMountedLabelPositions();
  else updateLabelLayerTransform();
  scheduleViewportWork();
}

function scheduleViewportWork() {
  if (state.viewportWorkTimer !== null) return;
  const elapsed = performance.now() - state.lastViewportWork;
  const delay = Math.max(0, getViewportWorkInterval(state.isPanning) - elapsed);
  state.viewportWorkTimer = window.setTimeout(runViewportWork, delay);
}

function rescheduleViewportWork() {
  if (state.viewportWorkTimer !== null) window.clearTimeout(state.viewportWorkTimer);
  state.viewportWorkTimer = null;
  scheduleViewportWork();
}

function flushViewportWork() {
  if (state.viewportWorkTimer !== null) window.clearTimeout(state.viewportWorkTimer);
  state.viewportWorkTimer = null;
  runViewportWork();
}

function runViewportWork() {
  state.viewportWorkTimer = null;
  state.lastViewportWork = performance.now();
  updateMediaVisibility({ deferCleanup: state.isPanning });
  updateLabels();
  selectNodeAtViewportCenter();
}

function updateMediaVisibility({ deferCleanup = false } = {}) {
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

  if (zoom < ORIGINAL_IMAGE_ZOOM) {
    for (const node of state.materializedNodes) mediaLoadQueue.cancel(node, "original");
  }

  if (!deferCleanup) {
    for (const node of state.mountedNodes) {
      if (!nextMountedNodes.has(node) && node !== state.selectedNode) {
        unmountMediaCard(node);
      }
    }

    for (const node of [...state.materializedNodes]) {
      if (!retainedNodes.has(node) && node !== state.selectedNode) {
        releaseMediaCard(node);
      }
    }
  }

  for (const node of visibleNodes) mountMediaCard(node);

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
        !node.isVideo && zoom >= ORIGINAL_IMAGE_ZOOM
          ? "original"
          : "thumbnail";
      node.loadMedia(quality);
    }
  }
}

function getNodesNearViewport(screenMargin) {
  return findNodesNearViewport(
    state.rows,
    state.camera,
    { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
    screenMargin,
  );
}

function updateLabels() {
  if (!elements.labels) return;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scale = state.camera.scale;
  const zoom = scale / getBaseScale();
  const showLabels = getLabelDetailLevel(zoom, scale) !== "hidden";
  const labelNodes = showLabels ? getNodesNearViewport(30) : [];
  const visibleLabels = [];

  for (const node of labelNodes) {
    const rect = getLabelRect(node, state.camera);
    const isVisible =
      showLabels &&
      rect.left + rect.width >= 0 &&
      rect.left <= viewportWidth &&
      rect.top + rect.height >= 0 &&
      rect.top <= viewportHeight;

    if (!isVisible) continue;
    visibleLabels.push({ node, rect });
  }

  const nextLabelNodes = new Set(visibleLabels.map(({ node }) => node));
  if (!state.isPanning) {
    for (const node of [...state.mountedLabelNodes]) {
      if (!nextLabelNodes.has(node)) releaseMediaLabel(node);
    }
  } else {
    for (const node of state.mountedLabelNodes) {
      if (!nextLabelNodes.has(node)) positionMediaLabel(node);
    }
  }

  for (const { node, rect } of visibleLabels) {
    mountMediaLabel(node);
    positionMediaLabel(node, rect);
  }
  resetLabelLayerCamera();
}

function updateMountedLabelPositions() {
  for (const node of state.mountedLabelNodes) positionMediaLabel(node);
  resetLabelLayerCamera();
}

function updateLabelLayerTransform() {
  const translation = getPanLayerTranslation(state.camera, state.labelCamera);
  if (!translation) {
    updateMountedLabelPositions();
    return;
  }
  elements.labels.style.transform = `translate3d(${translation.x}px, ${translation.y}px, 0)`;
}

function resetLabelLayerCamera() {
  state.labelCamera = { ...state.camera };
  elements.labels.style.transform = "translate3d(0, 0, 0)";
}

function positionMediaLabel(node, rect = getLabelRect(node, state.camera)) {
  const detailLevel = getLabelDetailLevel(
    state.camera.scale / getBaseScale(),
    state.camera.scale,
  );
  const showDetails = detailLevel === "details";
  node.label.classList.toggle("is-compact", !showDetails);
  node.label.style.left = `${rect.left}px`;
  node.label.style.top = `${rect.top}px`;
  node.label.style.width = `${Math.max(1, rect.width)}px`;
}

function positionNode(node) {
  if (!node.element) return;
  node.element.style.width = `${node.width}px`;
  node.element.style.transform = `translate(${node.x}px, ${node.y}px)`;
}

function getBaseScale() {
  return state.baseScale;
}

function refreshBaseScale() {
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
  state.baseScale = Math.max(0.01, Math.min(widthScale, heightScale));
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
