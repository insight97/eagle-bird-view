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
  clamp,
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
  isPlayingVideo,
  normalizeTags,
  normalizeTagColor,
  resizeCamera,
  selectDiverseExplorationRow,
  shouldAutoplayVideo,
  shouldLoadUnratedRow,
} = BirdViewCore;
const { createBoardState } = BirdViewBoard;
const { createRowLoadCoordinator } = BirdViewRowLoad;
const { createMediaMaterializer } = BirdViewMaterializer;
const { createAutoExploreSettings } = BirdViewAutoExploreSettings;
const {
  AiSimilarItemSource,
  HybridExplorationSource,
  RelatedItemSource,
  UnratedItemSource,
  unratedFiltersEqual,
} = BirdViewExploration;
const { createSettingsPresetStore } = BirdViewSettingsPresets;
const { FolderItemSource } = BirdViewFolder;
const { FolderPicker } = BirdViewFolderPicker;
const { TagEditor } = BirdViewTagEditor;
const { createCameraNavigation } = BirdViewCamera;
const { createSelectionNavigation } = BirdViewSelection;
const DEFAULT_SMOOTH_PAN_SPEED = 480;
const MIN_SMOOTH_PAN_SPEED = 120;
const MAX_SMOOTH_PAN_SPEED = 6000;
const DEFAULT_SMOOTH_ZOOM_SPEED = 1.5;
const MIN_SMOOTH_ZOOM_SPEED = 1.05;
const MAX_SMOOTH_ZOOM_SPEED = 60;
const KEYBOARD_ACCELERATION_LEVELS = Object.freeze([6, 16, 24]);
const DEFAULT_KEYBOARD_ACCELERATION = 16;
const DEFAULT_FOCUS_MEDIA_SIZE = TARGET_ROW_HEIGHT;
const MIN_FOCUS_MEDIA_SIZE = 80;
const MAX_FOCUS_MEDIA_SIZE = 400;
const DEFAULT_LAYOUT_DIRECTION = "ltr";
const DEFAULT_LAYOUT_WIDTH = LAYOUT_WIDTH;
const DEFAULT_MAX_AI_EXPLORATION_ITEMS = 0;
const MIN_AI_EXPLORATION_ITEMS = 0;
const MAX_AI_EXPLORATION_ITEMS = 12;
const SEAMLESS_LAYOUT_GAP = 0;
const SEAMLESS_ROW_GAP = 0;
const TIGHT_FOCUS_ROW_EMPHASIS = 1.1;
const SETTINGS_STORAGE_KEY = "bird-view-settings";
const KEYBOARD_ZOOM_FACTOR = 1.5;
const KEYBOARD_SEEK_STEP = 5;
const KEYBOARD_VOLUME_STEP = 0.05;
const PAN_START_THRESHOLD = 4;
const CAMERA_SETTLE_DELAY = 200;
// How tall a card has to paint on screen before Eagle's thumbnail stops being
// enough. Measured in screen pixels so the decision does not depend on how the
// row happened to be laid out: a lone selection lands on an unjustified row at
// TARGET_ROW_HEIGHT, a filled row is shorter, and a zoom ratio would compare
// those against different baselines.
const ORIGINAL_IMAGE_MIN_HEIGHT = 320;
const AUTO_EXPLORE_MIN_ZOOM = 0.8;
const RESOURCE_RELEASE_VIEWPORTS = 2;
const GRID_LAYER_OVERFLOW = 768;
const METADATA_SUCCESS_TOAST_MS = 1200;
const FOLDER_LOAD_BATCH_SIZE = 120;

const state = {
  camera: { x: 0, y: 0, scale: 1 },
  baseScale: 1,
  renderedScale: null,
  renderedBaseScale: null,
  gridSize: 24,
  nodes: [],
  rows: [],
  mountedLabelNodes: new Set(),
  labelCamera: null,
  selectedNode: null,
  verticalNavigation: null,
  smoothPanEnabled: false,
  smoothPanSpeed: DEFAULT_SMOOTH_PAN_SPEED,
  smoothZoomEnabled: false,
  smoothZoomSpeed: DEFAULT_SMOOTH_ZOOM_SPEED,
  keyboardAcceleration: DEFAULT_KEYBOARD_ACCELERATION,
  focusMediaSize: DEFAULT_FOCUS_MEDIA_SIZE,
  videoAutoplayEnabled: false,
  layoutDirection: DEFAULT_LAYOUT_DIRECTION,
  layoutWidth: DEFAULT_LAYOUT_WIDTH,
  layoutWidthUnlimited: false,
  seamlessMode: false,
  maxExplorationItems: DEFAULT_MAX_EXPLORATION_ITEMS,
  maxAiExplorationItems: DEFAULT_MAX_AI_EXPLORATION_ITEMS,
  aiExplorationAvailable: false,
  videoVolume: 1,
  smoothPanKeys: new Set(),
  smoothPanFrame: null,
  smoothPanLastTimestamp: null,
  smoothZoomKeys: new Set(),
  smoothZoomFrame: null,
  smoothZoomLastTimestamp: null,
  smoothZoomVelocity: 0,
  isSmoothZooming: false,
  toastTimer: null,
  cameraFrame: null,
  cameraFocusFrame: null,
  cameraSettleTimer: null,
  viewportWorkTimer: null,
  lastViewportWork: -Infinity,
  isPanning: false,
  explorationSource: null,
  explorationLoading: false,
  folderItemSource: null,
  folderItems: [],
  folderItemOffset: 0,
  folderItemLoading: false,
  unratedSource: null,
  unratedEnabled: false,
  unratedLoading: false,
  unratedExhausted: false,
  lastUnratedTriggerRow: null,
  tagColors: new Map(),
  tagColorGeneration: 0,
  folderNames: new Map(),
  folderNameGeneration: 0,
  folderOptions: [],
  folderOptionGeneration: 0,
  viewportSize: null,
  started: false,
  eagleReady: false,
  selectedPresetName: "",
};

