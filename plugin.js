"use strict";

const {
  DEFAULT_MAX_EXPLORATION_ITEMS,
  LAYOUT_GAP,
  LAYOUT_WIDTH,
  MAX_LAYOUT_WIDTH,
  MAX_EXPLORATION_ITEMS,
  MIN_LAYOUT_WIDTH,
  MIN_EXPLORATION_ITEMS,
  ROW_GAP,
  TARGET_ROW_HEIGHT,
  VIDEO_CONTROLS_HEIGHT,
  VIDEO_EXTENSIONS,
  clamp,
  createJustifiedLayout,
  directionFor,
  findNodesNearViewport,
  formatFileSize,
  formatItemDimensions,
  getArrowKeyAction,
  getItemRating,
  getNextRating,
  getLabelDetailLevel,
  getLabelRect,
  getPanLayerTranslation,
  getWrappedGridTranslation,
  getViewportWorkInterval,
  getTagColorStyle,
  insertExplorationRow,
  isPlayingVideo,
  normalizeTags,
  normalizeTagColor,
  resizeCamera,
  selectDiverseExplorationRow,
  shouldLoadUnratedRow,
} = BirdViewCore;
const { MediaLoadQueue, waitForImageDecode } = BirdViewMedia;
const {
  DEFAULT_UNRATED_FILTER,
  RelatedItemSource,
  UnratedItemSource,
  normalizeUnratedFilter,
  unratedFiltersEqual,
} = BirdViewExploration;
const { FolderItemSource } = BirdViewFolder;
const { FolderPicker } = BirdViewFolderPicker;
const { startVideoPlayer } = BirdViewVideo;
const { TagEditor } = BirdViewTagEditor;
const { createCameraNavigation } = BirdViewCamera;
const { createSelectionNavigation } = BirdViewSelection;
const DEFAULT_SMOOTH_PAN_SPEED = 480;
const MIN_SMOOTH_PAN_SPEED = 120;
const MAX_SMOOTH_PAN_SPEED = 3000;
const DEFAULT_SMOOTH_ZOOM_SPEED = 1.5;
const MIN_SMOOTH_ZOOM_SPEED = 1.05;
const MAX_SMOOTH_ZOOM_SPEED = 12;
const DEFAULT_FOCUS_MEDIA_SIZE = TARGET_ROW_HEIGHT;
const MIN_FOCUS_MEDIA_SIZE = 80;
const MAX_FOCUS_MEDIA_SIZE = 400;
const DEFAULT_LAYOUT_DIRECTION = "ltr";
const DEFAULT_LAYOUT_WIDTH = LAYOUT_WIDTH;
const SEAMLESS_LAYOUT_GAP = 0;
const SEAMLESS_ROW_GAP = 0;
const TIGHT_FOCUS_ROW_EMPHASIS = 1.1;
const SETTINGS_STORAGE_KEY = "bird-view-settings";
const KEYBOARD_ZOOM_FACTOR = 1.5;
const KEYBOARD_SEEK_STEP = 5;
const KEYBOARD_VOLUME_STEP = 0.05;
const PAN_START_THRESHOLD = 4;
const ORIGINAL_IMAGE_ZOOM = 0.8;
const ORIGINAL_IMAGE_LOAD_TIMEOUT = 8000;
const MAX_CONCURRENT_IMAGE_LOADS = 4;
const RESOURCE_RELEASE_VIEWPORTS = 3;
const GRID_LAYER_OVERFLOW = 768;
const METADATA_SUCCESS_TOAST_MS = 1200;
const FOLDER_LOAD_BATCH_SIZE = 120;
const MEDIA_DEBUG_STORAGE_KEY = "bird-view-debug";

function isMediaDebugEnabled() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MEDIA_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function debugLogMedia(item, event, details = {}) {
  if (!isMediaDebugEnabled()) return;
  console.log(
    `[bird-view] ${new Date().toISOString()} ${event}`,
    { name: item?.name, id: item?.id, ...details },
  );
}

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
  verticalNavigation: null,
  smoothPanEnabled: false,
  smoothPanSpeed: DEFAULT_SMOOTH_PAN_SPEED,
  smoothZoomEnabled: false,
  smoothZoomSpeed: DEFAULT_SMOOTH_ZOOM_SPEED,
  focusMediaSize: DEFAULT_FOCUS_MEDIA_SIZE,
  layoutDirection: DEFAULT_LAYOUT_DIRECTION,
  layoutWidth: DEFAULT_LAYOUT_WIDTH,
  layoutWidthUnlimited: false,
  seamlessMode: false,
  maxExplorationItems: DEFAULT_MAX_EXPLORATION_ITEMS,
  videoVolume: 1,
  smoothPanKeys: new Set(),
  smoothPanFrame: null,
  smoothPanLastTimestamp: null,
  smoothZoomKeys: new Set(),
  smoothZoomFrame: null,
  smoothZoomLastTimestamp: null,
  toastTimer: null,
  cameraFrame: null,
  cameraFocusFrame: null,
  viewportWorkTimer: null,
  lastViewportWork: -Infinity,
  isPanning: false,
  explorationSource: null,
  explorationGeneration: 0,
  explorationLoading: false,
  folderItemSource: null,
  folderItems: [],
  folderItemOffset: 0,
  folderItemGeneration: 0,
  folderItemLoading: false,
  unratedSource: null,
  unratedEnabled: false,
  unratedLoading: false,
  unratedExhausted: false,
  unratedFilter: normalizeUnratedFilter(DEFAULT_UNRATED_FILTER),
  unratedDraftFilter: null,
  unratedGeneration: 0,
  lastUnratedTriggerRow: null,
  tagColors: new Map(),
  tagColorGeneration: 0,
  folderNames: new Map(),
  folderNameGeneration: 0,
  selectedItemsGeneration: 0,
  viewportSize: null,
  started: false,
  eagleReady: false,
};

const elements = {};
let cameraNavigation = null;
let selectionNavigation = null;
const mediaLoadQueue = new MediaLoadQueue({ maxConcurrent: MAX_CONCURRENT_IMAGE_LOADS });
const tagEditor = new TagEditor({
  getViewport: () => elements.viewport,
  getAvailableTags: () => state.tagColors.keys(),
  createTagChip,
  onSelectNode: (node) => selectionNavigation.setSelectedNode(node),
  onCommit: commitNodeTags,
});
const folderPicker = new FolderPicker({
  getViewport: () => elements.viewport,
  onSelect: addSelectedItemToFolder,
  onEmpty: () => showToast("目前沒有可用的 Eagle 資料夾。", false),
});

if (typeof eagle !== "undefined" && typeof eagle.onPluginCreate === "function") {
  eagle.onPluginCreate(() => {
    state.eagleReady = true;
    if (elements.viewport) startEagleIntegration();
  });
  if (typeof eagle.onPluginRun === "function") {
    eagle.onPluginRun(handlePluginRun);
  }
}

document.addEventListener("DOMContentLoaded", setup);

function setup() {
  elements.app = document.querySelector(".app");
  elements.viewport = document.querySelector("#viewport");
  elements.world = document.querySelector("#world");
  elements.grid = document.querySelector("#grid");
  elements.labels = document.querySelector("#labels");
  elements.emptyState = document.querySelector("#empty-state");
  elements.itemCount = document.querySelector("#item-count");
  elements.zoomLabel = document.querySelector("#zoom-label");
  elements.selectionStatus = document.querySelector("#selection-status");
  elements.selectionEmpty = document.querySelector("#selection-empty");
  elements.selectionDetails = document.querySelector("#selection-details");
  elements.selectionName = document.querySelector("#selection-name");
  elements.selectionDimensionsDivider = document.querySelector("#selection-dimensions-divider");
  elements.selectionDimensions = document.querySelector("#selection-dimensions");
  elements.selectionRating = document.querySelector("#selection-rating");
  elements.selectionTagsDivider = document.querySelector("#selection-tags-divider");
  elements.selectionTags = document.querySelector("#selection-tags");
  elements.selectionFoldersDivider = document.querySelector("#selection-folders-divider");
  elements.selectionFolders = document.querySelector("#selection-folders");
  elements.autoExploreToggle = document.querySelector("#auto-explore-toggle");
  elements.autoExploreStatus = document.querySelector("#auto-explore-status");
  elements.seamlessModeToggle = document.querySelector("#seamless-mode-toggle");
  elements.seamlessModeStatus = document.querySelector("#seamless-mode-status");
  elements.autoExploreSettingsButton = document.querySelector("#auto-explore-settings-button");
  elements.autoExploreSettingsPanel = document.querySelector("#auto-explore-settings-panel");
  elements.layoutDirection = document.querySelector("#board-layout-direction");
  elements.layoutWidth = document.querySelector("#board-layout-width");
  elements.layoutWidthValue = document.querySelector("#board-layout-width-value");
  elements.maxExplorationItems = document.querySelector("#board-exploration-max-items");
  elements.maxExplorationItemsValue = document.querySelector("#board-exploration-max-items-value");
  elements.smoothPanToggle = document.querySelector("#smooth-pan-toggle");
  elements.smoothPanSpeed = document.querySelector("#smooth-pan-speed");
  elements.smoothPanSpeedValue = document.querySelector("#smooth-pan-speed-value");
  elements.smoothZoomToggle = document.querySelector("#smooth-zoom-toggle");
  elements.smoothZoomSpeed = document.querySelector("#smooth-zoom-speed");
  elements.smoothZoomSpeedValue = document.querySelector("#smooth-zoom-speed-value");
  elements.focusMediaSize = document.querySelector("#focus-media-size");
  elements.focusMediaSizeValue = document.querySelector("#focus-media-size-value");
  elements.autoExploreFileTypeImage = document.querySelector("#auto-explore-file-type-image");
  elements.autoExploreFileTypeVideo = document.querySelector("#auto-explore-file-type-video");
  elements.autoExploreRating = document.querySelector("#auto-explore-rating");
  elements.autoExploreTagMatch = document.querySelector("#auto-explore-tag-match");
  elements.autoExploreMaxTagCount = document.querySelector("#auto-explore-max-tag-count");
  elements.autoExploreTagSearch = document.querySelector("#auto-explore-tag-search");
  elements.autoExploreTagOptions = document.querySelector("#auto-explore-tag-options");
  elements.autoExploreSelectedTags = document.querySelector("#auto-explore-selected-tags");
  elements.autoExploreExcludedTagSearch = document.querySelector("#auto-explore-excluded-tag-search");
  elements.autoExploreExcludedTagOptions = document.querySelector("#auto-explore-excluded-tag-options");
  elements.autoExploreSelectedExcludedTags = document.querySelector("#auto-explore-selected-excluded-tags");
  elements.autoExploreControls = document.querySelector(".auto-explore-controls");
  elements.autoExploreSettingsReset = document.querySelector("#auto-explore-settings-reset");
  elements.exploreButton = document.querySelector("#explore-button");
  elements.folderLoadMoreButton = document.querySelector("#folder-load-more-button");
  elements.toast = document.querySelector("#toast");

  selectionNavigation = createSelectionNavigation({
    state,
    elements,
    onSelectNode: applySelectedNode,
    onClearSelection: applyClearedSelection,
  });
  cameraNavigation = createCameraNavigation({
    state,
    elements,
    getBaseScale,
    updateCamera,
    selectNodeAtViewportCenter: () => selectionNavigation.selectNodeAtViewportCenter(),
    getVideoControlsHeight,
    getFocusRowEmphasis: () =>
      state.seamlessMode ? TIGHT_FOCUS_ROW_EMPHASIS : undefined,
    getFocusTargetHeight: () => state.focusMediaSize,
  });

  elements.viewport.addEventListener("pointerdown", beginPan);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", (event) => cameraNavigation.handleKeyUp(event.key));
  window.addEventListener("blur", () => cameraNavigation.handleWindowBlur());
  window.addEventListener("resize", handleResize);
  document.addEventListener("pointerdown", handleAutoExploreOutsidePointerDown);
  elements.autoExploreToggle.addEventListener("click", toggleUnratedExploration);
  elements.seamlessModeToggle?.addEventListener("click", toggleSeamlessMode);
  elements.autoExploreSettingsButton?.addEventListener("click", toggleAutoExploreSettings);
  elements.autoExploreFileTypeImage?.addEventListener("change", updateDraftAutoExploreFileTypes);
  elements.autoExploreFileTypeVideo?.addEventListener("change", updateDraftAutoExploreFileTypes);
  elements.autoExploreRating?.addEventListener("change", updateDraftAutoExploreRating);
  elements.autoExploreTagMatch?.addEventListener("change", updateDraftAutoExploreTagMatch);
  elements.autoExploreMaxTagCount?.addEventListener("input", updateDraftAutoExploreMaxTagCount);
  elements.autoExploreTagSearch?.addEventListener("input", renderAutoExploreTagOptions);
  elements.autoExploreTagSearch?.addEventListener("keydown", handleAutoExploreTagSearchKeyDown);
  elements.autoExploreExcludedTagSearch?.addEventListener("input", renderAutoExploreTagOptions);
  elements.autoExploreExcludedTagSearch?.addEventListener(
    "keydown",
    handleAutoExploreExcludedTagSearchKeyDown,
  );
  elements.autoExploreSettingsReset?.addEventListener("click", resetAutoExploreSettings);
  elements.folderLoadMoreButton?.addEventListener("click", () => {
    void loadMoreFolderItems();
  });
  elements.layoutDirection?.addEventListener("change", updateBoardSettings);
  elements.layoutWidth?.addEventListener("input", updateBoardSettings);
  elements.maxExplorationItems?.addEventListener("input", updateBoardSettings);
  elements.smoothPanToggle?.addEventListener("change", updateBoardSettings);
  elements.smoothPanSpeed?.addEventListener("input", updateBoardSettings);
  elements.smoothZoomToggle?.addEventListener("change", updateBoardSettings);
  elements.smoothZoomSpeed?.addEventListener("input", updateBoardSettings);
  elements.focusMediaSize?.addEventListener("input", updateBoardSettings);
  elements.exploreButton.addEventListener("click", exploreNextRow);
  restoreSavedSettings();
  updateSeamlessModeUI();
  updateAutoExploreToggle();
  updateAutoExploreSettingsUI();
  updateSelectionStatus();

  refreshBaseScale();
  state.camera.scale = getBaseScale();
  state.viewportSize = getViewportSize();
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
  state.unratedSource = new UnratedItemSource(eagle.item);
  state.folderItemSource =
    typeof eagle.folder?.getSelected === "function" || typeof eagle.folder?.get === "function"
      ? new FolderItemSource(eagle.item, eagle.folder)
      : null;
  if (typeof eagle.onLibraryChanged === "function") {
    eagle.onLibraryChanged(handleLibraryChanged);
  }
  updateExploreButton();
  updateAutoExploreToggle();
  void loadTagColors();
  void loadSelectedItems();
}

function handlePluginRun() {
  if (!state.started) {
    if (elements.viewport) startEagleIntegration();
    return;
  }
  void loadSelectedItems({ append: true });
}

function handleLibraryChanged() {
  resetFolderItemLoad();
  clearBoard();
  state.folderNameGeneration += 1;
  state.folderNames.clear();
  state.explorationSource.clear();
  state.unratedSource.clear();
  state.unratedGeneration += 1;
  state.unratedLoading = false;
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  updateAutoExploreToggle();
  void loadTagColors();
  showToast("Eagle 資料庫已切換，正在重新載入選取素材。", false);
  void loadSelectedItems();
}

async function loadSelectedItems({ append = false } = {}) {
  if (typeof eagle === "undefined") {
    showToast("目前不在 Eagle 外掛環境中。", true);
    return;
  }

  const generation = ++state.selectedItemsGeneration;
  try {
    const items = await eagle.item.getSelected();
    if (generation !== state.selectedItemsGeneration) return;

    if (items.length) {
      if (append) {
        resetFolderItemLoad();
        const existingIds = new Set(state.nodes.map(({ item }) => item.id));
        const newItems = items.filter(({ id }) => id && !existingIds.has(id));
        if (!newItems.length) return;
        appendItemsToBoard(newItems);
        showToast(`已加入 ${newItems.length} 個新素材。`);
        return;
      }

      resetFolderItemLoad();
      renderItems(items);
      requestAnimationFrame(focusFirstItem);
      showToast(`已載入 ${items.length} 個素材。`);
      return;
    }

    let selectedFolderItems = null;
    if (state.folderItemSource) {
      try {
        selectedFolderItems = await state.folderItemSource.loadSelected();
      } catch (error) {
        console.warn("Failed to inspect selected Eagle folders", error);
      }
    }
    if (generation !== state.selectedItemsGeneration) return;
    if (selectedFolderItems?.folders?.length) {
      await startFolderItemLoad(selectedFolderItems);
      return;
    }

    if (append) return;

    resetFolderItemLoad();
    clearBoard();
    if (state.unratedEnabled) {
      showToast("Eagle 目前沒有選取素材，正在探索符合條件的素材。", false);
      await loadNextUnratedRow({ focus: true });
    } else {
      showToast("Eagle 目前沒有選取素材，可開啟自動探索。", false);
    }
  } catch (error) {
    if (generation !== state.selectedItemsGeneration) return;
    console.error("Failed to load selected Eagle items", error);
    showToast(`無法讀取 Eagle 素材：${error.message || error}`, true);
  }
}

async function startFolderItemLoad({ folders, items }) {
  resetFolderItemLoad();
  clearBoard();
  state.folderItems = items || [];
  updateFolderLoadMoreUI();

  if (!state.folderItems.length) {
    showToast(`選取的資料夾${describeSelectedFolders(folders)}沒有可載入的素材。`, false);
    return;
  }

  await loadMoreFolderItems({ focus: true });
  const progressMessage = `已載入資料夾${describeSelectedFolders(folders)}的 ${state.folderItemOffset} / ${state.folderItems.length} 個素材`;
  showToast(
    state.folderItems.length > state.folderItemOffset
      ? `${progressMessage}，可按「載入更多」繼續。`
      : `${progressMessage}。`,
    false,
  );
}