const board = createBoardState();
const elements = {};
let cameraNavigation = null;
let selectionNavigation = null;
let mediaMaterializer = null;
let autoExploreSettings = null;
let settingsPresetStore = null;
const rowLoadCoordinator = createRowLoadCoordinator({
  onLoadingChange(channel, isLoading) {
    if (channel === "exploration") {
      state.explorationLoading = isLoading;
      updateExploreButton();
    }
    if (channel === "folder") {
      state.folderItemLoading = isLoading;
      updateFolderLoadMoreUI();
    }
    if (channel === "unrated") {
      state.unratedLoading = isLoading;
      updateAutoExploreToggle();
    }
  },
});
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
  elements.toolbarPresetSelect = document.querySelector("#toolbar-preset-select");
  elements.autoExploreSettingsButton = document.querySelector("#auto-explore-settings-button");
  elements.autoExploreSettingsPanel = document.querySelector("#auto-explore-settings-panel");
  elements.autoExploreMinRating = document.querySelector("#auto-explore-min-rating");
  elements.autoExploreMaxRating = document.querySelector("#auto-explore-max-rating");
  elements.autoExploreFolderMatch = document.querySelector("#auto-explore-folder-match");
  elements.autoExploreIncludeSubfolders = document.querySelector("#auto-explore-include-subfolders");
  elements.autoExploreFolderSearch = document.querySelector("#auto-explore-folder-search");
  elements.autoExploreFolderOptions = document.querySelector("#auto-explore-folder-options");
  elements.autoExploreSelectedFolders = document.querySelector("#auto-explore-selected-folders");
  elements.autoExploreTagGroupMatch = document.querySelector("#auto-explore-tag-group-match");
  elements.autoExploreTagGroups = document.querySelector("#auto-explore-tag-groups");
  elements.autoExploreAddTagGroup = document.querySelector("#auto-explore-add-tag-group");
  elements.settingsPresetSelect = document.querySelector("#settings-preset-select");
  elements.settingsPresetName = document.querySelector("#settings-preset-name");
  elements.settingsPresetSave = document.querySelector("#settings-preset-save");
  elements.settingsPresetUpdate = document.querySelector("#settings-preset-update");
  elements.settingsPresetDelete = document.querySelector("#settings-preset-delete");
  elements.settingsPresetStatus = document.querySelector("#settings-preset-status");
  elements.autoExploreSettingsClose = document.querySelector("#auto-explore-settings-close");
  elements.autoExploreSettingsTabs = Array.from(
    document.querySelectorAll?.("[data-settings-tab]") || [],
  );
  elements.autoExploreSettingsPanels = Array.from(
    document.querySelectorAll?.("[data-settings-panel]") || [],
  );
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
  elements.keyboardAcceleration = document.querySelector("#keyboard-acceleration");
  elements.focusMediaSize = document.querySelector("#focus-media-size");
  elements.focusMediaSizeValue = document.querySelector("#focus-media-size-value");
  elements.videoAutoplayToggle = document.querySelector("#video-autoplay-toggle");
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
  elements.maxAiExplorationItems = document.querySelector("#ai-exploration-max-items");
  elements.maxAiExplorationItemsValue = document.querySelector(
    "#ai-exploration-max-items-value",
  );
  elements.autoExploreFolderSummary = document.querySelector("#auto-explore-folder-summary");
  elements.autoExploreFilterSummary = document.querySelector("#auto-explore-filter-summary");
  elements.exploreButton = document.querySelector("#explore-button");
  elements.folderLoadMoreButton = document.querySelector("#folder-load-more-button");
  elements.toast = document.querySelector("#toast");

  autoExploreSettings = createAutoExploreSettings({
    document,
    elements,
    getKnownTags: getAutoExploreKnownTags,
    getKnownFolders: getAutoExploreKnownFolders,
    createTagChip,
    createFolderChip,
    onFilterChange: handleAutoExploreFilterChange,
    onReset: resetAiExplorationSettings,
  });
  settingsPresetStore = createSettingsPresetStore({
    storage: typeof localStorage === "undefined" ? null : localStorage,
  });

  mediaMaterializer = createMediaMaterializer({
    document,
    window,
    world: elements.world,
    onPositionNode: positionNode,
    onSelectNode: (node) => selectionNavigation.setSelectedNode(node),
    onOpenContextMenu: openMediaContextMenu,
    onLayoutChange: updateLabels,
    getVideoControlsHeight,
    getVideoVolume: () => state.videoVolume,
    onVolumeChange: rememberVideoVolume,
    showToast,
    startVideoPlayer: BirdViewVideo.startVideoPlayer,
  });

  selectionNavigation = createSelectionNavigation({
    state,
    elements,
    getRows: () => board.rows,
    onSelectNode: applySelectedNode,
    onClearSelection: applyClearedSelection,
  });
  cameraNavigation = createCameraNavigation({
    state,
    elements,
    getRows: () => board.rows,
    getBaseScale,
    updateCamera,
    selectNodeAtViewportCenter: () => selectionNavigation.selectNodeAtViewportCenter(),
    onFocusStart: () => elements.labels?.classList.add("is-camera-focus"),
    onFocusEnd: () => {
      elements.labels?.classList.remove("is-camera-focus");
      updateLabels();
    },
    getVideoControlsHeight,
    getFocusRowEmphasis: () =>
      state.seamlessMode ? TIGHT_FOCUS_ROW_EMPHASIS : undefined,
    getFocusTargetHeight: () => state.focusMediaSize,
    onSmoothZoomStart: () => {
      state.isSmoothZooming = true;
      if (state.viewportWorkTimer !== null) {
        window.clearTimeout(state.viewportWorkTimer);
        state.viewportWorkTimer = null;
      }
      elements.labels?.classList.add("is-smooth-zooming");
    },
    onSmoothZoomEnd: () => {
      state.isSmoothZooming = false;
      elements.labels?.classList.remove("is-smooth-zooming");
      flushViewportWork();
    },
  });

  elements.viewport.addEventListener("pointerdown", beginPan);
  elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", (event) => cameraNavigation.handleKeyUp(event.key));
  window.addEventListener("blur", () => cameraNavigation.handleWindowBlur());
  window.addEventListener("resize", handleResize);
  elements.autoExploreToggle.addEventListener("click", toggleUnratedExploration);
  elements.seamlessModeToggle?.addEventListener("click", toggleSeamlessMode);
  elements.folderLoadMoreButton?.addEventListener("click", () => {
    void loadMoreFolderItems();
  });
  elements.layoutDirection?.addEventListener("change", updateBoardSettings);
  elements.layoutWidth?.addEventListener("input", updateBoardSettings);
  elements.maxExplorationItems?.addEventListener("input", updateBoardSettings);
  elements.maxAiExplorationItems?.addEventListener("input", updateBoardSettings);
  elements.smoothPanToggle?.addEventListener("change", updateBoardSettings);
  elements.smoothPanSpeed?.addEventListener("input", updateBoardSettings);
  elements.smoothZoomToggle?.addEventListener("change", updateBoardSettings);
  elements.smoothZoomSpeed?.addEventListener("input", updateBoardSettings);
  elements.keyboardAcceleration?.addEventListener("change", updateBoardSettings);
  elements.focusMediaSize?.addEventListener("input", updateBoardSettings);
  elements.videoAutoplayToggle?.addEventListener("change", updateBoardSettings);
  elements.toolbarPresetSelect?.addEventListener("change", handlePresetSelection);
  elements.settingsPresetSelect?.addEventListener("change", handlePresetSelection);
  elements.settingsPresetSave?.addEventListener("click", saveNewPreset);
  elements.settingsPresetUpdate?.addEventListener("click", updateSelectedPreset);
  elements.settingsPresetDelete?.addEventListener("click", deleteSelectedPreset);
  elements.exploreButton.addEventListener("click", exploreNextRow);
  restoreSavedSettings();
  renderPresetOptions();
  updateSeamlessModeUI();
  updateAutoExploreToggle();
  updateBoardSettingsUI();
  autoExploreSettings.update();
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

  const aiSearch = eagle.extraModule?.aiSearch;
  state.aiExplorationAvailable = typeof aiSearch?.searchByItemId === "function";
  state.explorationSource = new HybridExplorationSource(
    new RelatedItemSource(eagle.item),
    new AiSimilarItemSource(aiSearch),
  );
  state.unratedSource = new UnratedItemSource(eagle.item, eagle.folder, Math.random);
  state.folderItemSource =
    typeof eagle.folder?.getSelected === "function" || typeof eagle.folder?.get === "function"
      ? new FolderItemSource(eagle.item, eagle.folder)
      : null;
  if (typeof eagle.onLibraryChanged === "function") {
    eagle.onLibraryChanged(handleLibraryChanged);
  }
  updateExploreButton();
  updateBoardSettingsUI();
  updateAutoExploreToggle();
  void loadTagColors();
  void loadAutoExploreFolders();
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
  state.folderOptionGeneration += 1;
  state.folderOptions = [];
  state.explorationSource.clear();
  rowLoadCoordinator.invalidate("exploration");
  state.unratedSource.clear();
  rowLoadCoordinator.invalidate("unrated");
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  updateAutoExploreToggle();
  autoExploreSettings.update();
  void loadTagColors();
  void loadAutoExploreFolders();
  showToast("Eagle 資料庫已切換，正在重新載入選取素材。", false);
  void loadSelectedItems();
}