async function loadMoreFolderItems({ focus = false } = {}) {
  if (state.folderItemLoading || state.folderItemOffset >= state.folderItems.length) return;
  const source = state.folderItemSource;
  if (!source) return;

  const generation = state.folderItemGeneration;
  const start = state.folderItemOffset;
  const batch = state.folderItems.slice(start, start + FOLDER_LOAD_BATCH_SIZE);
  state.folderItemLoading = true;
  updateFolderLoadMoreUI();
  try {
    const items = await source.hydrate(batch);
    if (generation !== state.folderItemGeneration) return;
    if (items.length) {
      if (start === 0) {
        renderItems(items);
        if (focus) requestAnimationFrame(focusFirstItem);
      } else {
        appendItemsToBoard(items);
      }
    }
    state.folderItemOffset = start + batch.length;
    updateFolderLoadMoreUI();
    if (!focus && items.length) {
      showToast(`已載入 ${state.folderItemOffset} / ${state.folderItems.length} 個資料夾素材。`);
    }
  } catch (error) {
    if (generation !== state.folderItemGeneration) return;
    console.error("Failed to load folder items", error);
    showToast(`無法載入資料夾素材：${error.message || error}`, true);
  } finally {
    if (generation === state.folderItemGeneration) {
      state.folderItemLoading = false;
      updateFolderLoadMoreUI();
    }
  }
}

function resetFolderItemLoad() {
  state.folderItemGeneration += 1;
  state.folderItems = [];
  state.folderItemOffset = 0;
  state.folderItemLoading = false;
  updateFolderLoadMoreUI();
}

function updateFolderLoadMoreUI() {
  const button = elements.folderLoadMoreButton;
  if (!button) return;
  const remaining = Math.max(state.folderItems.length - state.folderItemOffset, 0);
  button.hidden = remaining === 0;
  button.disabled = state.folderItemLoading;
  button.textContent = state.folderItemLoading ? "載入中…" : `載入更多（${remaining}）`;
  button.title = state.folderItemLoading
    ? "正在載入資料夾素材"
    : `載入剩餘 ${remaining} 個資料夾素材`;
}

function describeSelectedFolders(folders) {
  const names = (folders || [])
    .map((folder) => String(folder?.name || "").trim())
    .filter(Boolean);
  if (names.length === 1) return `「${names[0]}」`;
  if (names.length > 1) return `${names.length} 個資料夾`;
  return "選取資料夾";
}

function appendItemsToBoard(items) {
  if (!items.length) return;
  if (!state.rows.length) {
    renderItems(items);
    requestAnimationFrame(focusFirstItem);
    return;
  }

  const layoutConfig = getBoardLayoutConfig();
  const selectedLayout = createBoardLayout(items, layoutConfig);
  let layout = {
    nodes: state.nodes,
    rows: state.rows,
    ...layoutConfig,
  };
  for (const row of selectedLayout.rows) {
    layout = insertBoardRow(
      layout,
      layout.rows.at(-1),
      row.nodes.map(({ item }) => item),
      layoutConfig,
    );
  }
  state.nodes = layout.nodes;
  state.rows = layout.rows;
  void loadFolderNames(items);
  for (const node of state.materializedNodes) positionNode(node);
  updateBoardMeta();
  renderAutoExploreTagOptions();
  updateMediaVisibility();
  updateLabels();
}

function renderItems(items) {
  tagEditor.close();
  folderPicker.close();
  selectionNavigation.clearSelection();
  releaseAllMediaCards();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";
  state.mountedNodes.clear();
  const layout = createBoardLayout(items);
  state.nodes = layout.nodes;
  state.rows = layout.rows;
  state.lastUnratedTriggerRow = null;
  void loadFolderNames(items);
  renderAutoExploreTagOptions();
  refreshBaseScale();

  updateBoardMeta();
  updateLabels();
}

function relayoutBoard() {
  if (!state.nodes.length) return;

  const selectedItemId = state.selectedNode?.item?.id;
  const rotations = new Map(
    state.nodes.map((node) => [node.item.id, node.rotation || 0]),
  );
  const items = state.nodes.map(({ item }) => item);

  selectionNavigation.clearSelection();
  releaseAllMediaCards();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.mountedNodes.clear();
  state.labelCamera = null;
  elements.labels.style.transform = "none";

  const layout = createBoardLayout(items);
  for (const node of layout.nodes) {
    node.rotation = rotations.get(node.item.id) || 0;
  }
  state.nodes = layout.nodes;
  state.rows = layout.rows;

  refreshBaseScale();
  updateBoardMeta();
  const selectedNode = state.nodes.find(({ item }) => item.id === selectedItemId);
  if (selectedNode) selectionNavigation.setSelectedNode(selectedNode);
  updateCamera();
  updateMediaVisibility();
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
  node.stopVideoControls?.();

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
  node.retryOriginal = null;
  node.videoElement = null;
  node.togglePlayback = null;
  node.stopVideoControls = null;
  node.revealVideoControls = null;
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
  const retryOriginalButton = !isVideo ? document.createElement("button") : null;
  const mediaGeneration = (node.mediaGeneration || 0) + 1;
  let originalLoadTimeoutId = null;
  node.mediaGeneration = mediaGeneration;

  card.className = "media-card";
  card.dataset.itemId = item.id;
  card.dataset.mediaQuality = "idle";
  card.title = isVideo
    ? `${item.name || "未命名"}（雙擊播放或暫停）`
    : item.name || "未命名";
  frame.className = "media-frame";
  frame.style.height = `${node.mediaHeight}px`;
  const originalImageURL = !isVideo ? item.fileURL : null;
  const fallbackURL = item.thumbnailURL || item.fileURL;
  if (!isVideo && !originalImageURL) {
    debugLogMedia(item, "card-created-without-fileURL", { fileURL: item.fileURL });
  }
  image.alt = item.name || "Eagle 素材";
  image.decoding = "async";
  image.draggable = false;
  image.style.visibility = "hidden";
  if (retryOriginalButton) {
    retryOriginalButton.className = "original-retry-button";
    retryOriginalButton.type = "button";
    retryOriginalButton.textContent = "原圖載入失敗，重試";
    retryOriginalButton.setAttribute("aria-label", `重試載入 ${item.name || "素材"} 的原圖`);
    retryOriginalButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    retryOriginalButton.addEventListener("click", (event) => {
      event.stopPropagation();
      retryOriginalImage(node);
    });
  }
  node.mediaElement = image;
  const clearOriginalLoadTimeout = () => {
    if (originalLoadTimeoutId === null) return;
    window.clearTimeout(originalLoadTimeoutId);
    originalLoadTimeoutId = null;
  };
  const markOriginalLoadFailed = (reason = "error") => {
    const snapshot = mediaLoadQueue.snapshot(node);
    const isRequested =
      snapshot?.pendingQuality === "original" ||
      snapshot?.queuedQuality === "original" ||
      snapshot?.loadingQuality === "original";
    if (!isRequested) return;
    clearOriginalLoadTimeout();
    if (retryOriginalButton) {
      retryOriginalButton.textContent =
        reason === "timeout" ? "原圖載入逾時，重試" : "原圖載入失敗，重試";
    }
    if (!mediaLoadQueue.fail(node, "original")) return;
    card.dataset.mediaQuality = "original-failed";
    debugLogMedia(item, "original-load-failed", { reason, fileURL: originalImageURL });
  };
  const failOriginalLoad = (reason = "error", originalImage) => {
    if (
      node.mediaGeneration !== mediaGeneration ||
      node.preloadImage !== originalImage ||
      mediaLoadQueue.snapshot(node)?.loadingQuality !== "original"
    ) {
      return;
    }
    markOriginalLoadFailed(reason);
  };
  const watchOriginalLoad = () => {
    const snapshot = mediaLoadQueue.snapshot(node);
    const isRequested =
      snapshot?.pendingQuality === "original" ||
      snapshot?.queuedQuality === "original" ||
      snapshot?.loadingQuality === "original";
    if (!isRequested || originalLoadTimeoutId !== null) return;
    originalLoadTimeoutId = window.setTimeout(() => {
      const latest = mediaLoadQueue.snapshot(node);
      const stillRequested =
        latest?.pendingQuality === "original" ||
        latest?.queuedQuality === "original" ||
        latest?.loadingQuality === "original";
      if (!stillRequested) {
        clearOriginalLoadTimeout();
        return;
      }
      debugLogMedia(item, "original-load-watchdog-fired", {
        pendingQuality: latest.pendingQuality,
        queuedQuality: latest.queuedQuality,
        loadingQuality: latest.loadingQuality,
        fileURL: originalImageURL,
      });
      if (latest.loadingQuality === "original" && node.preloadImage) {
        failOriginalLoad("timeout", node.preloadImage);
      } else {
        markOriginalLoadFailed("timeout");
      }
    }, ORIGINAL_IMAGE_LOAD_TIMEOUT);
  };
  node.loadMedia = (quality = "thumbnail") => {
    const requested = mediaLoadQueue.request(node, quality);
    if (quality === "original" && originalImageURL) watchOriginalLoad();
    return requested;
  };
  node.retryOriginal = () => {
    const requested = mediaLoadQueue.retry(node, "original");
    watchOriginalLoad();
    return requested;
  };
  mediaLoadQueue.register(node, {
    hasOriginal: Boolean(originalImageURL),
    hasThumbnail: Boolean(fallbackURL),
    preferThumbnailFirst: Boolean(
      originalImageURL && fallbackURL && originalImageURL !== fallbackURL,
    ),
    cancel: (quality) => {
      if (quality !== "original") return;
      clearOriginalLoadTimeout();
      if (!node.preloadImage) return;
      const originalImage = node.preloadImage;
      node.preloadImage = null;
      originalImage.removeAttribute("src");
      originalImage.remove();
      card.dataset.mediaQuality = mediaLoadQueue.snapshot(node)?.readyQuality || "idle";
      debugLogMedia(item, "original-load-canceled");
    },
    start: (quality) => {
      const mediaURL = quality === "original" ? originalImageURL : fallbackURL;
      if (!mediaURL) {
        mediaLoadQueue.complete(node, quality, false);
        return;
      }
      card.dataset.mediaQuality =
        quality === "original" ? "loading-original" : "loading-thumbnail";
      if (quality === "original") {
        debugLogMedia(item, "original-load-started", { fileURL: mediaURL });
        const originalImage = document.createElement("img");
        originalImage.alt = image.alt;
        originalImage.decoding = "async";
        originalImage.draggable = false;
        originalImage.style.visibility = "hidden";
        originalImage.setAttribute("aria-hidden", "true");
        node.preloadImage = originalImage;
        frame.append(originalImage);
        originalImage.addEventListener("load", async () => {
          clearOriginalLoadTimeout();
          await waitForImageDecode(originalImage);
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
          card.dataset.mediaQuality = "original";
          applyMediaRotation(node);
          mediaLoadQueue.complete(node, "original", true);
          debugLogMedia(item, "original-load-succeeded", { fileURL: mediaURL });
        });
        originalImage.addEventListener("error", () => {
          failOriginalLoad("error", originalImage);
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
    card.dataset.mediaQuality =
      mediaLoadQueue.snapshot(node)?.originalFailed ? "original-failed" : "thumbnail";
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
    card.dataset.mediaQuality = "thumbnail-failed";
    mediaLoadQueue.complete(node, "thumbnail", false);
  });

  frame.append(image);
  if (retryOriginalButton) frame.append(retryOriginalButton);
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
      selectionNavigation.setSelectedNode(node);
      startVideo(frame, image, playButton, item, node);
    });
    node.startPlayback = () => startVideo(frame, image, playButton, item, node);
    frame.append(playButton);
  }

  card.addEventListener("dblclick", (event) => {
    if (!node.isVideo || event.target.closest("button, input")) return;
    event.preventDefault();
    selectionNavigation.setSelectedNode(node);
    if (node.togglePlayback) {
      node.togglePlayback();
    } else {
      node.startPlayback?.();
    }
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMediaContextMenu(node);
  });

  return card;
}

function openMediaContextMenu(node) {
  if (
    typeof eagle === "undefined" ||
    typeof eagle.contextMenu?.open !== "function" ||
    typeof eagle.item?.open !== "function"
  ) {
    showToast("目前無法開啟 Eagle 右鍵選單。", true);
    return;
  }
  eagle.contextMenu.open([
    {
      id: "open-item-in-eagle",
      label: "在 Eagle 中開啟",
      click: () => void openItemInEagle(node.item.id),
    },
  ]);
}

async function openItemInEagle(itemId) {
  if (typeof eagle === "undefined" || typeof eagle.item?.open !== "function") {
    showToast("Eagle 不支援開啟素材。", true);
    return;
  }
  try {
    await eagle.item.open(itemId);
  } catch (error) {
    console.error("Failed to open Eagle item", error);
    showToast(`無法在 Eagle 中開啟素材：${error.message || error}`, true);
  }
}

function createMediaLabel(node) {
  const { item } = node;
  const label = document.createElement("div");
  const main = document.createElement("div");
  const metadata = document.createElement("div");
  const rating = document.createElement("span");
  const tags = document.createElement("span");
  const editTags = document.createElement("button");
  const identity = document.createElement("span");
  const name = document.createElement("span");
  const dimensions = document.createElement("span");
  const fileInfo = document.createElement("span");
  const basicInfo = document.createElement("span");
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
    if (!node.isSaving) tagEditor.open(node, editTags);
  });
  identity.className = "media-identity";
  name.className = "media-name";
  name.textContent = item.name || "未命名";
  dimensions.className = "media-dimensions";
  dimensions.textContent = formatItemDimensions(item);
  dimensions.hidden = !dimensions.textContent;
  fileInfo.className = "media-file-info";
  basicInfo.className = "media-basic-info";
  basicInfo.textContent = formatFileSize(item.size);
  basicInfo.hidden = !basicInfo.textContent;
  type.className = "media-extension";
  type.textContent = `${basicInfo.textContent ? "· " : ""}${String(
    item.ext || "FILE",
  ).toUpperCase()}`;
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
  identity.append(name, dimensions);
  fileInfo.append(basicInfo, type);
  actions.append(fileInfo, rotateLeft, rotateRight);
  metadata.append(rating, tags, editTags);
  main.append(identity, actions);
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
      selectionNavigation.setSelectedNode(node);
      await setItemRating(node, index, { toggle: true });
    });
    rating.append(star);
  }
  paintRating(rating, currentRating);
}

async function setItemRating(node, value, { toggle = false } = {}) {
  if (!node || node.isSaving) return false;
  const previousRating = getItemRating(node.item);
  const nextRating = toggle
    ? getNextRating(previousRating, value)
    : clamp(Math.round(Number(value) || 0), 0, 5);
  if (nextRating === previousRating) return false;
  node.item.star = nextRating;
  refreshNodeRating(node);
  return saveItemMetadata(node, {
    successMessage: nextRating
      ? `已將「${node.item.name || "素材"}」設為 ${nextRating} 顆星。`
      : `已清除「${node.item.name || "素材"}」的評分。`,
    rollback: () => {
      node.item.star = previousRating;
      refreshNodeRating(node);
    },
  });
}

function refreshNodeRating(node) {
  const rating = node.label?.querySelector(".media-rating");
  if (rating) updateRatingControl(rating, node);
  updateSelectionStatus();
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
  state.explorationGeneration += 1;
  state.explorationSource?.clear();
  state.unratedGeneration += 1;
  state.unratedLoading = false;
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  state.unratedSource?.clear();
  updateAutoExploreToggle();
  try {
    if (typeof node.item.save !== "function") throw new Error("素材不支援儲存");
    const result = await node.item.save();
    if (result === false) throw new Error("Eagle 拒絕儲存變更");
    showToast(successMessage, false, METADATA_SUCCESS_TOAST_MS);
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

async function commitNodeTags(node, nextTags, previousTags) {
  node.item.tags = nextTags;
  const tags = node.label?.querySelector(".media-tags");
  if (tags) renderTagChips(tags, nextTags);
  const saved = await saveItemMetadata(node, {
    successMessage: `已更新「${node.item.name || "素材"}」的標籤。`,
    rollback: () => {
      node.item.tags = previousTags;
      const currentTags = node.label?.querySelector(".media-tags");
      if (currentTags) renderTagChips(currentTags, previousTags);
      updateSelectionStatus();
    },
  });
  if (saved) {
    updateSelectionStatus();
    void loadTagColors();
  }
}

async function addSelectedItemToFolder(node, folder) {
  if (!node || node.isSaving) return;
  const folderId = String(folder?.id || "").trim();
  if (!folderId) return;

  const previousFolders = normalizeTags(node.item.folders);
  if (previousFolders.includes(folderId)) {
    showToast(`「${node.item.name || "素材"}」已在該資料夾中。`, false);
    return;
  }

  const nextFolders = [...previousFolders, folderId];
  node.item.folders = nextFolders;
  const saved = await saveItemMetadata(node, {
    successMessage: `已將「${node.item.name || "素材"}」加入「${folder?.name || "資料夾"}」。`,
    rollback: () => {
      node.item.folders = previousFolders;
    },
  });
  if (saved) {
    await loadFolderNames([node.item]);
    updateSelectionStatus();
  }
}

async function loadTagColors() {
  const generation = ++state.tagColorGeneration;
  if (typeof eagle === "undefined" || typeof eagle.tag?.get !== "function") {
    state.tagColors = new Map();
    renderAutoExploreTagOptions();
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
    for (const node of state.mountedLabelNodes) {
      const tags = node.label?.querySelector(".media-tags");
      if (tags) renderTagChips(tags, node.item.tags);
    }
    renderAutoExploreTagOptions();
    updateSelectionStatus();
    tagEditor.refresh();
  } catch (error) {
    if (generation !== state.tagColorGeneration) return;
    state.tagColors = new Map();
    renderAutoExploreTagOptions();
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
  tagEditor.closeForNode(node);
  folderPicker.closeForNode(node);
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
    controlsHeight: getVideoControlsHeight(),
    initialVolume: state.videoVolume,
    onVolumeChange: rememberVideoVolume,
    applyRotation: () => applyMediaRotation(node),
    onLayoutChange: () => {
      positionNode(node);
      updateLabels();
    },
    showToast,
  });
}

function retryOriginalImage(node) {
  if (!node || node.isVideo || !node.item?.fileURL) return;
  const requested = node.retryOriginal?.();
  if (!requested) return;
  node.element?.setAttribute("data-media-quality", "loading-original");
  debugLogMedia(node.item, "original-load-retry-requested", { fileURL: node.item.fileURL });
  showToast("正在重新載入原圖。", false, 1000);
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
    if (hasStartedPanning) {
      finishViewportPan();
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function startViewportPan() {
  cameraNavigation.cancelCameraFocus();
  tagEditor.close();
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
  tagEditor.close();
  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  cameraNavigation.zoomAtPoint(pointerX, pointerY, zoomFactor);
}

function handleKeyDown(event) {
  if (
    event.key === "Escape" &&
    elements.autoExploreSettingsPanel &&
    !elements.autoExploreSettingsPanel.hidden
  ) {
    event.preventDefault();
    closeAutoExploreSettings();
    return;
  }
  if (event.key === "F11") {
    event.preventDefault();
    if (event.repeat) return;
    void toggleFullScreen();
    return;
  }
  if (event.key === "Insert") {
    event.preventDefault();
    if (event.repeat) return;
    toggleUnratedExploration();
    return;
  }
  if (isInteractiveTarget(event.target)) return;

  if (
    event.key === "Delete" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    if (event.repeat) return;
    toggleSeamlessMode();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[1-5]$/.test(event.key)) {
    event.preventDefault();
    if (event.repeat) return;
    void setItemRating(state.selectedNode, Number(event.key));
    return;
  }

  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  ) {
    event.preventDefault();
    if (event.repeat) return;
    void openSelectedFolderPicker();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "t") {
    event.preventDefault();
    if (event.repeat) return;
    openSelectedTagEditor();
    return;
  }

  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    if (event.repeat) return;
    if (event.key === "Home") cameraNavigation.focusSelectedNodeAtRowScale();
    else cameraNavigation.fitSelectedRowInViewport();
    return;
  }

  const arrowAction = getArrowKeyAction(event, {
    playingVideo: isPlayingVideo(state.selectedNode?.videoElement),
  });
  if (arrowAction) {
    event.preventDefault();
    if (arrowAction === "video-control") {
      controlSelectedVideo(event.key);
      return;
    }
    if (arrowAction === "focus-selection") {
      if (event.repeat) return;
      const previousRow = state.rows.find((row) => row.nodes.includes(state.selectedNode));
      const node = selectionNavigation.moveSelection(directionFor(event.key));
      const nextRow = node && state.rows.find((row) => row.nodes.includes(node));
      if (node) cameraNavigation.focusSelectedNodeAtRowScale(node, { crossRow: previousRow !== nextRow });
      return;
    }
    if (arrowAction === "viewport-pan") {
      cameraNavigation.panOneViewport(event.key);
      selectionNavigation.selectNodeAtViewportCenter();
      return;
    }
    const key = event.key.toLowerCase();
    if (state.smoothPanEnabled) {
      cameraNavigation.startSmoothKeyboardPan(key);
      return;
    }
    const panStep = cameraNavigation.getKeyboardPanStep();
    const direction = directionFor(key);
    cameraNavigation.panBy(direction[0] * -panStep, direction[1] * -panStep);
    selectionNavigation.selectNodeAtViewportCenter();
    return;
  }

  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (event.repeat) return;
    void exploreNextRow();
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
    if (state.smoothZoomEnabled) {
      cameraNavigation.startSmoothKeyboardZoom(event.key);
      return;
    }
    const factor = event.key === "PageUp" ? KEYBOARD_ZOOM_FACTOR : 1 / KEYBOARD_ZOOM_FACTOR;
    cameraNavigation.zoomAtPoint(
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
  if (state.smoothPanEnabled) {
    cameraNavigation.startSmoothKeyboardPan(key);
    return;
  }
  const panStep = cameraNavigation.getKeyboardPanStep();
  cameraNavigation.panBy(direction[0] * -panStep, direction[1] * -panStep);
  selectionNavigation.selectNodeAtViewportCenter();
}

async function toggleFullScreen() {
  if (
    typeof eagle === "undefined" ||
    typeof eagle.window?.isFullScreen !== "function" ||
    typeof eagle.window?.setFullScreen !== "function"
  ) {
    showToast("目前無法切換全螢幕模式。", true);
    return;
  }

  try {
    const isFullScreen = await eagle.window.isFullScreen();
    await eagle.window.setFullScreen(!isFullScreen);
    handleResize();
  } catch (error) {
    console.error("Failed to toggle Eagle fullscreen", error);
    showToast(`無法切換全螢幕模式：${error.message || error}`, true);
  }
}

function openSelectedTagEditor() {
  const node = state.selectedNode;
  if (!node || node.isSaving) return;
  folderPicker.close();
  const anchor = state.seamlessMode
    ? node.element
    : node.label?.querySelector(".media-tag-edit") || node.element;
  tagEditor.open(node, anchor);
}

async function openSelectedFolderPicker() {
  const node = state.selectedNode;
  if (!node || node.isSaving) return;
  if (typeof eagle === "undefined" || typeof eagle.folder?.getAll !== "function") {
    showToast("目前的 Eagle 版本不支援搜尋全部資料夾。", true);
    return;
  }

  tagEditor.close();
  try {
    const folders = await eagle.folder.getAll();
    if (node !== state.selectedNode) return;
    const anchor = state.seamlessMode
      ? node.element
      : node.label?.querySelector(".media-tag-edit") || node.element;
    folderPicker.open(node, anchor, folders);
  } catch (error) {
    console.error("Failed to load Eagle folders", error);
    showToast(`無法讀取 Eagle 資料夾：${error.message || error}`, true);
  }
}

function applyClearedSelection(previousNode) {
  folderPicker.closeForNode(previousNode);
  previousNode?.element?.classList.remove("is-selected");
  previousNode?.label?.classList.remove("is-selected");
  updateSelectionStatus();
  updateExploreButton();
}

function applySelectedNode(node, { changed, previousNode }) {
  if (changed) {
    folderPicker.closeForNode(previousNode);
    previousNode?.element?.classList.remove("is-selected");
    previousNode?.label?.classList.remove("is-selected");
    mountMediaCard(node);
    preloadSelectedNode(node);
    node.element.classList.add("is-selected");
    node.label?.classList.add("is-selected");
  }
  updateSelectionStatus();
  updateExploreButton();
}

function preloadSelectedNode(node) {
  const snapshot = mediaLoadQueue.snapshot(node);
  if (
    !snapshot ||
    snapshot.readyQuality ||
    snapshot.loading ||
    snapshot.queued ||
    snapshot.pendingQuality
  ) {
    return;
  }
  node.loadMedia?.("thumbnail");
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
  const generation = state.explorationGeneration;
  state.explorationLoading = true;
  updateExploreButton();
  try {
    const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
    const candidates = await source.findCandidates(pivot, excludedIds);
    if (generation !== state.explorationGeneration || state.nodes !== boardNodes) return;
    const selectedCandidates = selectDiverseExplorationRow(
      candidates,
      pivot,
      Math.random,
      getBoardLayoutWidth(),
      state.maxExplorationItems,
    );
    if (!selectedCandidates.length) {
      showToast(`找不到更多與「${pivot.name || "目前素材"}」相關的素材。`, false);
      return;
    }

    const items = await source.hydrate(selectedCandidates);
    if (generation !== state.explorationGeneration || state.nodes !== boardNodes) return;
    if (!items.length) {
      showToast("相關素材目前無法載入。", true);
      return;
    }

    const pivotRow = state.rows.find((row) => row.nodes.includes(pivotNode));
    if (!pivotRow) return;
    const layoutConfig = getBoardLayoutConfig();
    const layout = insertBoardRow(
      {
        nodes: state.nodes,
        rows: state.rows,
        ...layoutConfig,
      },
      pivotRow,
      items,
      layoutConfig,
    );
    state.nodes = layout.nodes;
    state.rows = layout.rows;
    void loadFolderNames(items);
    for (const node of state.materializedNodes) positionNode(node);
    updateBoardMeta();
    renderAutoExploreTagOptions();
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

async function loadNextUnratedRow({ focus = false } = {}) {
  const source = state.unratedSource;
  if (!state.unratedEnabled || !source || state.unratedLoading || state.unratedExhausted) return;

  const boardNodes = state.nodes;
  const generation = state.unratedGeneration;
  state.unratedLoading = true;
  updateAutoExploreToggle();
  try {
    const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
    const layoutConfig = getBoardLayoutConfig();
    const candidates = await source.findNextRow(
      excludedIds,
      state.unratedFilter,
      layoutConfig.layoutWidth,
      state.maxExplorationItems,
    );
    if (generation !== state.unratedGeneration || state.nodes !== boardNodes) return;
    if (!candidates.length) {
      state.unratedExhausted = true;
      showToast("沒有更多符合目前條件的素材。", false);
      return;
    }

    const items = await source.hydrate(candidates);
    if (generation !== state.unratedGeneration || state.nodes !== boardNodes) return;
    if (!items.length) {
      showToast("符合條件的素材目前無法載入。", true);
      return;
    }

    if (!state.rows.length) {
      const layout = createBoardLayout(items, layoutConfig);
      state.nodes = layout.nodes;
      state.rows = layout.rows;
    } else {
      const layout = insertBoardRow(
        {
          nodes: state.nodes,
          rows: state.rows,
          ...layoutConfig,
        },
        state.rows.at(-1),
        items,
        layoutConfig,
      );
      state.nodes = layout.nodes;
      state.rows = layout.rows;
    }
    void loadFolderNames(items);
    for (const node of state.materializedNodes) positionNode(node);
    updateBoardMeta();
    renderAutoExploreTagOptions();
    updateMediaVisibility();
    updateLabels();
    if (focus) requestAnimationFrame(focusFirstItem);
    showToast(`已加入 ${items.length} 個符合條件的素材。`);
  } catch (error) {
    if (generation !== state.unratedGeneration) return;
    state.lastUnratedTriggerRow = null;
    console.error("Failed to load unrated Eagle items", error);
    showToast(`無法載入未評分素材：${error.message || error}`, true);
  } finally {
    if (generation === state.unratedGeneration) {
      state.unratedLoading = false;
      updateAutoExploreToggle();
    }
  }
}

function maybeLoadNextUnratedRow() {
  const lastRow = state.rows.at(-1);
  if (
    !state.unratedEnabled ||
    !lastRow ||
    lastRow === state.lastUnratedTriggerRow ||
    state.unratedLoading ||
    state.unratedExhausted ||
    !shouldLoadUnratedRow(
      state.rows,
      state.camera,
      { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
      getBaseScale(),
      ORIGINAL_IMAGE_ZOOM,
    )
  ) {
    return;
  }
  state.lastUnratedTriggerRow = lastRow;
  void loadNextUnratedRow();
}

function toggleAutoExploreSettings() {
  const panel = elements.autoExploreSettingsPanel;
  if (!panel) return;
  if (panel.hidden) {
    state.unratedDraftFilter = normalizeUnratedFilter(state.unratedFilter);
    if (elements.autoExploreTagSearch) elements.autoExploreTagSearch.value = "";
    if (elements.autoExploreExcludedTagSearch) {
      elements.autoExploreExcludedTagSearch.value = "";
    }
    updateAutoExploreSettingsUI();
    panel.hidden = false;
    elements.autoExploreSettingsButton?.setAttribute("aria-expanded", "true");
    return;
  }
  closeAutoExploreSettings();
}

function closeAutoExploreSettings() {
  state.unratedDraftFilter = null;
  elements.autoExploreSettingsPanel?.setAttribute("hidden", "");
  elements.autoExploreSettingsButton?.setAttribute("aria-expanded", "false");
}

function handleAutoExploreOutsidePointerDown(event) {
  const panel = elements.autoExploreSettingsPanel;
  if (!panel || panel.hidden) return;
  if (elements.autoExploreControls?.contains(event.target)) return;
  closeAutoExploreSettings();
}

function updateBoardSettings() {
  const nextLayoutDirection = elements.layoutDirection
    ? normalizeLayoutDirection(elements.layoutDirection.value)
    : state.layoutDirection;
  const layoutDirectionChanged = nextLayoutDirection !== state.layoutDirection;
  state.layoutDirection = nextLayoutDirection;
  const nextLayoutWidth = elements.layoutWidth
    ? normalizeBoardLayoutWidth(elements.layoutWidth.value)
    : state.layoutWidth;
  const nextLayoutWidthUnlimited = elements.layoutWidth
    ? nextLayoutWidth >= MAX_LAYOUT_WIDTH
    : state.layoutWidthUnlimited;
  const layoutWidthChanged =
    nextLayoutWidth !== state.layoutWidth ||
    nextLayoutWidthUnlimited !== state.layoutWidthUnlimited;
  state.layoutWidth = nextLayoutWidth;
  state.layoutWidthUnlimited = nextLayoutWidthUnlimited;
  const nextMaxExplorationItems = elements.maxExplorationItems
    ? normalizeMaxExplorationItems(elements.maxExplorationItems.value)
    : state.maxExplorationItems;
  state.maxExplorationItems = nextMaxExplorationItems;
  state.smoothPanEnabled = Boolean(elements.smoothPanToggle?.checked);
  const speed = Number(elements.smoothPanSpeed?.value);
  if (Number.isFinite(speed)) {
    state.smoothPanSpeed = clamp(speed, MIN_SMOOTH_PAN_SPEED, MAX_SMOOTH_PAN_SPEED);
  }
  state.smoothZoomEnabled = Boolean(elements.smoothZoomToggle?.checked);
  const zoomSpeed = Number(elements.smoothZoomSpeed?.value);
  if (Number.isFinite(zoomSpeed)) {
    state.smoothZoomSpeed = clamp(
      zoomSpeed,
      MIN_SMOOTH_ZOOM_SPEED,
      MAX_SMOOTH_ZOOM_SPEED,
    );
  }
  if (elements.focusMediaSize) {
    state.focusMediaSize = normalizeFocusMediaSize(elements.focusMediaSize.value);
  }
  if (!state.smoothPanEnabled) cameraNavigation.stopSmoothKeyboardPan();
  if (!state.smoothZoomEnabled) cameraNavigation.stopSmoothKeyboardZoom();
  saveSettings();
  updateBoardSettingsUI();
  if (layoutDirectionChanged || layoutWidthChanged) relayoutBoard();
}

function updateBoardSettingsUI() {
  if (elements.layoutDirection) elements.layoutDirection.value = state.layoutDirection;
  if (elements.layoutWidth) {
    elements.layoutWidth.value = String(
      state.layoutWidthUnlimited ? MAX_LAYOUT_WIDTH : state.layoutWidth,
    );
    elements.layoutWidth.setAttribute(
      "aria-valuetext",
      state.layoutWidthUnlimited ? "無限" : `${state.layoutWidth} px`,
    );
  }
  if (elements.layoutWidthValue) {
    elements.layoutWidthValue.textContent = state.layoutWidthUnlimited
      ? "無限"
      : `${state.layoutWidth} px`;
  }
  if (elements.maxExplorationItems) {
    elements.maxExplorationItems.value = String(state.maxExplorationItems);
  }
  if (elements.maxExplorationItemsValue) {
    elements.maxExplorationItemsValue.textContent = `${state.maxExplorationItems} 個`;
  }
  if (elements.smoothPanToggle) elements.smoothPanToggle.checked = state.smoothPanEnabled;
  if (elements.smoothPanSpeed) elements.smoothPanSpeed.value = String(state.smoothPanSpeed);
  if (elements.smoothPanSpeedValue) {
    elements.smoothPanSpeedValue.textContent =
      `${state.smoothPanSpeed} px/s · ${cameraNavigation.getKeyboardPanStep()} px/次`;
  }
  if (elements.smoothZoomToggle) elements.smoothZoomToggle.checked = state.smoothZoomEnabled;
  if (elements.smoothZoomSpeed) elements.smoothZoomSpeed.value = String(state.smoothZoomSpeed);
  if (elements.smoothZoomSpeedValue) {
    elements.smoothZoomSpeedValue.textContent = `${state.smoothZoomSpeed.toFixed(2)}×/秒`;
  }
  if (elements.focusMediaSize) {
    elements.focusMediaSize.value = String(state.focusMediaSize);
  }
  if (elements.focusMediaSizeValue) {
    elements.focusMediaSizeValue.textContent = `${state.focusMediaSize} px`;
  }
}

function toggleSeamlessMode() {
  setSeamlessMode(!state.seamlessMode);
}

function setSeamlessMode(enabled) {
  const nextValue = Boolean(enabled);
  const changed = nextValue !== state.seamlessMode;
  state.seamlessMode = nextValue;
  updateSeamlessModeUI();
  saveSettings();
  if (changed) relayoutBoard();
}

function updateSeamlessModeUI() {
  elements.app?.classList.toggle("is-seamless", state.seamlessMode);
  if (!elements.seamlessModeToggle) return;
  elements.seamlessModeToggle.classList.toggle("is-active", state.seamlessMode);
  elements.seamlessModeToggle.setAttribute("aria-checked", String(state.seamlessMode));
  elements.seamlessModeToggle.title = state.seamlessMode
    ? "關閉緊鄰模式（Del）"
    : "開啟緊鄰模式（Del）";
  if (elements.seamlessModeStatus) {
    elements.seamlessModeStatus.textContent = state.seamlessMode ? "開" : "關";
  }
}

function restoreSavedSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) return;
    const saved = JSON.parse(stored);
    const board = saved?.board;
    if (board && typeof board === "object") {
      state.smoothPanEnabled = Boolean(board.smoothPanEnabled);
      state.smoothPanSpeed = normalizeStoredSettingNumber(
        board.smoothPanSpeed,
        MIN_SMOOTH_PAN_SPEED,
        MAX_SMOOTH_PAN_SPEED,
        DEFAULT_SMOOTH_PAN_SPEED,
      );
      state.smoothZoomEnabled = Boolean(board.smoothZoomEnabled);
      state.smoothZoomSpeed = normalizeStoredSettingNumber(
        board.smoothZoomSpeed,
        MIN_SMOOTH_ZOOM_SPEED,
        MAX_SMOOTH_ZOOM_SPEED,
        DEFAULT_SMOOTH_ZOOM_SPEED,
      );
      state.focusMediaSize = normalizeFocusMediaSize(board.focusMediaSize);
      state.layoutDirection = normalizeLayoutDirection(board.layoutDirection);
      state.layoutWidth = normalizeBoardLayoutWidth(board.layoutWidth);
      state.layoutWidthUnlimited = Boolean(board.layoutWidthUnlimited);
      state.seamlessMode = Boolean(board.seamlessMode);
      state.maxExplorationItems = normalizeMaxExplorationItems(board.maxExplorationItems);
    }
    if (saved?.autoExploreFilter && typeof saved.autoExploreFilter === "object") {
      state.unratedFilter = normalizeUnratedFilter(saved.autoExploreFilter);
    }
  } catch (error) {
    console.warn("Failed to restore Bird View settings", error);
  }
}

function saveSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        board: {
          layoutDirection: state.layoutDirection,
          layoutWidth: state.layoutWidth,
          layoutWidthUnlimited: state.layoutWidthUnlimited,
          seamlessMode: state.seamlessMode,
          maxExplorationItems: state.maxExplorationItems,
          smoothPanEnabled: state.smoothPanEnabled,
          smoothPanSpeed: state.smoothPanSpeed,
          smoothZoomEnabled: state.smoothZoomEnabled,
          smoothZoomSpeed: state.smoothZoomSpeed,
          focusMediaSize: state.focusMediaSize,
        },
        autoExploreFilter: state.unratedFilter,
      }),
    );
  } catch (error) {
    console.warn("Failed to save Bird View settings", error);
  }
}

function normalizeStoredSettingNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, minimum, maximum) : fallback;
}

function normalizeLayoutDirection(direction) {
  return direction === "rtl" ? "rtl" : DEFAULT_LAYOUT_DIRECTION;
}

function normalizeBoardLayoutWidth(width) {
  return normalizeStoredSettingNumber(
    width,
    MIN_LAYOUT_WIDTH,
    MAX_LAYOUT_WIDTH,
    DEFAULT_LAYOUT_WIDTH,
  );
}

function normalizeFocusMediaSize(size) {
  const value = Number(size);
  return Number.isFinite(value)
    ? clamp(Math.round(value / 10) * 10, MIN_FOCUS_MEDIA_SIZE, MAX_FOCUS_MEDIA_SIZE)
    : DEFAULT_FOCUS_MEDIA_SIZE;
}

function getBoardLayoutWidth() {
  return state.layoutWidthUnlimited ? Infinity : state.layoutWidth;
}

function getBoardLayoutOptions() {
  return state.seamlessMode
    ? {
        gap: SEAMLESS_LAYOUT_GAP,
        rowGap: SEAMLESS_ROW_GAP,
        videoControlsHeight: 0,
      }
    : {
        gap: LAYOUT_GAP,
        rowGap: ROW_GAP,
        videoControlsHeight: VIDEO_CONTROLS_HEIGHT,
      };
}