async function loadSelectedItems({ append = false } = {}) {
  if (typeof eagle === "undefined") {
    showToast("目前不在 Eagle 外掛環境中。", true);
    return;
  }

  const result = await rowLoadCoordinator.run("selected", async ({ isCurrent }) => {
    const items = await eagle.item.getSelected();
    if (!isCurrent()) return;

    if (items.length) {
      if (append) {
        resetFolderItemLoad();
        const existingIds = new Set(board.nodes.map(({ item }) => item.id));
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
    if (!isCurrent()) return;
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
  });
  if (result.status === "error") {
    const { error } = result;
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
  if (state.folderItemLoading || state.folderItemOffset >= state.folderItems.length) {
    return { status: "skipped" };
  }
  const source = state.folderItemSource;
  if (!source) return { status: "skipped" };

  const start = state.folderItemOffset;
  const batch = state.folderItems.slice(start, start + FOLDER_LOAD_BATCH_SIZE);
  const result = await rowLoadCoordinator.load("folder", {
    find: async () => batch,
    hydrate: (items) => source.hydrate(items),
    isRelevant: () =>
      state.folderItemSource === source &&
      state.folderItemOffset === start &&
      state.folderItems[start] === batch[0],
  });
  if (result.status !== "success") {
    if (result.status === "error") {
      const { error } = result;
      console.error("Failed to load folder items", error);
      showToast(`無法載入資料夾素材：${error.message || error}`, true);
    }
    return result;
  }

  const { items } = result.value;
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
  return result;
}

function resetFolderItemLoad() {
  rowLoadCoordinator.invalidate("folder");
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
  if (!board.rows.length) {
    renderItems(items);
    requestAnimationFrame(focusFirstItem);
    return;
  }

  board.append(items, getBoardLayoutConfig());
  refreshBoardAfterItems(items);
}

function renderItems(items) {
  tagEditor.close();
  folderPicker.close();
  selectionNavigation.clearSelection();
  mediaMaterializer.releaseAll();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";
  board.replace(items, getBoardLayoutConfig());
  state.lastUnratedTriggerRow = null;
  void loadFolderNames(items);
  autoExploreSettings.update();
  refreshBaseScale();

  updateBoardMeta();
  updateLabels();
}

function refreshBoardAfterItems(items) {
  void loadFolderNames(items);
  mediaMaterializer.reposition();
  updateBoardMeta();
  autoExploreSettings.update();
  updateMediaVisibility();
  updateLabels();
}

function relayoutBoard() {
  if (!board.nodes.length) return;

  const selectedItemId = state.selectedNode?.item?.id;
  const rotations = new Map(
    board.nodes.map((node) => [node.item.id, node.rotation || 0]),
  );
  const items = board.nodes.map(({ item }) => item);

  selectionNavigation.clearSelection();
  mediaMaterializer.releaseAll();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";

  board.relayout(items, getBoardLayoutConfig(), rotations);

  refreshBaseScale();
  updateBoardMeta();
  const selectedNode = board.nodes.find(({ item }) => item.id === selectedItemId);
  if (selectedNode) selectionNavigation.setSelectedNode(selectedNode);
  updateCamera();
  updateMediaVisibility();
  updateLabels();
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

function createFolderChip(folder) {
  const chip = document.createElement("span");
  chip.className = "media-tag folder-filter-tag";
  chip.textContent = folder?.label || folder?.name || folder?.id || "";
  return chip;
}

function createSelectionExploreButton({ type, value, label }) {
  const button = document.createElement("button");
  button.className = `selection-explore-target selection-${type}-target`;
  button.type = "button";
  button.disabled = state.explorationLoading;
  button.title = `從${type === "tag" ? "Tag" : "資料夾"}「${label}」探索素材`;
  button.setAttribute(
    "aria-label",
    `從${type === "tag" ? "Tag" : "資料夾"}「${label}」探索素材`,
  );

  if (type === "tag") {
    button.append(createTagChip(label));
  } else {
    const icon = document.createElement("span");
    icon.className = "selection-folder-mark";
    icon.textContent = "▰";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "selection-folder-label";
    text.textContent = label;
    button.append(icon, text);
  }

  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void exploreFromSelectionTarget({ type, value, label });
  });
  return button;
}

async function saveItemMetadata(node, { rollback, successMessage }) {
  if (node.isSaving) return false;
  node.isSaving = true;
  setLabelSaving(node, true);
  rowLoadCoordinator.invalidate("exploration");
  state.explorationSource?.clear();
  rowLoadCoordinator.invalidate("unrated");
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
    autoExploreSettings.update();
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
    autoExploreSettings.update();
    updateSelectionStatus();
    tagEditor.refresh();
  } catch (error) {
    if (generation !== state.tagColorGeneration) return;
    state.tagColors = new Map();
    autoExploreSettings.update();
    console.warn("Failed to load Eagle tag colors", error);
  }
}

async function loadAutoExploreFolders() {
  const generation = ++state.folderOptionGeneration;
  if (typeof eagle === "undefined" || typeof eagle.folder?.getAll !== "function") {
    state.folderOptions = [];
    autoExploreSettings.update();
    return;
  }

  try {
    const folders = await eagle.folder.getAll();
    if (generation !== state.folderOptionGeneration) return;
    state.folderOptions = flattenFolderOptions(folders);
    autoExploreSettings.update();
  } catch (error) {
    if (generation !== state.folderOptionGeneration) return;
    state.folderOptions = [];
    autoExploreSettings.update();
    console.warn("Failed to load Eagle folders for auto exploration", error);
  }
}

function flattenFolderOptions(folders) {
  const options = [];
  const visited = new Set();
  const visit = (folder, parentPath = "") => {
    const id = String(folder?.id || "").trim();
    if (!id || visited.has(id)) return;
    visited.add(id);
    const name = String(folder?.name || "").trim() || "未命名資料夾";
    const label = parentPath ? `${parentPath} / ${name}` : name;
    options.push({ id, label, name });
    for (const child of folder?.children || []) visit(child, label);
  };
  for (const folder of folders || []) visit(folder);
  return options.sort((first, second) => first.label.localeCompare(second.label));
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
  mediaMaterializer.rotate(node, degrees);
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
        autoExploreSettings.close();
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
      const previousRow = board.rows.find((row) => row.nodes.includes(state.selectedNode));
      const node = selectionNavigation.moveSelection(directionFor(event.key));
      const nextRow = node && board.rows.find((row) => row.nodes.includes(node));
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
  mediaMaterializer.pause(previousNode);
  previousNode?.element?.classList.remove("is-selected");
  previousNode?.label?.classList.remove("is-selected");
  updateSelectionStatus();
  updateExploreButton();
}

function applySelectedNode(node, { changed, previousNode }) {
  if (changed) {
    folderPicker.closeForNode(previousNode);
    mediaMaterializer.pause(previousNode);
    previousNode?.element?.classList.remove("is-selected");
    previousNode?.label?.classList.remove("is-selected");
    mediaMaterializer.mount(node);
    mediaMaterializer.preloadSelected(node);
    node.element.classList.add("is-selected");
    node.label?.classList.add("is-selected");
    syncSelectedVideoAutoplay();
  }
  updateSelectionStatus();
  updateExploreButton();
}

function insertExplorationItemsAfterNode(pivotNode, items) {
  if (!board.insertAfter(pivotNode, items, getBoardLayoutConfig())) return false;
  refreshBoardAfterItems(items);
  return true;
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

  const boardNodes = board.nodes;
  const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
  const result = await rowLoadCoordinator.load("exploration", {
    find: () =>
      source.findCandidates(pivot, excludedIds, {
        aiEnabled: state.maxAiExplorationItems > 0,
        maxAiItems: state.maxAiExplorationItems,
      }),
    select: (candidates) =>
      selectDiverseExplorationRow(
        candidates,
        pivot,
        Math.random,
        getBoardLayoutWidth(),
        state.maxExplorationItems,
        { maxAiItems: state.maxAiExplorationItems },
      ),
    hydrate: (candidates) => source.hydrate(candidates),
    isRelevant: () => board.nodes === boardNodes && state.selectedNode === pivotNode,
  });
  if (result.status === "stale" || result.status === "busy") return;
  if (result.status === "error") {
    const { error } = result;
    console.error("Failed to explore related Eagle items", error);
    showToast(`探索失敗：${error.message || error}`, true);
    return;
  }

  if (result.value.kind === "empty") {
    showToast(`找不到更多與「${pivot.name || "目前素材"}」相關的素材。`, false);
    return;
  }
  const { items } = result.value;
  if (!items.length) {
    showToast("相關素材目前無法載入。", true);
    return;
  }

  if (state.selectedNode !== pivotNode) return;
  if (!insertExplorationItemsAfterNode(pivotNode, items)) return;
  showToast(`已根據「${pivot.name || "目前素材"}」加入 ${items.length} 個相關素材。`);
}

async function exploreFromSelectionTarget({ type, value, label }) {
  const pivotNode = state.selectedNode;
  const source = state.explorationSource;
  if (!pivotNode || !source || state.explorationLoading) return;

  const criterion = type === "tag" ? { tags: [value] } : { folders: [value] };
  const boardNodes = board.nodes;
  const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
  const result = await rowLoadCoordinator.load("exploration", {
    find: () =>
      source.findCandidates(criterion, excludedIds, {
        aiEnabled: state.maxAiExplorationItems > 0,
        maxAiItems: state.maxAiExplorationItems,
      }),
    select: (candidates) =>
      selectDiverseExplorationRow(
        candidates,
        criterion,
        Math.random,
        getBoardLayoutWidth(),
        state.maxExplorationItems,
        { maxAiItems: state.maxAiExplorationItems },
      ),
    hydrate: (candidates) => source.hydrate(candidates),
    isRelevant: () => board.nodes === boardNodes && state.selectedNode === pivotNode,
  });
  if (result.status === "stale" || result.status === "busy") return;
  if (result.status === "error") {
    const { error } = result;
    console.error("Failed to explore selection target", error);
    showToast(`探索「${label}」失敗：${error.message || error}`, true);
    return;
  }

  if (result.value.kind === "empty") {
    showToast(`找不到更多包含「${label}」的素材。`, false);
    return;
  }
  const { items } = result.value;
  if (!items.length) {
    showToast("目標素材目前無法載入。", true);
    return;
  }

  if (!insertExplorationItemsAfterNode(pivotNode, items)) return;
  showToast(`已根據${type === "tag" ? " Tag" : "資料夾"}「${label}」加入 ${items.length} 個素材。`);
}

async function loadNextUnratedRow({ focus = false } = {}) {
  const source = state.unratedSource;
  if (!state.unratedEnabled || !source || state.unratedLoading || state.unratedExhausted) return;

  const boardNodes = board.nodes;
  const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
  const layoutConfig = getBoardLayoutConfig();
  const result = await rowLoadCoordinator.load("unrated", {
    find: () =>
      source.findNextRow(
        excludedIds,
        autoExploreSettings.getFilter(),
        layoutConfig.layoutWidth,
        state.maxExplorationItems,
      ),
    hydrate: (candidates) => source.hydrate(candidates),
    isRelevant: () => board.nodes === boardNodes,
  });
  if (result.status === "stale" || result.status === "busy") return;
  if (result.status === "error") {
    state.lastUnratedTriggerRow = null;
    const { error } = result;
    console.error("Failed to load unrated Eagle items", error);
    showToast(`無法載入未評分素材：${error.message || error}`, true);
    return;
  }

  if (result.value.kind === "empty") {
    state.unratedExhausted = true;
    showToast("沒有更多符合目前條件的素材。", false);
    return;
  }
  const { items } = result.value;
  if (!items.length) {
    showToast("符合條件的素材目前無法載入。", true);
    return;
  }

  board.append(items, layoutConfig);
  refreshBoardAfterItems(items);
  if (focus) requestAnimationFrame(focusFirstItem);
  showToast(`已加入 ${items.length} 個符合條件的素材。`);
}

function maybeLoadNextUnratedRow() {
  const lastRow = board.rows.at(-1);
  if (
    !state.unratedEnabled ||
    !lastRow ||
    lastRow === state.lastUnratedTriggerRow ||
    state.unratedLoading ||
    state.unratedExhausted ||
    !shouldLoadUnratedRow(
      board.rows,
      state.camera,
      { width: elements.viewport.clientWidth, height: elements.viewport.clientHeight },
      getBaseScale(),
      AUTO_EXPLORE_MIN_ZOOM,
    )
  ) {
    return;
  }
  state.lastUnratedTriggerRow = lastRow;
  void loadNextUnratedRow();
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
  const nextMaxAiExplorationItems = elements.maxAiExplorationItems
    ? normalizeMaxAiExplorationItems(elements.maxAiExplorationItems.value)
    : state.maxAiExplorationItems;
  const aiExplorationSettingsChanged =
    nextMaxAiExplorationItems !== state.maxAiExplorationItems;
  state.maxAiExplorationItems = nextMaxAiExplorationItems;
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
  if (elements.keyboardAcceleration) {
    state.keyboardAcceleration = normalizeKeyboardAcceleration(
      elements.keyboardAcceleration.value,
    );
  }
  if (elements.focusMediaSize) {
    state.focusMediaSize = normalizeFocusMediaSize(elements.focusMediaSize.value);
  }
  state.videoAutoplayEnabled = Boolean(elements.videoAutoplayToggle?.checked);
  if (!state.smoothPanEnabled) cameraNavigation.stopSmoothKeyboardPan();
  if (!state.smoothZoomEnabled) cameraNavigation.stopSmoothKeyboardZoom();
  saveSettings();
  updateBoardSettingsUI();
  syncSelectedVideoAutoplay();
  if (aiExplorationSettingsChanged) {
    rowLoadCoordinator.invalidate("exploration");
    state.explorationSource?.clear();
  }
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
  if (elements.maxAiExplorationItems) {
    elements.maxAiExplorationItems.value = String(state.maxAiExplorationItems);
    elements.maxAiExplorationItems.disabled = !state.aiExplorationAvailable;
  }
  if (elements.maxAiExplorationItemsValue) {
    elements.maxAiExplorationItemsValue.textContent = state.maxAiExplorationItems > 0
      ? `${state.maxAiExplorationItems} 個`
      : "關閉";
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
  if (elements.keyboardAcceleration) {
    elements.keyboardAcceleration.value = String(state.keyboardAcceleration);
  }
  if (elements.focusMediaSize) {
    elements.focusMediaSize.value = String(state.focusMediaSize);
  }
  if (elements.focusMediaSizeValue) {
    elements.focusMediaSizeValue.textContent = `${state.focusMediaSize} px`;
  }
  if (elements.videoAutoplayToggle) {
    elements.videoAutoplayToggle.checked = state.videoAutoplayEnabled;
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

function getSettingsSnapshot() {
  return {
    version: 1,
    unratedEnabled: state.unratedEnabled,
    board: {
      layoutDirection: state.layoutDirection,
      layoutWidth: state.layoutWidth,
      layoutWidthUnlimited: state.layoutWidthUnlimited,
      seamlessMode: state.seamlessMode,
      maxExplorationItems: state.maxExplorationItems,
      aiExplorationEnabled: state.maxAiExplorationItems > 0,
      maxAiExplorationItems: state.maxAiExplorationItems,
      smoothPanEnabled: state.smoothPanEnabled,
      smoothPanSpeed: state.smoothPanSpeed,
      smoothZoomEnabled: state.smoothZoomEnabled,
      smoothZoomSpeed: state.smoothZoomSpeed,
      keyboardAcceleration: state.keyboardAcceleration,
      focusMediaSize: state.focusMediaSize,
      videoAutoplayEnabled: state.videoAutoplayEnabled,
    },
    autoExploreFilter: autoExploreSettings.getFilter(),
  };
}

function applySettingsSnapshotValues(settings, { restoreAutoExploreState = false } = {}) {
  if (restoreAutoExploreState && typeof settings?.unratedEnabled === "boolean") {
    state.unratedEnabled = settings.unratedEnabled;
  }
  const board = settings?.board;
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
    state.keyboardAcceleration = normalizeKeyboardAcceleration(
      board.keyboardAcceleration ?? board.smoothZoomAcceleration,
    );
    state.focusMediaSize = normalizeFocusMediaSize(board.focusMediaSize);
    state.videoAutoplayEnabled = Boolean(board.videoAutoplayEnabled);
    state.layoutDirection = normalizeLayoutDirection(board.layoutDirection);
    state.layoutWidth = normalizeBoardLayoutWidth(board.layoutWidth);
    state.layoutWidthUnlimited = Boolean(board.layoutWidthUnlimited);
    state.seamlessMode = Boolean(board.seamlessMode);
    state.maxExplorationItems = normalizeMaxExplorationItems(board.maxExplorationItems);
    const configuredMaxAiExplorationItems = normalizeMaxAiExplorationItems(
      board.maxAiExplorationItems,
    );
    state.maxAiExplorationItems = board.aiExplorationEnabled === false
      ? 0
      : configuredMaxAiExplorationItems;
  }
  if (settings?.autoExploreFilter && typeof settings.autoExploreFilter === "object") {
    autoExploreSettings.setFilter(settings.autoExploreFilter);
  }
}

function applySettingsSnapshot(settings, { persist = true } = {}) {
  const previous = getSettingsSnapshot();
  applySettingsSnapshotValues(settings, { restoreAutoExploreState: true });
  const next = getSettingsSnapshot();
  const layoutChanged =
    previous.board.layoutDirection !== next.board.layoutDirection ||
    previous.board.layoutWidth !== next.board.layoutWidth ||
    previous.board.layoutWidthUnlimited !== next.board.layoutWidthUnlimited ||
    previous.board.seamlessMode !== next.board.seamlessMode;
  const aiExplorationSettingsChanged =
    previous.board.maxAiExplorationItems !== next.board.maxAiExplorationItems;
  const autoExploreFilterChanged = !unratedFiltersEqual(
    previous.autoExploreFilter,
    next.autoExploreFilter,
  );
  const autoExploreStateChanged = previous.unratedEnabled !== next.unratedEnabled;

  if (!state.smoothPanEnabled) cameraNavigation.stopSmoothKeyboardPan();
  if (!state.smoothZoomEnabled) cameraNavigation.stopSmoothKeyboardZoom();
  if (previous.board.videoAutoplayEnabled !== next.board.videoAutoplayEnabled) {
    syncSelectedVideoAutoplay();
  }
  updateSeamlessModeUI();
  updateBoardSettingsUI();
  autoExploreSettings.update();

  if (aiExplorationSettingsChanged) {
    rowLoadCoordinator.invalidate("exploration");
    state.explorationSource?.clear();
  }
  if (autoExploreStateChanged && !next.unratedEnabled) {
    rowLoadCoordinator.invalidate("unrated");
    state.unratedExhausted = false;
    state.lastUnratedTriggerRow = null;
    state.unratedSource?.clear();
  }
  if (autoExploreFilterChanged) {
    rowLoadCoordinator.invalidate("unrated");
    state.unratedExhausted = false;
    state.lastUnratedTriggerRow = null;
    state.unratedSource?.clear();
  }
  if (autoExploreStateChanged || autoExploreFilterChanged) {
    updateAutoExploreToggle();
  }
  if (layoutChanged) relayoutBoard();
  if (persist) saveSettings();

  if ((autoExploreStateChanged || autoExploreFilterChanged) && state.unratedEnabled) {
    if (!board.rows.length) void loadNextUnratedRow({ focus: true });
    else maybeLoadNextUnratedRow();
  }
}

function restoreSavedSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) return;
    const saved = JSON.parse(stored);
    applySettingsSnapshotValues(saved);
  } catch (error) {
    console.warn("Failed to restore Bird View settings", error);
  }
}

function saveSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(getSettingsSnapshot()));
  } catch (error) {
    console.warn("Failed to save Bird View settings", error);
  }
}

function renderPresetOptions() {
  const selects = [elements.settingsPresetSelect, elements.toolbarPresetSelect].filter(Boolean);
  if (!selects.length || !settingsPresetStore) return;

  const presets = settingsPresetStore.list();
  const selectedName = presets.some((preset) => preset.name === state.selectedPresetName)
    ? state.selectedPresetName
    : "";
  state.selectedPresetName = selectedName;
  for (const select of selects) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "選擇 preset…";
    select.replaceChildren(
      placeholder,
      ...presets.map((preset) => {
        const option = document.createElement("option");
        option.value = preset.name;
        option.textContent = preset.name;
        return option;
      }),
    );
    select.value = selectedName;
  }
  if (elements.toolbarPresetSelect) {
    elements.toolbarPresetSelect.disabled = !presets.length;
  }
  if (elements.settingsPresetName && selectedName) {
    elements.settingsPresetName.value = selectedName;
  }
  updatePresetControls();
}

function updatePresetControls() {
  const hasSelectedPreset = Boolean(state.selectedPresetName);
  if (elements.settingsPresetUpdate) {
    elements.settingsPresetUpdate.disabled = !hasSelectedPreset;
  }
  if (elements.settingsPresetDelete) {
    elements.settingsPresetDelete.disabled = !hasSelectedPreset;
  }
}

function setPresetStatus(message, { error = false } = {}) {
  if (!elements.settingsPresetStatus) return;
  elements.settingsPresetStatus.textContent = message;
  elements.settingsPresetStatus.classList.toggle("is-error", error);
}

function handlePresetSelection(event) {
  const source = event?.currentTarget || event?.target;
  const name = String(
    source
      ? source.value || ""
      : elements.settingsPresetSelect?.value || elements.toolbarPresetSelect?.value || "",
  );
  if (!name) {
    state.selectedPresetName = "";
    if (elements.settingsPresetName) elements.settingsPresetName.value = "";
    renderPresetOptions();
    updatePresetControls();
    setPresetStatus("");
    return;
  }

  const preset = settingsPresetStore?.get(name);
  if (!preset) {
    renderPresetOptions();
    setPresetStatus("找不到這個 preset，請重新選擇。", { error: true });
    return;
  }

  state.selectedPresetName = preset.name;
  if (elements.settingsPresetName) elements.settingsPresetName.value = preset.name;
  applySettingsSnapshot(preset.settings);
  renderPresetOptions();
  updatePresetControls();
  setPresetStatus(`已套用「${preset.name}」。`);
}

function saveNewPreset() {
  const name = String(elements.settingsPresetName?.value || "").trim();
  const result = settingsPresetStore?.save(name, getSettingsSnapshot());
  if (!result?.ok) {
    setPresetStatus(getPresetErrorMessage(result?.error), { error: true });
    return;
  }

  state.selectedPresetName = result.preset.name;
  if (elements.settingsPresetName) elements.settingsPresetName.value = result.preset.name;
  renderPresetOptions();
  setPresetStatus(`已儲存「${result.preset.name}」。`);
  showToast(`已儲存 preset「${result.preset.name}」。`, false);
}