function getVideoControlsHeight() {
  return state.seamlessMode ? 0 : VIDEO_CONTROLS_HEIGHT;
}

function getBoardLayoutConfig() {
  return {
    direction: state.layoutDirection,
    layoutWidth: getBoardLayoutWidth(),
    ...getBoardLayoutOptions(),
  };
}

function createBoardLayout(items, config = getBoardLayoutConfig()) {
  return createJustifiedLayout(
    items,
    config.direction,
    config.layoutWidth,
    config,
  );
}

function insertBoardRow(layout, afterRow, items, config = getBoardLayoutConfig()) {
  return insertExplorationRow(
    layout,
    afterRow,
    items,
    config.direction,
    config.layoutWidth,
    config,
  );
}

function normalizeMaxExplorationItems(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? clamp(Math.floor(number), MIN_EXPLORATION_ITEMS, MAX_EXPLORATION_ITEMS)
    : DEFAULT_MAX_EXPLORATION_ITEMS;
}

function updateDraftAutoExploreFileTypes(event) {
  if (!state.unratedDraftFilter) return;
  const fileTypes = [
    ["image", elements.autoExploreFileTypeImage],
    ["video", elements.autoExploreFileTypeVideo],
  ]
    .filter(([, input]) => input?.checked)
    .map(([fileType]) => fileType);
  if (!fileTypes.length) {
    event.target.checked = true;
    return;
  }
  state.unratedDraftFilter.fileTypes = fileTypes;
  applyAutoExploreSettings({ close: false });
}