function updateSelectedPreset() {
  const name = state.selectedPresetName || String(elements.settingsPresetSelect?.value || "");
  if (!name) {
    setPresetStatus("請先選擇要更新的 preset。", { error: true });
    return;
  }

  const result = settingsPresetStore?.update(name, getSettingsSnapshot());
  if (!result?.ok) {
    setPresetStatus(getPresetErrorMessage(result?.error), { error: true });
    return;
  }

  state.selectedPresetName = result.preset.name;
  renderPresetOptions();
  setPresetStatus(`已更新「${result.preset.name}」。`);
  showToast(`已更新 preset「${result.preset.name}」。`, false);
}

function deleteSelectedPreset() {
  const name = state.selectedPresetName || String(elements.settingsPresetSelect?.value || "");
  if (!name) {
    setPresetStatus("請先選擇要刪除的 preset。", { error: true });
    return;
  }
  if (typeof window.confirm === "function" && !window.confirm(`確定要刪除 preset「${name}」嗎？`)) {
    return;
  }

  const result = settingsPresetStore?.remove(name);
  if (!result?.ok) {
    setPresetStatus(getPresetErrorMessage(result?.error), { error: true });
    return;
  }

  state.selectedPresetName = "";
  if (elements.settingsPresetName) elements.settingsPresetName.value = "";
  renderPresetOptions();
  setPresetStatus(`已刪除「${result.preset.name}」。`);
  showToast(`已刪除 preset「${result.preset.name}」。`, false);
}

function getPresetErrorMessage(error) {
  switch (error) {
    case "invalid-name":
      return "請輸入 preset 名稱。";
    case "duplicate-name":
      return "這個名稱已存在，請改用其他名稱或按「更新」。";
    case "limit-reached":
      return "Preset 已達上限，請先整理現有 preset。";
    case "not-found":
      return "找不到這個 preset，請重新選擇。";
    default:
      return "Preset 儲存失敗，請稍後再試。";
  }
}

function handleAutoExploreFilterChange(nextFilter, { changed }) {
  saveSettings();
  if (!changed) return;
  rowLoadCoordinator.invalidate("unrated");
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  state.unratedSource?.clear();
  updateAutoExploreToggle();
  showToast("已更新自動探索條件。", false);
  if (!state.unratedEnabled) return;
  if (!board.rows.length) void loadNextUnratedRow({ focus: true });
  else maybeLoadNextUnratedRow();
}

function resetAiExplorationSettings() {
  state.maxAiExplorationItems = 0;
  rowLoadCoordinator.invalidate("exploration");
  state.explorationSource?.clear();
  updateBoardSettingsUI();
  saveSettings();
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

function normalizeKeyboardAcceleration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_KEYBOARD_ACCELERATION;
  return KEYBOARD_ACCELERATION_LEVELS.reduce((closest, candidate) =>
    Math.abs(candidate - number) < Math.abs(closest - number) ? candidate : closest,
  );
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

function normalizeMaxExplorationItems(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? clamp(Math.floor(number), MIN_EXPLORATION_ITEMS, MAX_EXPLORATION_ITEMS)
    : DEFAULT_MAX_EXPLORATION_ITEMS;
}

function normalizeMaxAiExplorationItems(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? clamp(Math.floor(number), MIN_AI_EXPLORATION_ITEMS, MAX_AI_EXPLORATION_ITEMS)
    : DEFAULT_MAX_AI_EXPLORATION_ITEMS;
}

function getAutoExploreKnownTags() {
  const tags = new Set(state.tagColors.keys());
  for (const node of board.nodes) {
    for (const tag of normalizeTags(node.item.tags)) tags.add(tag);
  }
  return [...tags];
}

function getAutoExploreKnownFolders() {
  const folders = new Map(state.folderOptions.map((folder) => [folder.id, folder]));
  for (const node of board.nodes) {
    for (const folderId of normalizeTags(node.item.folders)) {
      if (!folders.has(folderId)) {
        folders.set(folderId, {
          id: folderId,
          label: state.folderNames.get(folderId) || folderId,
        });
      }
    }
  }
  return [...folders.values()];
}

function toggleUnratedExploration() {
  state.unratedEnabled = !state.unratedEnabled;
  state.lastUnratedTriggerRow = null;
  if (!state.unratedEnabled) {
    rowLoadCoordinator.invalidate("unrated");
    state.unratedExhausted = false;
    state.unratedSource?.clear();
  }
  updateAutoExploreToggle();
  if (!state.unratedEnabled) {
    showToast("已關閉自動探索。", false);
    return;
  }
  showToast("已開啟自動探索。", false);
  if (!board.rows.length) void loadNextUnratedRow({ focus: true });
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
  for (const button of elements.selectionStatus?.querySelectorAll(
    ".selection-explore-target",
  ) || []) {
    button.disabled = state.explorationLoading;
  }
}

function syncSelectedVideoAutoplay() {
  const node = state.selectedNode;
  if (!state.videoAutoplayEnabled || !node?.isVideo) return;

  if (shouldAutoplayVideo(node, state.camera.scale)) {
    mediaMaterializer.play(node);
  } else {
    mediaMaterializer.pause(node);
  }
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
  const node = board.nodes[0];
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
  rowLoadCoordinator.invalidate("selected");
  cameraNavigation.cancelCameraFocus();
  tagEditor.close();
  folderPicker.close();
  selectionNavigation.clearSelection();
  mediaMaterializer.releaseAll();
  releaseAllMediaLabels();
  board.clear();
  state.lastUnratedTriggerRow = null;
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
  const count = board.nodes.length;
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
    .map((folderId) => ({
      id: folderId,
      name: state.folderNames.get(folderId),
    }))
    .filter(({ name }) => name);

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
  elements.selectionTags.replaceChildren(
    ...tags.map((tag) =>
      createSelectionExploreButton({ type: "tag", value: tag, label: tag }),
    ),
  );
  elements.selectionTags.title = tags.join(", ");
  elements.selectionFolders.hidden = folders.length === 0;
  elements.selectionFoldersDivider.hidden = folders.length === 0;
  elements.selectionFolders.replaceChildren(
    ...folders.map(({ id, name }) =>
      createSelectionExploreButton({ type: "folder", value: id, label: name }),
    ),
  );
  elements.selectionFolders.title = folders.map(({ name }) => name).join(" / ");
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
  keepCameraLayerPromoted();
  if (scaleChanged || baseScaleChanged) {
    elements.zoomLabel.textContent = `${Math.round((state.camera.scale / getBaseScale()) * 100)}%`;
    state.renderedBaseScale = state.baseScale;
  }
  if (scaleChanged) syncSelectedVideoAutoplay();
  const gridTranslation = getWrappedGridTranslation(
    state.camera,
    state.gridSize,
    GRID_LAYER_OVERFLOW,
  );
  elements.grid.style.transform = `translate3d(${gridTranslation.x}px, ${gridTranslation.y}px, 0)`;
  if (!state.isSmoothZooming) {
    if (scaleChanged && state.cameraFocusFrame === null) updateMountedLabelPositions();
    else updateLabelLayerTransform();
  }
  scheduleViewportWork();
}

// A standing will-change hint keeps the board on its own compositor layer, but
// it also pins the raster scale: after zooming in, the layer keeps painting the
// bitmap it rastered at the old scale, so even a fully loaded original looks
// soft. Hold the hint only while the camera is moving and drop it once it
// settles, which lets the compositor re-raster at the scale actually on screen.
function keepCameraLayerPromoted() {
  elements.world.classList.add("is-moving");
  window.clearTimeout(state.cameraSettleTimer);
  state.cameraSettleTimer = window.setTimeout(() => {
    state.cameraSettleTimer = null;
    elements.world.classList.remove("is-moving");
  }, CAMERA_SETTLE_DELAY);
}

function scheduleViewportWork() {
  // Pointer movement should stay on the camera transform path. Mounting,
  // releasing, relabelling, and auto-exploring happen once the gesture ends.
  if (state.isPanning || state.isSmoothZooming || state.viewportWorkTimer !== null) return;
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
  if (state.isPanning || state.isSmoothZooming) return;
  if (state.cameraFocusFrame !== null) return;
  state.lastViewportWork = performance.now();
  updateMediaVisibility();
  updateLabels();
  selectionNavigation.selectNodeAtViewportCenter();
  maybeLoadNextUnratedRow();
}

function updateMediaVisibility() {
  const preloadMargin = 120;
  const viewportWidth = elements.viewport.clientWidth;
  const viewportHeight = elements.viewport.clientHeight;
  const scale = state.camera.scale;
  const mountMargin = Math.max(viewportWidth, viewportHeight);
  const visibleNodes = getNodesNearViewport(mountMargin);
  const retainedNodes = new Set(
    getNodesNearViewport(mountMargin * RESOURCE_RELEASE_VIEWPORTS),
  );
  const loadNodes = [];
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

    if (isNearViewport) loadNodes.push(node);
  }

  mediaMaterializer.sync({
    visibleNodes,
    retainedNodes,
    loadNodes,
    selectedNode: state.selectedNode,
    getQuality: (node) => (wantsOriginalImage(node, scale) ? "original" : "thumbnail"),
  });
}

function wantsOriginalImage(node, scale) {
  return !node.isVideo && node.mediaHeight * scale >= ORIGINAL_IMAGE_MIN_HEIGHT;
}

function getNodesNearViewport(screenMargin) {
  return findNodesNearViewport(
    board.rows,
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
  const referenceHeight = board.nodes.length
    ? board.nodes[0].mediaHeight +
      (board.nodes[0].isVideo ? getVideoControlsHeight() : 0)
    : TARGET_ROW_HEIGHT + getVideoControlsHeight();
  const referenceWidth = board.nodes[0]?.width || TARGET_ROW_HEIGHT * (16 / 10);
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