function updateDraftAutoExploreRating(event) {
  if (!state.unratedDraftFilter) return;
  state.unratedDraftFilter.rating = event.target.value;
  applyAutoExploreSettings({ close: false });
}

function updateDraftAutoExploreTagMatch(event) {
  if (!state.unratedDraftFilter) return;
  state.unratedDraftFilter.tagMatch = event.target.value;
  applyAutoExploreSettings({ close: false });
}

function updateDraftAutoExploreMaxTagCount(event) {
  if (!state.unratedDraftFilter) return;
  const value = Number(event.target.value);
  state.unratedDraftFilter.maxTagCount =
    Number.isInteger(value) && value >= 1 ? value : null;
  applyAutoExploreSettings({ close: false });
}

function handleAutoExploreTagSearchKeyDown(event) {
  selectFirstAutoExploreTagOption(event, elements.autoExploreTagOptions);
}

function handleAutoExploreExcludedTagSearchKeyDown(event) {
  selectFirstAutoExploreTagOption(event, elements.autoExploreExcludedTagOptions);
}

function selectFirstAutoExploreTagOption(event, optionsElement) {
  if (event.key !== "Enter") return;
  const firstOption = optionsElement?.querySelector("button");
  if (!firstOption) return;
  event.preventDefault();
  firstOption.click();
}

function resetAutoExploreSettings() {
  state.unratedDraftFilter = normalizeUnratedFilter(DEFAULT_UNRATED_FILTER);
  if (elements.autoExploreTagSearch) elements.autoExploreTagSearch.value = "";
  if (elements.autoExploreExcludedTagSearch) elements.autoExploreExcludedTagSearch.value = "";
  applyAutoExploreSettings({ close: false });
}

function applyAutoExploreSettings({ close = true } = {}) {
  if (!state.unratedDraftFilter) return;
  const nextFilter = normalizeUnratedFilter(state.unratedDraftFilter);
  const changed = !unratedFiltersEqual(state.unratedFilter, nextFilter);
  state.unratedFilter = nextFilter;
  saveSettings();
  if (close) closeAutoExploreSettings();
  else state.unratedDraftFilter = normalizeUnratedFilter(nextFilter);
  updateAutoExploreSettingsUI();
  if (!changed) return;

  state.unratedGeneration += 1;
  state.unratedLoading = false;
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  state.unratedSource?.clear();
  updateAutoExploreToggle();
  showToast("已更新自動探索條件。", false);
  if (!state.unratedEnabled) return;
  if (!state.rows.length) void loadNextUnratedRow({ focus: true });
  else maybeLoadNextUnratedRow();
}

function renderAutoExploreTagOptions() {
  const filter = state.unratedDraftFilter || state.unratedFilter;
  renderAutoExploreTagPicker({
    searchElement: elements.autoExploreTagSearch,
    optionsElement: elements.autoExploreTagOptions,
    selectedElement: elements.autoExploreSelectedTags,
    selectedTags: filter.tags,
    oppositeTags: filter.excludedTags,
    filterKey: "tags",
  });
  renderAutoExploreTagPicker({
    searchElement: elements.autoExploreExcludedTagSearch,
    optionsElement: elements.autoExploreExcludedTagOptions,
    selectedElement: elements.autoExploreSelectedExcludedTags,
    selectedTags: filter.excludedTags,
    oppositeTags: filter.tags,
    filterKey: "excludedTags",
  });
}

function renderAutoExploreTagPicker({
  searchElement,
  optionsElement,
  selectedElement,
  selectedTags: rawSelectedTags,
  oppositeTags: rawOppositeTags,
  filterKey,
}) {
  const selectedTags = normalizeTags(rawSelectedTags);
  const oppositeTags = normalizeTags(rawOppositeTags);
  renderAutoExploreSelectedTags(selectedElement, selectedTags, filterKey);
  if (!optionsElement) return;
  const query = String(searchElement?.value || "")
    .trim()
    .toLocaleLowerCase();
  const selectedSet = new Set(selectedTags);
  const oppositeSet = new Set(oppositeTags);
  const knownTags = getAutoExploreKnownTags();
  const tags = query
    ? knownTags
        .filter(
          (tag) =>
            !selectedSet.has(tag) &&
            !oppositeSet.has(tag) &&
            tag.toLocaleLowerCase().includes(query),
        )
        .sort((first, second) => first.localeCompare(second))
    : [];

  if (!tags.length) {
    optionsElement.hidden = true;
    optionsElement.replaceChildren();
    if (!query) return;
    const empty = document.createElement("div");
    empty.className = "auto-explore-tag-empty";
    empty.textContent = "找不到符合的 Tag";
    optionsElement.replaceChildren(empty);
    optionsElement.hidden = false;
    return;
  }

  optionsElement.hidden = false;
  optionsElement.replaceChildren(
    ...tags.map((tag) => {
      const option = document.createElement("button");
      const marker = document.createElement("span");
      option.className = "auto-explore-tag-option";
      option.type = "button";
      option.setAttribute("aria-pressed", "false");
      marker.className = "tag-editor-check";
      marker.textContent = "+";
      option.append(marker, createTagChip(tag));
      option.addEventListener("click", () => {
        const draft = state.unratedDraftFilter || normalizeUnratedFilter(state.unratedFilter);
        const nextTags = new Set(normalizeTags(draft[filterKey]));
        const oppositeKey = filterKey === "tags" ? "excludedTags" : "tags";
        nextTags.add(tag);
        state.unratedDraftFilter = {
          ...draft,
          [filterKey]: [...nextTags],
          [oppositeKey]: normalizeTags(draft[oppositeKey]).filter((value) => value !== tag),
        };
        if (searchElement) searchElement.value = "";
        applyAutoExploreSettings({ close: false });
      });
      return option;
    }),
  );
}

function renderAutoExploreSelectedTags(container, tags, filterKey) {
  if (!container) return;
  container.hidden = tags.length === 0;
  container.replaceChildren(
    ...tags.map((tag) => {
      const remove = document.createElement("button");
      const chip = createTagChip(tag);
      const marker = document.createElement("span");
      remove.className = "auto-explore-selected-tag";
      remove.type = "button";
      remove.title = `移除 ${tag}`;
      remove.setAttribute("aria-label", `移除 Tag ${tag}`);
      marker.className = "auto-explore-selected-tag-remove";
      marker.textContent = "×";
      remove.append(chip, marker);
      remove.addEventListener("click", () => {
        const draft = state.unratedDraftFilter || normalizeUnratedFilter(state.unratedFilter);
        state.unratedDraftFilter = {
          ...draft,
          [filterKey]: normalizeTags(draft[filterKey]).filter((value) => value !== tag),
        };
        applyAutoExploreSettings({ close: false });
      });
      return remove;
    }),
  );
}

function getAutoExploreKnownTags() {
  const tags = new Set(state.tagColors.keys());
  for (const node of state.nodes) {
    for (const tag of normalizeTags(node.item.tags)) tags.add(tag);
  }
  return [...tags];
}

function updateAutoExploreSettingsUI() {
  updateBoardSettingsUI();
  const panel = elements.autoExploreSettingsPanel;
  if (!panel) return;
  const filter = state.unratedDraftFilter || state.unratedFilter;
  const fileTypes = new Set(filter.fileTypes);
  if (elements.autoExploreFileTypeImage) {
    elements.autoExploreFileTypeImage.checked = fileTypes.has("image");
  }
  if (elements.autoExploreFileTypeVideo) {
    elements.autoExploreFileTypeVideo.checked = fileTypes.has("video");
  }
  if (elements.autoExploreRating) elements.autoExploreRating.value = String(filter.rating);
  if (elements.autoExploreTagMatch) elements.autoExploreTagMatch.value = filter.tagMatch;
  if (elements.autoExploreMaxTagCount) {
    elements.autoExploreMaxTagCount.value = filter.maxTagCount ?? "";
  }
  renderAutoExploreTagOptions();
}

function toggleUnratedExploration() {
  state.unratedEnabled = !state.unratedEnabled;
  state.lastUnratedTriggerRow = null;
  if (!state.unratedEnabled) {
    state.unratedGeneration += 1;
    state.unratedLoading = false;
    state.unratedExhausted = false;
    state.unratedSource?.clear();
  }
  updateAutoExploreToggle();
  if (!state.unratedEnabled) {
    showToast("已關閉自動探索。", false);
    return;
  }
  showToast("已開啟自動探索。", false);
  if (!state.rows.length) void loadNextUnratedRow({ focus: true });
  else maybeLoadNextUnratedRow();
}

function updateAutoExploreToggle() {
  if (!elements.autoExploreToggle) return;
  elements.autoExploreToggle.disabled = !state.unratedSource;
  if (elements.autoExploreSettingsButton) elements.autoExploreSettingsButton.disabled = false;
  elements.autoExploreToggle.classList.toggle("is-active", state.unratedEnabled);
  elements.autoExploreToggle.classList.toggle("is-loading", state.unratedLoading);
  elements.autoExploreToggle.setAttribute("aria-checked", String(state.unratedEnabled));
  elements.autoExploreToggle.title = state.unratedLoading
    ? "正在載入符合條件的素材"
    : `自動探索目前為${state.unratedEnabled ? "開啟" : "關閉"}`;
  elements.autoExploreStatus.textContent = state.unratedEnabled ? "開" : "關";
}

function updateExploreButton() {
  if (!elements.exploreButton) return;
  elements.exploreButton.disabled =
    state.explorationLoading || !state.explorationSource || !state.selectedNode;
  elements.exploreButton.textContent = state.explorationLoading
    ? "探索中…"
    : "探索下一列";
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
  const node = state.selectedNode;
  const video = node?.videoElement;
  if (!video) return;
  node.revealVideoControls?.();

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
  rememberVideoVolume(video.volume);
  showToast(`音量 ${Math.round(video.volume * 100)}%`, false, 1000);
}

function rememberVideoVolume(volume) {
  const nextVolume = Number(volume);
  if (!Number.isFinite(nextVolume)) return;
  state.videoVolume = clamp(nextVolume, 0, 1);
}

function isInteractiveTarget(target) {
  return (
    typeof Element !== "undefined" &&
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
  const displayHeight = node.mediaHeight + (node.isVideo ? getVideoControlsHeight() : 0);

  state.camera.scale = scale;
  state.camera.x = viewportWidth / 2 - (node.x + node.width / 2) * scale;
  state.camera.y = viewportHeight / 2 - (node.y + displayHeight / 2) * scale;
  updateCamera();
  selectionNavigation.selectNodeAtViewportCenter();
  updateMediaVisibility();
}

function clearBoard() {
  state.selectedItemsGeneration += 1;
  cameraNavigation.cancelCameraFocus();
  tagEditor.close();
  folderPicker.close();
  selectionNavigation.clearSelection();
  releaseAllMediaCards();
  releaseAllMediaLabels();
  state.nodes = [];
  state.rows = [];
  state.lastUnratedTriggerRow = null;
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

async function loadFolderNames(items) {
  const folderIds = [
    ...new Set(items.flatMap((item) => normalizeTags(item.folders))),
  ];
  if (!folderIds.length) return;
  if (typeof eagle === "undefined" || typeof eagle.folder?.getByIds !== "function") {
    return;
  }

  const missingFolderIds = folderIds.filter((id) => !state.folderNames.has(id));
  if (!missingFolderIds.length) return;
  const generation = state.folderNameGeneration;

  try {
    const folders = await eagle.folder.getByIds(missingFolderIds);
    if (generation !== state.folderNameGeneration) return;
    for (const folder of folders || []) {
      const id = String(folder?.id || "").trim();
      const name = String(folder?.name || "").trim();
      if (id && name) state.folderNames.set(id, name);
    }
    updateSelectionStatus();
  } catch (error) {
    console.warn("Failed to load Eagle folder names", error);
  }
}

function updateSelectionStatus() {
  if (!elements.selectionStatus) return;
  const item = state.selectedNode?.item;
  const hasSelection = Boolean(item);
  elements.selectionEmpty.hidden = hasSelection;
  elements.selectionDetails.hidden = !hasSelection;
  if (!item) return;

  const name = item.name || "未命名";
  const dimensions = formatItemDimensions(item);
  const rating = getItemRating(item);
  const tags = normalizeTags(item.tags);
  const folders = normalizeTags(item.folders)
    .map((folderId) => state.folderNames.get(folderId))
    .filter(Boolean);

  elements.selectionName.textContent = name;
  elements.selectionName.title = name;
  elements.selectionDimensions.hidden = !dimensions;
  elements.selectionDimensionsDivider.hidden = !dimensions;
  elements.selectionDimensions.textContent = dimensions;
  elements.selectionRating.replaceChildren(
    ...Array.from({ length: 5 }, (_, index) => {
      const star = document.createElement("span");
      star.className = "media-rating-star";
      star.textContent = "★";
      star.classList.toggle("is-filled", index < rating);
      return star;
    }),
  );
  elements.selectionRating.title = `評分 ${rating} / 5`;
  elements.selectionRating.setAttribute("aria-label", `評分 ${rating} 顆星`);
  elements.selectionTags.hidden = tags.length === 0;
  elements.selectionTagsDivider.hidden = tags.length === 0;
  elements.selectionTags.replaceChildren(...tags.map(createTagChip));
  elements.selectionTags.title = tags.join(", ");
  elements.selectionFolders.hidden = folders.length === 0;
  elements.selectionFoldersDivider.hidden = folders.length === 0;
  elements.selectionFolders.textContent = folders.join(" / ");
  elements.selectionFolders.title = folders.join(" / ");
}

function updateCamera() {
  if (state.cameraFrame !== null) return;
  state.cameraFrame = requestAnimationFrame(renderCamera);
}

function handleResize() {
  tagEditor.close();
  folderPicker.close();
  const previousViewport = state.viewportSize || getViewportSize();
  const previousBaseScale = getBaseScale();
  const nextViewport = getViewportSize();
  refreshBaseScale();
  state.camera = resizeCamera(
    state.camera,
    previousViewport,
    nextViewport,
    previousBaseScale,
    getBaseScale(),
  );
  state.viewportSize = nextViewport;
  updateCamera();
}

function getViewportSize() {
  return {
    width: Math.max(elements.viewport?.clientWidth || 0, 1),
    height: Math.max(elements.viewport?.clientHeight || 0, 1),
  };
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
  if (state.cameraFocusFrame !== null) return;
  state.lastViewportWork = performance.now();
  updateMediaVisibility({ deferCleanup: state.isPanning });
  updateLabels();
  selectionNavigation.selectNodeAtViewportCenter();
  maybeLoadNextUnratedRow();
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
      (state.nodes[0].isVideo ? getVideoControlsHeight() : 0)
    : TARGET_ROW_HEIGHT + getVideoControlsHeight();
  const referenceWidth = state.nodes[0]?.width || TARGET_ROW_HEIGHT * (16 / 10);
  const widthScale = (viewportWidth - padding * 2) / referenceWidth;
  const heightScale = (viewportHeight - padding * 2) / referenceHeight;
  state.baseScale = Math.max(0.01, Math.min(widthScale, heightScale));
}

function showToast(message, isError = false, duration = 3200) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, duration);
}
