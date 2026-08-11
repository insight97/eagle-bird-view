"use strict";

const {
  LAYOUT_GAP,
  ROW_GAP,
  TARGET_ROW_HEIGHT,
  VIDEO_CONTROLS_HEIGHT,
  clamp,
  directionFor,
  findNodesNearViewport,
  formatFileSize,
  formatItemDimensions,
  getAiExplorationItemLimit,
  getArrowKeyAction,
  getItemRating,
  getNextRating,
  getLabelDetailLevel,
  getLabelRect,
  getNodeScreenCenter,
  getNodeScreenLongEdge,
  getPanLayerTranslation,
  getWrappedGridTranslation,
  getTagColorStyle,
  isPlayingVideo,
  isPdfItem,
  isPdfPageNode,
  isPlayableNode,
  normalizeTags,
  normalizeTagColor,
  reanchorCameraToNode,
  resizeCamera,
  selectExplorationRow,
  shouldAutoplayVideo,
  shouldLoadUnratedRow,
} = BirdViewCore;
const { createBoardState } = BirdViewBoard;
const { createBoardHistory } = BirdViewBoardHistory;
const { createRowLoadCoordinator } = BirdViewRowLoad;
const { createMediaMaterializer } = BirdViewMaterializer;
const { createViewportMediaController } = BirdViewViewportMedia;
const { createAutoExploreSettings } = BirdViewAutoExploreSettings;
const {
  AiSimilarItemSource,
  HybridExplorationSource,
  RelatedItemSource,
  UnratedItemSource,
  unratedFiltersEqual,
} = BirdViewExploration;
const { createSettingsPresetStore } = BirdViewSettingsPresets;
const {
  DEFAULT_SETTINGS_SNAPSHOT,
  SETTINGS_LIMITS,
  createSettingsSnapshotStore,
} = BirdViewSettingsSnapshot;
const { FolderItemSource } = BirdViewFolder;
const { createFolderContentIntake } = BirdViewFolderContent;
const { createLibraryContentTarget } = BirdViewLibraryContent;
const { createFolderBrowser } = BirdViewFolderBrowser;
const { FolderPicker } = BirdViewFolderPicker;
const { TagEditor } = BirdViewTagEditor;
const { SelectionTagOverflow, getVisibleTagCount } = BirdViewSelectionTags;
const { createVideoThumbnailService } = BirdViewVideoThumbnail;
const { createCameraNavigation } = BirdViewCamera;
const { createSelectionNavigation } = BirdViewSelection;
const { createMetadataCommitter } = BirdViewMetadata;
const { createPdfRuntime } = BirdViewPdfRuntime;
const { createPdfBoardSession } = BirdViewPdfBoard;
const SEAMLESS_LAYOUT_GAP = 0;
const SEAMLESS_ROW_GAP = 0;
const TIGHT_FOCUS_ROW_EMPHASIS = 1.1;
const KEYBOARD_ZOOM_FACTOR = 1.5;
const KEYBOARD_SEEK_STEP = 5;
const KEYBOARD_VOLUME_STEP = 0.05;
const PAN_START_THRESHOLD = 4;
const AUTO_EXPLORE_MIN_ZOOM = 0.8;
const GRID_LAYER_OVERFLOW = 768;
const METADATA_SUCCESS_TOAST_MS = 1200;
const BOARD_HISTORY_MAX_ENTRIES = 10;
const BOARD_HISTORY_MAX_ITEMS = 5000;
const metadataCommitter = createMetadataCommitter({
  maxConcurrent: 4,
  onChange: refreshCommittedMetadata,
  onSavingChange: setLabelSaving,
  invalidateSources: invalidateMetadataSources,
  onComplete: updateSelectionStatus,
});
const VIDEO_THUMBNAIL_UNAVAILABLE_MESSAGES = Object.freeze({
  "item-api-unavailable": "目前取得的 Eagle 素材物件不支援自訂影片縮圖。",
  "runtime-unavailable": "外掛執行環境缺少建立暫存檔案所需的功能。",
  "canvas-unavailable": "目前 Eagle 視窗無法使用 Canvas 擷取影片畫面。",
  "temp-directory-unavailable": "無法取得 Eagle 暫存資料夾。",
});
const VIDEO_THUMBNAIL_RUNTIME_CAPABILITY_LABELS = Object.freeze({
  "document.createElement": "Canvas",
  "temp-directory-provider": "暫存路徑 API",
  "path.join": "path.join",
  "fs.writeFile": "檔案寫入 API",
  "fs.unlink": "檔案清理 API",
});

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
  selectedNodes: new Set(),
  selectionAnchor: null,
  verticalNavigation: null,
  smoothPanEnabled: false,
  smoothPanSpeed: DEFAULT_SETTINGS_SNAPSHOT.board.smoothPanSpeed,
  smoothZoomEnabled: false,
  smoothZoomSpeed: DEFAULT_SETTINGS_SNAPSHOT.board.smoothZoomSpeed,
  keyboardAcceleration: DEFAULT_SETTINGS_SNAPSHOT.board.keyboardAcceleration,
  focusMediaSize: DEFAULT_SETTINGS_SNAPSHOT.board.focusMediaSize,
  videoAutoplayEnabled: false,
  layoutDirection: DEFAULT_SETTINGS_SNAPSHOT.board.layoutDirection,
  layoutWidth: DEFAULT_SETTINGS_SNAPSHOT.board.layoutWidth,
  layoutWidthUnlimited: false,
  seamlessMode: false,
  maxExplorationItems: DEFAULT_SETTINGS_SNAPSHOT.board.maxExplorationItems,
  aiExplorationRatio: DEFAULT_SETTINGS_SNAPSHOT.board.aiExplorationRatio,
  aiSimilarityMax: DEFAULT_SETTINGS_SNAPSHOT.board.aiSimilarityMax,
  explorationDiversityStrength: DEFAULT_SETTINGS_SNAPSHOT.board.explorationDiversityStrength,
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
  isPanning: false,
  suppressNextMediaClick: false,
  explorationSource: null,
  explorationLoading: false,
  folderItemSource: null,
  folderContentIntake: null,
  libraryContentTarget: null,
  unratedSource: null,
  unratedEnabled: false,
  unratedLoading: false,
  unratedExhausted: false,
  lastUnratedTriggerRow: null,
  tagColors: new Map(),
  tagColorGeneration: 0,
  selectionTags: [],
  selectionTagButtons: [],
  selectionTagOverflowButton: null,
  folderNames: new Map(),
  folderNameGeneration: 0,
  folderTree: [],
  folderOptions: [],
  folderOptionGeneration: 0,
  viewportSize: null,
  started: false,
  eagleReady: false,
  selectedPresetName: "",
};

const board = createBoardState();
const boardHistory = createBoardHistory({
  maxEntries: BOARD_HISTORY_MAX_ENTRIES,
  maxItems: BOARD_HISTORY_MAX_ITEMS,
});
const elements = {};
let cameraNavigation = null;
let selectionNavigation = null;
let mediaMaterializer = null;
let viewportMedia = null;
let autoExploreSettings = null;
let settingsPresetStore = null;
let settingsSnapshotStore = null;
let folderBrowser = null;
let videoThumbnailService = null;
let pdfBoardSession = null;
const pdfRuntime = createPdfRuntime({
  pdfjsLib: typeof pdfjsLib === "undefined" ? null : pdfjsLib,
  document: typeof document === "undefined" ? null : document,
  baseURI: typeof document === "undefined" ? "" : document.baseURI,
  readFile: readPdfFile,
});
const rowLoadCoordinator = createRowLoadCoordinator({
  onLoadingChange(channel, isLoading) {
    if (channel === "exploration") {
      state.explorationLoading = isLoading;
      updateExploreButton();
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
  onCommit: commitTagChanges,
});
const folderPicker = new FolderPicker({
  getViewport: () => elements.viewport,
  onSelectNode: (node) => selectionNavigation.setSelectedNode(node),
  onCommit: commitFolderChanges,
  onEmpty: () => showToast("目前沒有可用的 Eagle 資料夾。", false),
});
const selectionTagOverflow = new SelectionTagOverflow({
  getViewport: () => elements.viewport,
  createTagChip,
  onSelect: ({ tag }) =>
    exploreFromSelectionTarget({ type: "tag", value: tag, label: tag }),
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
  elements.selectionAddTag = document.querySelector("#selection-add-tag");
  elements.selectionFoldersDivider = document.querySelector("#selection-folders-divider");
  elements.selectionFolders = document.querySelector("#selection-folders");
  elements.selectionAddFolder = document.querySelector("#selection-add-folder");
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
  elements.autoExploreFileTypeAudio = document.querySelector("#auto-explore-file-type-audio");
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
  elements.aiExplorationRatio = document.querySelector("#ai-exploration-ratio");
  elements.aiExplorationRatioValue = document.querySelector("#ai-exploration-ratio-value");
  elements.aiSimilarityMax = document.querySelector("#ai-similarity-max");
  elements.aiSimilarityMaxValue = document.querySelector("#ai-similarity-max-value");
  elements.explorationDiversityStrength = document.querySelector(
    "#exploration-diversity-strength",
  );
  elements.explorationDiversityStrengthValue = document.querySelector(
    "#exploration-diversity-strength-value",
  );
  elements.autoExploreFolderSummary = document.querySelector("#auto-explore-folder-summary");
  elements.autoExploreFilterSummary = document.querySelector("#auto-explore-filter-summary");
  elements.exploreButton = document.querySelector("#explore-button");
  elements.folderLoadMoreButton = document.querySelector("#folder-load-more-button");
  elements.boardHistoryBackButton = document.querySelector("#board-history-back-button");
  elements.boardHistoryForwardButton = document.querySelector("#board-history-forward-button");
  elements.pdfBoardBackButton = document.querySelector("#pdf-board-back-button");
  elements.pdfBoardBreadcrumb = document.querySelector("#pdf-board-breadcrumb");
  elements.folderBrowser = document.querySelector("#folder-browser");
  elements.folderBrowserToggle = document.querySelector("#folder-browser-toggle");
  elements.folderBrowserSearch = document.querySelector("#folder-browser-search");
  elements.folderBrowserIncludeSubfolders = document.querySelector(
    "#folder-browser-include-subfolders",
  );
  elements.folderBrowserStatus = document.querySelector("#folder-browser-status");
  elements.folderBrowserTree = document.querySelector("#folder-browser-tree");
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
  settingsSnapshotStore = createSettingsSnapshotStore({
    storage: typeof localStorage === "undefined" ? null : localStorage,
  });
  videoThumbnailService = createVideoThumbnailService(createVideoThumbnailRuntime());
  folderBrowser = createFolderBrowser({
    document,
    elements: {
      root: elements.folderBrowser,
      toggle: elements.folderBrowserToggle,
      search: elements.folderBrowserSearch,
      includeSubfolders: elements.folderBrowserIncludeSubfolders,
      status: elements.folderBrowserStatus,
      tree: elements.folderBrowserTree,
    },
    onSelect: handleFolderBrowserSelect,
  });

  mediaMaterializer = createMediaMaterializer({
    document,
    window,
    world: elements.world,
    getNodeScreenLongEdge: (node) =>
      getNodeScreenLongEdge(node, state.camera.scale, window.devicePixelRatio),
    onPositionNode: positionNode,
    onClickNode: (node, modifiers) => {
      if (state.suppressNextMediaClick) {
        state.suppressNextMediaClick = false;
        return;
      }
      selectionNavigation.selectNode(node, modifiers);
    },
    onSelectNode: (node) => selectionNavigation.setSelectedNode(node),
    isNodeSelected: (node) => state.selectedNodes.has(node),
    isNodeInMultipleSelection: () => state.selectedNodes.size > 1,
    onOpenContextMenu: openMediaContextMenu,
    onOpenPdf: openPdfBoard,
    renderPdfPage: ({ node, canvas, scale, signal }) =>
      pdfBoardSession.renderPage({ pageItem: node.item, canvas, scale, signal }),
    onLayoutChange: updateLabels,
    getVideoControlsHeight,
    getVideoVolume: () => state.videoVolume,
    onVolumeChange: rememberVideoVolume,
    showToast,
    startVideoPlayer: BirdViewVideo.startVideoPlayer,
  });
  viewportMedia = createViewportMediaController({
    window,
    now: () => performance.now(),
    getSnapshot: () => ({
      rows: board.rows,
      camera: state.camera,
      viewport: getViewportSize(),
      selectedNode: state.selectedNode,
    }),
    materializer: mediaMaterializer,
    onSettled: runSettledViewportWork,
    requestRender: updateCamera,
  });

  selectionNavigation = createSelectionNavigation({
    state,
    elements,
    getRows: () => board.rows,
    onSelectNode: applySelectedNode,
    onClearSelection: applyClearedSelection,
    onSelectionChange: applySelectionChange,
  });
  cameraNavigation = createCameraNavigation({
    state,
    elements,
    getRows: () => board.rows,
    getBaseScale,
    getViewportSize: () => state.viewportSize || getViewportSize(),
    updateCamera,
    selectNodeAtViewportCenter: () => selectionNavigation.selectNodeAtViewportCenter(),
    onFocusStart: () => {
      viewportMedia.beginMotion("focus");
      elements.labels?.classList.add("is-camera-focus");
    },
    onFocusEnd: () => {
      elements.labels?.classList.remove("is-camera-focus");
      updateLabels();
      viewportMedia.endMotion("focus");
    },
    getVideoControlsHeight,
    getFocusRowEmphasis: () =>
      state.seamlessMode ? TIGHT_FOCUS_ROW_EMPHASIS : undefined,
    getFocusTargetHeight: () => state.focusMediaSize,
    onSmoothPanStart: () => viewportMedia.beginMotion("pan"),
    onSmoothPanEnd: () => viewportMedia.endMotion("pan"),
    onSmoothZoomStart: () => {
      state.isSmoothZooming = true;
      elements.labels?.classList.add("is-smooth-zooming");
      viewportMedia.beginMotion("zoom");
    },
    onSmoothZoomEnd: () => {
      state.isSmoothZooming = false;
      elements.labels?.classList.remove("is-smooth-zooming");
      viewportMedia.endMotion("zoom");
    },
  });

  pdfBoardSession = createPdfBoardSession({
    runtime: pdfRuntime,
    host: {
      captureParentBoard: captureBoardSnapshot,
      invalidateParentWork: invalidatePdfParentWork,
      releaseBoardPresentation: clearBoardPresentation,
      showPdfPages,
      restoreParentBoard,
      publishView: updatePdfModeUI,
      focusFirstPage: () => requestAnimationFrame(focusFirstItem),
    },
    onCleanupError(error) {
      console.warn("Failed to clean up PDF board session", error);
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
  elements.selectionAddTag?.addEventListener("click", () => {
    const node = state.selectedNode;
    if (node) openTagEditorForNode(node, elements.selectionAddTag);
  });
  elements.selectionAddFolder?.addEventListener("click", () => {
    const node = state.selectedNode;
    if (node) void openFolderPickerForNode(node, elements.selectionAddFolder);
  });
  elements.folderLoadMoreButton?.addEventListener("click", () => {
    void loadMoreFolderItems();
  });
  elements.boardHistoryBackButton?.addEventListener("click", restorePreviousBoard);
  elements.boardHistoryForwardButton?.addEventListener("click", restoreNextBoard);
  elements.pdfBoardBackButton?.addEventListener("click", () => void leavePdfBoard());
  elements.layoutDirection?.addEventListener("change", updateBoardSettings);
  elements.layoutWidth?.addEventListener("input", updateBoardSettings);
  elements.maxExplorationItems?.addEventListener("input", updateBoardSettings);
  elements.aiExplorationRatio?.addEventListener("input", updateBoardSettings);
  elements.aiSimilarityMax?.addEventListener("input", updateBoardSettings);
  elements.explorationDiversityStrength?.addEventListener("input", updateBoardSettings);
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
  updateBoardHistoryUI();
  updatePdfModeUI();
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
  state.folderItemSource = eagle.item
    ? new FolderItemSource(eagle.item, eagle.folder)
    : null;
  state.folderContentIntake = state.folderItemSource
    ? createFolderContentIntake({
        source: state.folderItemSource,
        folderApi: eagle.folder,
        getFolderTree: () => state.folderTree,
        loadCoordinator: rowLoadCoordinator,
        onStart: handleFolderContentStart,
        onBatch: handleFolderContentBatch,
        onStateChange: updateFolderLoadMoreUI,
      })
    : null;
  state.libraryContentTarget = state.folderContentIntake
    ? createLibraryContentTarget({
        itemApi: eagle.item,
        intake: state.folderContentIntake,
        loadCoordinator: rowLoadCoordinator,
      })
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
  if (isPdfBoardBusy()) {
    void leavePdfBoard({ silent: true }).then(() => handleLibraryChanged());
    return;
  }
  resetFolderItemLoad();
  state.libraryContentTarget?.reset();
  folderBrowser?.setLoading(false, "資料夾清單已更新。");
  state.folderItemSource?.clear?.();
  boardHistory.clear();
  clearBoard();
  updateBoardHistoryUI();
  state.folderNameGeneration += 1;
  state.folderNames.clear();
  state.folderTree = [];
  folderBrowser?.setFolders([]);
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
  if (isPdfBoardBusy()) await leavePdfBoard({ silent: true });
  if (typeof eagle === "undefined") {
    showToast("目前不在 Eagle 外掛環境中。", true);
    return;
  }

  const result = await rowLoadCoordinator.run("selected", async ({ isCurrent }) => {
    const items = await eagle.item.getSelected();
    if (!isCurrent()) return;

    if (items.length) {
      folderBrowser?.setSelectedFolder("");
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

    let selectedFolders = [];
    if (state.folderItemSource) {
      try {
        selectedFolders =
          typeof state.folderItemSource.getSelectedFolders === "function"
            ? await state.folderItemSource.getSelectedFolders()
            : (await state.folderItemSource.loadSelected()).folders;
      } catch (error) {
        console.warn("Failed to inspect selected Eagle folders", error);
      }
    }
    if (!isCurrent()) return;
    if (selectedFolders.length) {
      folderBrowser?.setSelectedFolder(selectedFolders[0]?.id);
      await state.folderContentIntake?.start({
        folders: selectedFolders,
        includeSubfolders: true,
        origin: "selected",
      });
      return;
    }

    if (append) return;

    folderBrowser?.setSelectedFolder("");
    resetFolderItemLoad();
    clearBoard({ recordHistory: true });
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

function handleFolderContentStart({ origin, folders }) {
  // A folder route supersedes a pending Tag target. The two routes now share
  // the folder session owner, but the Tag query still has its own Eagle API
  // channel and must be invalidated explicitly at this integration seam.
  state.libraryContentTarget?.reset();
  if (origin === "sidebar") {
    rowLoadCoordinator.invalidate("selected");
    folderBrowser?.setLoading(true);
    return;
  }
  if (origin !== "metadata") return;

  clearBoard({ recordHistory: true });
  folderBrowser?.setSelectedFolder(folders?.[0]?.id || "");
  folderBrowser?.setLoading(true);
}

async function handleFolderContentBatch(items, { initial = false, focus = false, offset, total } = {}) {
  if (!items?.length) return;
  if (initial) {
    renderItems(items);
    if (focus) requestAnimationFrame(focusFirstItem);
    return;
  }
  appendItemsToBoard(items);
  showToast(`已載入 ${offset} / ${total} 個資料夾素材。`);
}

async function handleFolderBrowserSelect({ folder, includeSubfolders }) {
  if (!folder?.id || !state.folderContentIntake) {
    folderBrowser?.setStatus("目前無法讀取 Eagle 資料夾。");
    return;
  }

  folderBrowser?.setSelectedFolder(folder.id);
  const result = await state.folderContentIntake.start({
    folders: [folder],
    includeSubfolders,
    origin: "sidebar",
  });
  if (result.status === "stale") return;
  folderBrowser?.setLoading(false);
  if (result.status === "error") {
    folderBrowser?.setStatus("載入失敗，請重新選擇資料夾。");
    if (result.error) showToast(`無法載入資料夾素材：${result.error.message || result.error}`, true);
    return;
  }
  if (result.status === "partial") {
    folderBrowser?.setStatus("部分資料夾載入失敗，可按「重試載入」繼續。");
    return;
  }
  if (result.status === "empty") {
    clearBoard({ recordHistory: true });
    folderBrowser?.setStatus(`選取的資料夾${describeSelectedFolders([folder])}沒有可載入的素材。`);
    return;
  }
  folderBrowser?.setStatus(`已載入「${folder.name || "未命名資料夾"}」的內容。`);
}

async function loadMoreFolderItems() {
  const intake = state.folderContentIntake;
  if (!intake) return { status: "skipped" };
  const result = await intake.loadMore();
  if (result.status === "error" && result.error) {
    console.error("Failed to load folder items", result.error);
    showToast(`無法載入資料夾素材：${result.error.message || result.error}`, true);
  }
  if (result.status === "partial") {
    folderBrowser?.setStatus("部分資料夾載入失敗，可按「重試載入」繼續。");
  }
  if (result.status === "ready" && result.folders?.length && result.remaining === 0) {
    folderBrowser?.setStatus(`已完成載入${describeSelectedFolders(result.folders)}的內容。`);
  }
  return result;
}

function resetFolderItemLoad() {
  state.folderContentIntake?.reset();
}

function updateFolderLoadMoreUI(snapshot = state.folderContentIntake?.snapshot()) {
  const button = elements.folderLoadMoreButton;
  if (!button) return;
  const remaining = snapshot?.remaining || 0;
  const canRetry = snapshot?.status === "partial" || snapshot?.status === "error";
  button.hidden = !snapshot?.hasMore;
  button.disabled = Boolean(snapshot?.isLoading);
  button.textContent = snapshot?.isLoading
    ? "載入中…"
    : canRetry
      ? "重試載入"
      : `載入更多（${remaining}）`;
  button.title = snapshot?.isLoading
    ? "正在載入資料夾素材"
    : canRetry
      ? "重試載入失敗的資料夾素材"
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
  if (!canUseParentBoardActions()) return;
  if (!items.length) return;
  if (!board.rows.length) {
    renderItems(items);
    requestAnimationFrame(focusFirstItem);
    return;
  }

  board.append(items, getBoardLayoutConfig());
  refreshBoardAfterItems(items);
}

function recordBoardHistory() {
  if (!canUseParentBoardActions()) return false;
  const snapshot = captureBoardSnapshot();
  if (!snapshot) return false;
  const recorded = boardHistory.record(snapshot);
  updateBoardHistoryUI();
  return recorded;
}

function captureBoardSnapshot() {
  if (!canUseParentBoardActions() || !board.nodes.length) return null;
  return {
    items: board.nodes.map(({ item }) => item),
    rotations: new Map(board.nodes.map((node) => [node.item.id, node.rotation || 0])),
    camera: { ...state.camera },
    selectedItemId: state.selectedNode?.item?.id || null,
  };
}

function getPdfBoardView() {
  return pdfBoardSession?.view() || {
    phase: "parent",
    parentItem: null,
    pageCount: 0,
    capabilities: {
      parentBoardActions: true,
      leave: false,
      renderPages: false,
    },
  };
}

function canUseParentBoardActions() {
  return getPdfBoardView().capabilities.parentBoardActions;
}

function isPdfBoardActive() {
  return getPdfBoardView().phase === "active";
}

function isPdfBoardBusy() {
  return getPdfBoardView().phase !== "parent";
}

async function openPdfBoard(node) {
  if (!isPdfItem(node?.item) || !pdfBoardSession) return false;
  const result = await pdfBoardSession.transition({ type: "enter", item: node.item });
  if (result.status === "entered") {
    showToast(`已進入「${node.item.name || "未命名 PDF"}」，共 ${result.pageCount} 頁。`, false);
    return true;
  }
  if (result.status === "failed" && result.code === "missing-parent-board") {
    showToast("目前沒有可返回的白板。", true);
    return false;
  }
  if (result.status === "failed") {
    const error = result.error;
    console.error("Failed to open PDF board", error);
    showToast(`無法開啟 PDF：${error?.message || error || result.code}`, true);
  }
  return false;
}

async function leavePdfBoard({ silent = false } = {}) {
  if (!pdfBoardSession) return false;
  const result = await pdfBoardSession.transition({ type: "leave" });
  const changed = result.status === "left" || result.status === "cancelled";
  if (result.status === "left" && !silent) showToast("已返回 PDF 所在白板。", false);
  return changed;
}

function invalidatePdfParentWork() {
  rowLoadCoordinator.invalidate("selected");
  rowLoadCoordinator.invalidate("exploration");
  rowLoadCoordinator.invalidate("unrated");
  state.explorationSource?.clear();
  state.unratedSource?.clear();
}

function showPdfPages({ pageItems }) {
  board.replace(pageItems, getBoardLayoutConfig());
  state.lastUnratedTriggerRow = null;
  refreshBaseScale();
}

function restoreParentBoard(parentContext) {
  board.relayout(parentContext.items, getBoardLayoutConfig(), parentContext.rotations);
  state.camera = { ...parentContext.camera };
  refreshBaseScale();
  const selectedNode = board.nodes.find(({ item }) => item.id === parentContext.selectedItemId);
  if (selectedNode) selectionNavigation.setSelectedNode(selectedNode);
  updateCamera();
  viewportMedia.cameraChanged();
  updateLabels();
}

function clearBoardPresentation() {
  cameraNavigation.cancelCameraFocus();
  tagEditor.close();
  folderPicker.close();
  selectionNavigation.clearSelection();
  mediaMaterializer.releaseAll();
  releaseAllMediaLabels();
  elements.world.replaceChildren();
  elements.labels.replaceChildren();
  state.labelCamera = null;
  elements.labels.style.transform = "none";
}

function formatPdfPagePosition(item) {
  const pageNumber = Number(item?.pdfPageNumber);
  const pageCount = Number(item?.pdfPageCount);
  if (Number.isInteger(pageNumber) && pageNumber > 0) {
    if (Number.isInteger(pageCount) && pageCount > 0) {
      return `第 ${pageNumber} / ${pageCount} 頁`;
    }
    return `第 ${pageNumber} 頁`;
  }
  return "PDF 頁面";
}

function updatePdfModeUI(view = getPdfBoardView()) {
  const active = view.phase === "active";
  const opening = view.phase === "opening";
  elements.app?.classList.toggle("is-pdf-mode", active);
  if (elements.pdfBoardBackButton) {
    elements.pdfBoardBackButton.hidden = !active;
    elements.pdfBoardBackButton.disabled = opening;
  }
  if (elements.pdfBoardBreadcrumb) {
    elements.pdfBoardBreadcrumb.hidden = !active;
    const selectedPage = active && isPdfPageNode(state.selectedNode)
      ? ` · ${formatPdfPagePosition(state.selectedNode.item)}`
      : "";
    elements.pdfBoardBreadcrumb.textContent = active
      ? `PDF：${view.parentItem?.name || "未命名"}${selectedPage}`
      : "";
  }
  if (elements.boardHistoryBackButton) {
    elements.boardHistoryBackButton.disabled =
      !view.capabilities.parentBoardActions || !boardHistory.canUndo();
  }
  if (elements.boardHistoryForwardButton) {
    elements.boardHistoryForwardButton.disabled =
      !view.capabilities.parentBoardActions || !boardHistory.canRedo();
  }
  if (elements.exploreButton) {
    elements.exploreButton.disabled = !view.capabilities.parentBoardActions || !state.selectedNode;
  }
  if (elements.folderLoadMoreButton) {
    elements.folderLoadMoreButton.disabled = !view.capabilities.parentBoardActions;
  }
  if (elements.folderBrowserToggle) {
    elements.folderBrowserToggle.disabled = !view.capabilities.parentBoardActions;
  }
  if (elements.autoExploreSettingsButton) {
    elements.autoExploreSettingsButton.disabled = !view.capabilities.parentBoardActions;
  }
  updateBoardMeta();
  updateSelectionStatus();
  updateLabels();
  updateAutoExploreToggle();
}

function renderItems(items) {
  if (isPdfBoardBusy()) {
    void leavePdfBoard({ silent: true });
    return;
  }
  recordBoardHistory();
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

function restorePreviousBoard() {
  if (!canUseParentBoardActions()) return false;
  const snapshot = boardHistory.undo(captureBoardSnapshot());
  updateBoardHistoryUI();
  if (!snapshot) return false;

  restoreBoardSnapshot(snapshot, "已回到上一個白板。");
  return true;
}

function restoreNextBoard() {
  if (!canUseParentBoardActions()) return false;
  const snapshot = boardHistory.redo(captureBoardSnapshot());
  updateBoardHistoryUI();
  if (!snapshot) return false;

  restoreBoardSnapshot(snapshot, "已前往下一個白板。");
  return true;
}

function restoreBoardSnapshot(snapshot, message) {
  resetFolderItemLoad();
  state.libraryContentTarget?.reset();
  rowLoadCoordinator.invalidate("selected");
  rowLoadCoordinator.invalidate("exploration");
  rowLoadCoordinator.invalidate("unrated");
  state.explorationSource?.clear();
  state.unratedSource?.clear();
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  folderBrowser?.setLoading(false);
  folderBrowser?.setSelectedFolder("");

  clearBoard();
  board.relayout(snapshot.items, getBoardLayoutConfig(), snapshot.rotations);
  state.lastUnratedTriggerRow = null;
  void loadFolderNames(snapshot.items);
  autoExploreSettings.update();
  refreshBaseScale();
  state.camera = { ...snapshot.camera };

  updateBoardMeta();
  const selectedNode = board.nodes.find(({ item }) => item.id === snapshot.selectedItemId);
  if (selectedNode) selectionNavigation.setSelectedNode(selectedNode);
  updateCamera();
  viewportMedia.cameraChanged();
  updateLabels();
  showToast(message, false);
}

function updateBoardHistoryUI() {
  const button = elements.boardHistoryBackButton;
  if (button) button.disabled = !canUseParentBoardActions() || !boardHistory.canUndo();
  if (elements.boardHistoryForwardButton) {
    elements.boardHistoryForwardButton.disabled =
      !canUseParentBoardActions() || !boardHistory.canRedo();
  }
}

function refreshBoardAfterItems(items) {
  void loadFolderNames(items);
  mediaMaterializer.reposition();
  updateBoardMeta();
  autoExploreSettings.update();
  viewportMedia.cameraChanged();
  updateLabels();
}

function relayoutBoard() {
  if (!board.nodes.length) return;

  const selectedItemId = state.selectedNode?.item?.id;
  const selectedScreenCenter = state.selectedNode
    ? getNodeScreenCenter(state.selectedNode, state.camera)
    : null;
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
  if (selectedNode) {
    selectionNavigation.setSelectedNode(selectedNode);
    if (selectedScreenCenter) {
      state.camera = reanchorCameraToNode(state.camera, selectedNode, selectedScreenCenter);
    }
  }
  updateCamera();
  viewportMedia.cameraChanged();
  updateLabels();
}

function openMediaContextMenu(node) {
  const targetItem = isPdfPageNode(node) ? node.item.pdfParentItem : node?.item;
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
      click: () => void openItemInEagle(targetItem?.id),
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
  const isPdfPage = isPdfPageNode(node);
  const label = document.createElement("div");
  const main = document.createElement("div");
  const metadata = document.createElement("div");
  const rating = document.createElement("span");
  const tags = document.createElement("span");
  const editTags = document.createElement("button");
  const folders = document.createElement("span");
  const editFolders = document.createElement("button");
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
  tags.className = "media-tags media-metadata-tags";
  editTags.className = "media-tag-edit media-metadata-add-tag";
  editTags.type = "button";
  editTags.textContent = "+";
  editTags.title = "新增或移除標籤";
  editTags.setAttribute("aria-label", `編輯 ${item.name || "素材"} 的標籤`);
  editTags.dataset.editControl = "true";
  folders.className = "media-tags media-metadata-folders";
  editFolders.className = "media-tag-edit media-metadata-add-folder";
  editFolders.type = "button";
  editFolders.textContent = "+";
  editFolders.title = "加入資料夾";
  editFolders.setAttribute("aria-label", `將 ${item.name || "素材"} 加入資料夾`);
  editFolders.dataset.editControl = "true";
  createRatingControls(rating, node);
  renderMediaMetadataTargets(tags, node, "tag");
  renderMediaMetadataTargets(folders, node, "folder");
  editTags.addEventListener("pointerdown", (event) => event.stopPropagation());
  editTags.addEventListener("click", (event) => {
    event.stopPropagation();
    openTagEditorForNode(node, editTags);
  });
  editFolders.addEventListener("pointerdown", (event) => event.stopPropagation());
  editFolders.addEventListener("click", (event) => {
    event.stopPropagation();
    void openFolderPickerForNode(node, editFolders);
  });
  identity.className = "media-identity";
  name.className = "media-name";
  name.textContent = isPdfPage ? formatPdfPagePosition(item) : item.name || "未命名";
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
  metadata.append(rating, tags, editTags, folders, editFolders);
  if (isPdfPage) {
    label.classList.add("is-pdf-page-label");
    metadata.hidden = true;
  }
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
    star.disabled = Boolean(node.isSaving);
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

function createBulkRatingControls(rating, nodes) {
  const values = nodes.map((node) => getItemRating(node.item));
  const commonRating = values.every((value) => value === values[0]) ? values[0] : 0;
  rating.setAttribute(
    "aria-label",
    commonRating ? `批次評分 ${commonRating} 顆星` : "批次評分（各素材不同）",
  );
  for (let index = 1; index <= 5; index += 1) {
    const star = document.createElement("button");
    star.className = "media-rating-star";
    star.type = "button";
    star.textContent = "★";
    star.title = `${index} 顆星${commonRating === index ? "（再次點擊可清除全部）" : "（套用到全部）"}`;
    star.setAttribute("aria-label", `將 ${nodes.length} 個素材設為 ${index} 顆星`);
    star.dataset.editControl = "true";
    star.disabled = nodes.some((node) => node.isSaving);
    star.addEventListener("pointerdown", (event) => event.stopPropagation());
    star.addEventListener("pointerenter", () => paintRating(rating, index));
    star.addEventListener("pointerleave", () => paintRating(rating, commonRating));
    star.addEventListener("click", async (event) => {
      event.stopPropagation();
      await setItemRatingForNodes(nodes, index, { toggle: commonRating === index });
    });
    rating.append(star);
  }
  paintRating(rating, commonRating);
}

async function setItemRating(node, value, { toggle = false } = {}) {
  if (!node || node.isSaving) return false;
  const previousRating = getItemRating(node.item);
  const nextRating = toggle
    ? getNextRating(previousRating, value)
    : clamp(Math.round(Number(value) || 0), 0, 5);
  if (nextRating === previousRating) return false;
  const result = await commitMetadataChanges("star", new Map([[node, nextRating]]), {
    successMessage: nextRating
      ? `已將「${node.item.name || "素材"}」設為 ${nextRating} 顆星。`
      : `已清除「${node.item.name || "素材"}」的評分。`,
  });
  return result.succeeded.length > 0;
}

async function setItemRatingForNodes(nodes, value, { toggle = false } = {}) {
  const selectedNodes = [...new Set(nodes || [])].filter(Boolean);
  if (!selectedNodes.length) return false;
  const ratings = selectedNodes.map((node) => getItemRating(node.item));
  const nextRating =
    toggle && ratings.every((rating) => rating === Number(value))
      ? 0
      : clamp(Math.round(Number(value) || 0), 0, 5);
  const result = await commitMetadataChanges(
    "star",
    new Map(selectedNodes.map((node) => [node, nextRating])),
    {
      successMessage: `已將 ${selectedNodes.length} 個素材設為 ${nextRating} 顆星。`,
      partialMessage: ({ succeeded, failed }) =>
        `已更新 ${succeeded.length} 個素材的評分，${failed.length} 個儲存失敗。`,
      failureMessage: "批次評分失敗，未能儲存素材。",
    },
  );
  return result.succeeded.length > 0;
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

function getFolderMetadataEntries(item) {
  return normalizeTags(item?.folders).map((id) => ({
    value: id,
    label: state.folderNames.get(id) || id,
  }));
}

function renderMediaMetadataTargets(container, node, type) {
  if (!container || !node) return;
  const entries =
    type === "tag"
      ? normalizeTags(node.item.tags).map((tag) => ({ value: tag, label: tag }))
      : getFolderMetadataEntries(node.item);
  container.replaceChildren(
    ...entries.map(({ value, label }) =>
      createMetadataTarget({ node, type, value, label }),
    ),
  );
  container.hidden = entries.length === 0;
  container.title = entries.map(({ label }) => label).join(type === "folder" ? " / " : ", ");
}

function refreshMediaMetadata(node) {
  if (!node?.label) return;
  renderMediaMetadataTargets(
    node.label.querySelector(".media-metadata-tags"),
    node,
    "tag",
  );
  renderMediaMetadataTargets(
    node.label.querySelector(".media-metadata-folders"),
    node,
    "folder",
  );
}

function renderSelectionTags(tags) {
  const tagValues = normalizeTags(tags);
  state.selectionTags = tagValues;
  state.selectionTagButtons = tagValues.map((tag) =>
    createSelectionExploreButton({ type: "tag", value: tag, label: tag }),
  );
  state.selectionTagOverflowButton = createSelectionTagOverflowButton();
  selectionTagOverflow.close();
  elements.selectionTags.style.width = "";

  elements.selectionTags.hidden = tagValues.length === 0;
  elements.selectionTagsDivider.hidden = tagValues.length === 0;
  elements.selectionTags.title = tagValues.join(", ");
  if (!tagValues.length) {
    elements.selectionTags.replaceChildren();
    return;
  }

  elements.selectionTags.replaceChildren(
    ...state.selectionTagButtons,
    state.selectionTagOverflowButton,
  );
  fitSelectionTags();
}

function createSelectionTagOverflowButton() {
  const button = document.createElement("button");
  button.className = "selection-tag-overflow-button";
  button.type = "button";
  button.hidden = true;
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!state.selectionTagOverflowButton || button.hidden) return;
    selectionTagOverflow.open(state.selectedNode, button, state.selectionTags);
  });
  return button;
}

function fitSelectionTags() {
  const buttons = state.selectionTagButtons;
  const overflowButton = state.selectionTagOverflowButton;
  if (!elements.selectionTags || !buttons.length || !overflowButton) return;

  elements.selectionTags.style.width = "";
  elements.selectionTags.replaceChildren(...buttons, overflowButton);
  overflowButton.hidden = false;
  const tagWidths = buttons.map(getElementWidth);
  const overflowWidths = {};
  for (let hidden = 1; hidden <= buttons.length; hidden += 1) {
    overflowButton.textContent = `+${hidden}`;
    overflowWidths[hidden] = getElementWidth(overflowButton);
  }

  const visibleCount = getVisibleTagCount(
    tagWidths,
    elements.selectionTags.clientWidth,
    overflowWidths,
  );
  const availableWidth = elements.selectionTags.clientWidth;
  const hiddenCount = buttons.length - visibleCount;
  if (hiddenCount) elements.selectionTags.style.width = `${availableWidth}px`;
  overflowButton.hidden = hiddenCount === 0;
  overflowButton.textContent = `+${hiddenCount}`;
  overflowButton.title = `顯示其餘 ${hiddenCount} 個 Tag`;
  overflowButton.setAttribute("aria-label", `顯示其餘 ${hiddenCount} 個 Tag`);
  elements.selectionTags.replaceChildren(
    ...buttons.slice(0, visibleCount),
    ...(hiddenCount ? [overflowButton] : []),
  );
}

function getElementWidth(element) {
  const rect = element.getBoundingClientRect?.();
  return rect?.width || element.offsetWidth || element.scrollWidth || 0;
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
  return createMetadataTarget({
    node: state.selectedNode,
    type,
    value,
    label,
    selection: true,
  });
}

function createMetadataTarget({ node, type, value, label, selection = false }) {
  const button = document.createElement("button");
  button.className = selection
    ? `selection-explore-target selection-${type}-target`
    : `media-metadata-target media-metadata-${type}-target`;
  button.type = "button";
  button.disabled = state.explorationLoading;
  const targetLabel = type === "tag" ? "Tag" : "資料夾";
  const contextAction = type === "folder" ? "右鍵顯示資料夾內容" : "右鍵移除";
  button.title = `左鍵從${targetLabel}「${label}」探索素材；${contextAction}`;
  button.setAttribute(
    "aria-label",
    `從${targetLabel}「${label}」探索素材；${contextAction}${type === "folder" ? "" : targetLabel}`,
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
    if (node) selectionNavigation.setSelectedNode(node);
    void exploreFromSelectionTarget({ type, value, label });
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (type === "folder") {
      void loadFolderFromMetadataTarget(value, label);
      return;
    }
    void loadTagFromMetadataTarget(value, label);
  });
  return button;
}

async function loadTagFromMetadataTarget(tag, label) {
  const value = String(tag || "").trim();
  if (!value || !state.libraryContentTarget) {
    showToast("目前無法讀取 Eagle Tag 素材。", true);
    return;
  }

  folderBrowser?.setLoading(false);
  folderBrowser?.setSelectedFolder("");
  folderBrowser?.setStatus(`正在載入 Tag「${label || value}」…`);
  const result = await state.libraryContentTarget.load({
    type: "tag",
    value,
    label,
    onBeforeStart() {
      resetFolderItemLoad();
      clearBoard({ recordHistory: true });
    },
  });
  handleLibraryContentTargetResult(result, { value, label });
}

async function loadFolderFromMetadataTarget(folderId, label) {
  const id = String(folderId || "").trim();
  if (!id || !state.folderContentIntake) {
    showToast("目前無法讀取 Eagle 資料夾。", true);
    return;
  }

  folderBrowser?.setLoading(true);
  folderBrowser?.setStatus(`正在載入資料夾「${label || id}」…`);
  const result = await state.folderContentIntake.startFolder({
    folderId: id,
    origin: "metadata",
  });
  if (result.status === "stale") return;
  folderBrowser?.setLoading(false);
  handleFolderContentTargetResult(result, { value: id, label });
}

function handleLibraryContentTargetResult(result, { value, label }) {
  if (result.status === "stale") return;
  const targetLabel = label || value;
  if (result.status === "unavailable") {
    showToast("目前無法讀取 Eagle Tag 素材。", true);
    return;
  }
  if (result.status === "error") {
    const errorMessage = result.error?.message || result.error;
    folderBrowser?.setStatus("載入 Tag 失敗，請重新嘗試。");
    if (errorMessage) {
      showToast(`無法載入 Tag 素材：${errorMessage}`, true);
    }
    return;
  }
  if (result.status === "partial") {
    folderBrowser?.setStatus("Tag 素材部分載入失敗，可按「重試載入」繼續。");
    return;
  }
  if (result.status === "empty") {
    folderBrowser?.setStatus(`Tag「${targetLabel}」沒有可載入的素材。`);
    return;
  }
  folderBrowser?.setStatus(`已載入 Tag「${targetLabel}」的內容。`);
}

function handleFolderContentTargetResult(result, { value, label }) {
  if (result.status === "stale") return;
  if (result.status === "missing") {
    showToast(`無法讀取資料夾「${label || value}」。`, true);
    folderBrowser?.setStatus("載入失敗，請重新選擇資料夾。");
    return;
  }
  if (result.status === "error") {
    const errorMessage = result.error?.message || result.error;
    folderBrowser?.setStatus("載入失敗，請重新選擇資料夾。");
    if (errorMessage) showToast(`無法載入資料夾素材：${errorMessage}`, true);
    return;
  }
  if (result.status === "partial") {
    folderBrowser?.setStatus("部分資料夾載入失敗，可按「重試載入」繼續。");
    return;
  }
  if (result.status === "empty") {
    folderBrowser?.setStatus(`選取的資料夾${describeSelectedFolders([result.folder])}沒有可載入的素材。`);
    return;
  }
  folderBrowser?.setStatus(`已載入${describeSelectedFolders([result.folder])}的內容。`);
}

function invalidateMetadataSources() {
  rowLoadCoordinator.invalidate("exploration");
  state.explorationSource?.clear();
  rowLoadCoordinator.invalidate("unrated");
  state.unratedExhausted = false;
  state.lastUnratedTriggerRow = null;
  state.unratedSource?.clear();
  updateAutoExploreToggle();
}

function refreshCommittedMetadata(node, property) {
  if (property === "star") {
    refreshNodeRating(node);
    return;
  }
  refreshMediaMetadata(node);
  updateSelectionStatus();
}

async function commitMetadataChanges(property, changes, messages = {}) {
  const result = await metadataCommitter.commit({ property, changes });
  if (result.status === "empty" || result.status === "busy") return result;
  if (result.status === "unsupported") {
    showToast(
      result.unsupported.length > 1
        ? "部分素材不支援儲存，未執行批次更新。"
        : "素材不支援儲存。",
      true,
    );
    return result;
  }

  for (const { error } of result.failed) {
    console.error("Failed to save Eagle item metadata", error);
  }
  if (result.status === "partial") {
    const message =
      typeof messages.partialMessage === "function"
        ? messages.partialMessage(result)
        : messages.partialMessage ||
          `已成功更新 ${result.succeeded.length} 個素材，${result.failed.length} 個儲存失敗。`;
    showToast(message, true);
    return result;
  }
  if (result.status === "failed") {
    const error = result.failed[0]?.error;
    const message =
      messages.failureMessage ||
      (result.failed.length > 1
        ? `批次更新失敗：${result.failed.length} 個素材未能儲存。`
        : `無法儲存素材資料：${error?.message || error || "未知錯誤"}`);
    showToast(message, true);
    return result;
  }

  const successMessage =
    typeof messages.successMessage === "function"
      ? messages.successMessage(result)
      : messages.successMessage;
  if (successMessage) showToast(successMessage, false, METADATA_SUCCESS_TOAST_MS);
  return result;
}

function setLabelSaving(node, isSaving) {
  node.label?.classList.toggle("is-saving", isSaving);
  for (const control of node.label?.querySelectorAll("[data-edit-control]") || []) {
    control.disabled = isSaving;
  }
  if (!state.selectedNodes.has(node)) return;
  for (const control of [
    elements.selectionAddTag,
    elements.selectionAddFolder,
    ...(elements.selectionRating?.querySelectorAll("[data-edit-control]") || []),
  ]) {
    if (control) control.disabled = isSaving;
  }
}

async function commitTagChanges(changes) {
  const nodes = [...changes.keys()];
  const result = await commitMetadataChanges("tags", changes, {
    successMessage:
      nodes.length === 1
        ? `已更新「${nodes[0].item.name || "素材"}」的標籤。`
        : `已更新 ${nodes.length} 個素材的標籤。`,
  });
  if (result.succeeded.length) void loadTagColors();
  return result;
}

async function removeSelectionTarget(node, { type, value, label }) {
  if (!node || node.isSaving) return;
  const property = type === "tag" ? "tags" : "folders";
  const targetValue = String(value ?? "").trim();
  const previousValues = normalizeTags(node.item[property]);
  const nextValues = previousValues.filter((entry) => entry !== targetValue);
  if (!targetValue || nextValues.length === previousValues.length) return;

  return commitMetadataChanges(property, new Map([[node, nextValues]]), {
    successMessage: `已從「${node.item.name || "素材"}」移除${type === "tag" ? "Tag" : "資料夾"}「${label}」。`,
  });
}

async function commitFolderChanges(changes) {
  const nodes = [...changes.keys()];
  const result = await commitMetadataChanges("folders", changes, {
    successMessage:
      nodes.length === 1
        ? `已更新「${nodes[0].item.name || "素材"}」的資料夾。`
        : `已更新 ${nodes.length} 個素材的資料夾。`,
  });
  if (result.succeeded.length) await loadFolderNames(result.succeeded.map((node) => node.item));
  return result;
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
    for (const node of state.mountedLabelNodes) refreshMediaMetadata(node);
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
    state.folderTree = [];
    state.folderOptions = [];
    folderBrowser?.setFolders([]);
    autoExploreSettings.update();
    return;
  }

  try {
    const folders = await eagle.folder.getAll();
    if (generation !== state.folderOptionGeneration) return;
    state.folderTree = folders || [];
    state.folderOptions = flattenFolderOptions(folders);
    folderBrowser?.setFolders(state.folderTree);
    autoExploreSettings.update();
  } catch (error) {
    if (generation !== state.folderOptionGeneration) return;
    state.folderTree = [];
    state.folderOptions = [];
    folderBrowser?.setFolders([]);
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
  node.label.classList.toggle("is-selected", state.selectedNodes.has(node));
  node.label.classList.toggle("is-active", node === state.selectedNode);
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
  state.suppressNextMediaClick = false;
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
      state.suppressNextMediaClick = true;
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
    if (state.suppressNextMediaClick) {
      window.setTimeout(() => {
        state.suppressNextMediaClick = false;
      }, 0);
    }
  };

  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function startViewportPan() {
  cameraNavigation.cancelCameraFocus();
  tagEditor.close();
  state.isPanning = true;
  elements.viewport.classList.add("is-panning");
  viewportMedia.beginMotion("pan");
}

function finishViewportPan() {
  state.isPanning = false;
  elements.viewport.classList.remove("is-panning");
  viewportMedia.endMotion("pan");
}

function handleWheel(event) {
  event.preventDefault();
  tagEditor.close();
  const rect = elements.viewport.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  viewportMedia.noteMotion("zoom");
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
    if (!canUseParentBoardActions()) return;
    toggleUnratedExploration();
    return;
  }
  if (isInteractiveTarget(event.target)) return;

  if (event.key === "Escape") {
    event.preventDefault();
    if (event.repeat) return;
    if (isPdfBoardBusy()) {
      void leavePdfBoard();
      return;
    }
    selectionNavigation.clearSelection();
    return;
  }

  const normalizedKey = event.key.toLowerCase();
  const isUndoShortcut =
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    normalizedKey === "z";
  const isRedoShortcut =
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    ((event.shiftKey && normalizedKey === "z") ||
      (!event.shiftKey && normalizedKey === "y"));
  if (isUndoShortcut || isRedoShortcut) {
    event.preventDefault();
    if (event.repeat) return;
    if (isRedoShortcut) restoreNextBoard();
    else restorePreviousBoard();
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
    folderBrowser?.toggle?.();
    return;
  }

  if (
    event.key === "Delete" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
    toggleSeamlessMode();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey && /^[1-5]$/.test(event.key)) {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
    const selectedNodes = getSelectedNodeList();
    if (selectedNodes.length > 1) void setItemRatingForNodes(selectedNodes, Number(event.key));
    else void setItemRating(state.selectedNode, Number(event.key));
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
    if (!canUseParentBoardActions()) return;
    void openSelectedFolderPicker();
    return;
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === "Home"
  ) {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
    void setSelectedVideoThumbnail();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "t") {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
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
      viewportMedia.noteMotion("pan");
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
    viewportMedia.noteMotion("pan");
    cameraNavigation.panBy(direction[0] * -panStep, direction[1] * -panStep);
    selectionNavigation.selectNodeAtViewportCenter();
    return;
  }

  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (event.repeat) return;
    if (!canUseParentBoardActions()) return;
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
    viewportMedia.noteMotion("zoom");
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
  viewportMedia.noteMotion("pan");
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

function openTagEditorForNode(node, anchor) {
  if (!node || node.isSaving) return;
  folderPicker.close();
  const selectedNodes = getSelectedNodeList();
  if (selectedNodes.length > 1 && selectedNodes.includes(node)) {
    tagEditor.openMultiple(selectedNodes, anchor || node.element);
    return;
  }
  tagEditor.open(node, anchor || node.element);
}

function openSelectedTagEditor() {
  const node = state.selectedNode;
  if (!node) return;
  const anchor = state.seamlessMode
    ? node.element
    : elements.selectionAddTag ||
      node.label?.querySelector(".media-metadata-add-tag") ||
      node.element;
  openTagEditorForNode(node, anchor);
}

async function openFolderPickerForNode(node, anchor) {
  if (!node || node.isSaving) return;
  if (typeof eagle === "undefined" || typeof eagle.folder?.getAll !== "function") {
    showToast("目前的 Eagle 版本不支援搜尋全部資料夾。", true);
    return;
  }

  tagEditor.close();
  try {
    const folders = await eagle.folder.getAll();
    const selectedNodes = getSelectedNodeList();
    if (!node.label?.isConnected && node !== state.selectedNode) return;
    if (selectedNodes.length > 1 && selectedNodes.includes(node)) {
      folderPicker.openMultiple(selectedNodes, anchor || node.element, folders);
      return;
    }
    folderPicker.open(node, anchor || node.element, folders);
  } catch (error) {
    console.error("Failed to load Eagle folders", error);
    showToast(`無法讀取 Eagle 資料夾：${error.message || error}`, true);
  }
}

function openSelectedFolderPicker() {
  const node = state.selectedNode;
  if (!node) return;
  const anchor = state.seamlessMode
    ? node.element
    : elements.selectionAddFolder ||
      node.label?.querySelector(".media-metadata-add-folder") ||
      node.element;
  void openFolderPickerForNode(node, anchor);
}

function applyClearedSelection(previousNode) {
  folderPicker.closeForNode(previousNode);
  mediaMaterializer.pause(previousNode);
  updateSelectionStatus();
  updateExploreButton();
}

function applySelectionChange({ selectedNodes, previousSelectedNodes }) {
  const affectedNodes = new Set([
    ...(selectedNodes || []),
    ...(previousSelectedNodes || []),
  ]);
  for (const node of affectedNodes) {
    const isSelected = selectedNodes?.has(node) || false;
    node.element?.classList.toggle("is-selected", isSelected);
    node.element?.classList.toggle(
      "is-multi-selected",
      isSelected && (selectedNodes?.size || 0) > 1,
    );
    node.element?.classList.toggle("is-active", node === state.selectedNode);
    node.label?.classList.toggle("is-selected", isSelected);
    node.label?.classList.toggle("is-active", node === state.selectedNode);
  }
  updateSelectionStatus();
  updateExploreButton();
}

function applySelectedNode(node, { changed, previousNode }) {
  if (changed) {
    folderPicker.closeForNode(previousNode);
    mediaMaterializer.pause(previousNode);
    mediaMaterializer.mount(node);
    mediaMaterializer.preloadSelected(node);
    syncSelectedVideoAutoplay();
  }
  updateSelectionStatus();
  updateExploreButton();
  if (isPdfBoardActive()) updatePdfModeUI();
}

function insertExplorationItemsAfterNode(pivotNode, items) {
  if (!board.insertAfter(pivotNode, items, getBoardLayoutConfig())) return false;
  refreshBoardAfterItems(items);
  return true;
}

function selectExplorationItems(candidates, pivot, maxAiItems) {
  return selectExplorationRow(
    candidates,
    pivot,
    Math.random,
    getBoardLayoutWidth(),
    state.maxExplorationItems,
    {
      maxAiItems,
      diversityStrength: state.explorationDiversityStrength,
      gap: getBoardLayoutOptions().gap,
    },
  );
}

async function exploreNextRow() {
  if (!canUseParentBoardActions()) return;
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
  const maxAiItems = getConfiguredAiExplorationItems();
  const result = await rowLoadCoordinator.load("exploration", {
    find: () =>
      source.findCandidates(pivot, excludedIds, {
        aiEnabled: maxAiItems > 0,
        maxAiItems,
        maxAiSimilarity: state.aiSimilarityMax / 100,
      }),
    select: (candidates) => selectExplorationItems(candidates, pivot, maxAiItems),
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
  if (!canUseParentBoardActions()) return;
  const pivotNode = state.selectedNode;
  const source = state.explorationSource;
  if (!pivotNode || !source || state.explorationLoading) return;

  const criterion = type === "tag" ? { tags: [value] } : { folders: [value] };
  const boardNodes = board.nodes;
  const excludedIds = new Set(boardNodes.map(({ item }) => item.id));
  const maxAiItems = getConfiguredAiExplorationItems();
  const result = await rowLoadCoordinator.load("exploration", {
    find: () =>
      source.findCandidates(criterion, excludedIds, {
        aiEnabled: maxAiItems > 0,
        maxAiItems,
        maxAiSimilarity: state.aiSimilarityMax / 100,
      }),
    select: (candidates) => selectExplorationItems(candidates, criterion, maxAiItems),
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
  if (!canUseParentBoardActions()) return;
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
        getBoardLayoutOptions(),
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
  const previous = getSettingsSnapshot();
  const rawLayoutWidth = elements.layoutWidth?.value;
  const next = settingsSnapshotStore.capture({
    ...previous,
    board: {
      ...previous.board,
      layoutDirection: elements.layoutDirection?.value ?? previous.board.layoutDirection,
      layoutWidth: rawLayoutWidth ?? previous.board.layoutWidth,
      layoutWidthUnlimited: elements.layoutWidth
        ? Number(rawLayoutWidth) >= SETTINGS_LIMITS.maxLayoutWidth
        : previous.board.layoutWidthUnlimited,
      maxExplorationItems:
        elements.maxExplorationItems?.value ?? previous.board.maxExplorationItems,
      aiExplorationRatio:
        elements.aiExplorationRatio?.value ?? previous.board.aiExplorationRatio,
      aiSimilarityMax: elements.aiSimilarityMax?.value ?? previous.board.aiSimilarityMax,
      explorationDiversityStrength:
        elements.explorationDiversityStrength?.value ??
        previous.board.explorationDiversityStrength,
      smoothPanEnabled: Boolean(elements.smoothPanToggle?.checked),
      smoothPanSpeed: elements.smoothPanSpeed?.value ?? previous.board.smoothPanSpeed,
      smoothZoomEnabled: Boolean(elements.smoothZoomToggle?.checked),
      smoothZoomSpeed: elements.smoothZoomSpeed?.value ?? previous.board.smoothZoomSpeed,
      keyboardAcceleration:
        elements.keyboardAcceleration?.value ?? previous.board.keyboardAcceleration,
      focusMediaSize: elements.focusMediaSize?.value ?? previous.board.focusMediaSize,
      videoAutoplayEnabled: Boolean(elements.videoAutoplayToggle?.checked),
    },
  });
  const layoutChanged =
    previous.board.layoutDirection !== next.board.layoutDirection ||
    previous.board.layoutWidth !== next.board.layoutWidth ||
    previous.board.layoutWidthUnlimited !== next.board.layoutWidthUnlimited ||
    previous.board.seamlessMode !== next.board.seamlessMode;
  const explorationSettingsChanged =
    previous.board.aiExplorationRatio !== next.board.aiExplorationRatio ||
    previous.board.aiSimilarityMax !== next.board.aiSimilarityMax ||
    previous.board.explorationDiversityStrength !== next.board.explorationDiversityStrength;
  applySettingsSnapshotValues(next);
  if (!state.smoothPanEnabled) cameraNavigation.stopSmoothKeyboardPan();
  if (!state.smoothZoomEnabled) cameraNavigation.stopSmoothKeyboardZoom();
  saveSettings();
  updateBoardSettingsUI();
  syncSelectedVideoAutoplay();
  if (explorationSettingsChanged) {
    rowLoadCoordinator.invalidate("exploration");
    state.explorationSource?.clear();
  }
  if (layoutChanged) relayoutBoard();
}

function updateBoardSettingsUI() {
  if (elements.layoutDirection) elements.layoutDirection.value = state.layoutDirection;
  if (elements.layoutWidth) {
    elements.layoutWidth.value = String(
      state.layoutWidthUnlimited ? SETTINGS_LIMITS.maxLayoutWidth : state.layoutWidth,
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
  if (elements.aiExplorationRatio) {
    elements.aiExplorationRatio.value = String(state.aiExplorationRatio);
    elements.aiExplorationRatio.disabled = !state.aiExplorationAvailable;
  }
  if (elements.aiExplorationRatioValue) {
    elements.aiExplorationRatioValue.textContent = state.aiExplorationRatio > 0
      ? `${state.aiExplorationRatio}%`
      : "關閉";
  }
  if (elements.aiSimilarityMax) {
    elements.aiSimilarityMax.value = String(state.aiSimilarityMax);
    elements.aiSimilarityMax.disabled = !state.aiExplorationAvailable;
  }
  if (elements.aiSimilarityMaxValue) {
    elements.aiSimilarityMaxValue.textContent =
      state.aiSimilarityMax >= SETTINGS_LIMITS.maxAiSimilarity
      ? "不限"
      : `${state.aiSimilarityMax}%`;
  }
  if (elements.explorationDiversityStrength) {
    elements.explorationDiversityStrength.value = String(state.explorationDiversityStrength);
  }
  if (elements.explorationDiversityStrengthValue) {
    elements.explorationDiversityStrengthValue.textContent =
      state.explorationDiversityStrength > 0
        ? `${state.explorationDiversityStrength}%`
        : "基本";
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

function getSettingsSnapshot({ includeActivePreset = false } = {}) {
  return settingsSnapshotStore.capture({
    unratedEnabled: state.unratedEnabled,
    board: {
      layoutDirection: state.layoutDirection,
      layoutWidth: state.layoutWidth,
      layoutWidthUnlimited: state.layoutWidthUnlimited,
      seamlessMode: state.seamlessMode,
      maxExplorationItems: state.maxExplorationItems,
      aiExplorationRatio: state.aiExplorationRatio,
      aiSimilarityMax: state.aiSimilarityMax,
      explorationDiversityStrength: state.explorationDiversityStrength,
      smoothPanEnabled: state.smoothPanEnabled,
      smoothPanSpeed: state.smoothPanSpeed,
      smoothZoomEnabled: state.smoothZoomEnabled,
      smoothZoomSpeed: state.smoothZoomSpeed,
      keyboardAcceleration: state.keyboardAcceleration,
      focusMediaSize: state.focusMediaSize,
      videoAutoplayEnabled: state.videoAutoplayEnabled,
    },
    autoExploreFilter: autoExploreSettings.getFilter(),
    activePresetName: includeActivePreset ? state.selectedPresetName : "",
  });
}

function applySettingsSnapshotValues(settings, { restoreAutoExploreState = false } = {}) {
  const snapshot = settingsSnapshotStore.normalize(settings);
  if (restoreAutoExploreState && typeof settings?.unratedEnabled === "boolean") {
    state.unratedEnabled = snapshot.unratedEnabled;
  }
  const board = snapshot.board;
  state.smoothPanEnabled = board.smoothPanEnabled;
  state.smoothPanSpeed = board.smoothPanSpeed;
  state.smoothZoomEnabled = board.smoothZoomEnabled;
  state.smoothZoomSpeed = board.smoothZoomSpeed;
  state.keyboardAcceleration = board.keyboardAcceleration;
  state.focusMediaSize = board.focusMediaSize;
  state.videoAutoplayEnabled = board.videoAutoplayEnabled;
  state.layoutDirection = board.layoutDirection;
  state.layoutWidth = board.layoutWidth;
  state.layoutWidthUnlimited = board.layoutWidthUnlimited;
  state.seamlessMode = board.seamlessMode;
  state.maxExplorationItems = board.maxExplorationItems;
  state.aiExplorationRatio = board.aiExplorationRatio;
  state.aiSimilarityMax = board.aiSimilarityMax;
  state.explorationDiversityStrength = board.explorationDiversityStrength;
  if (settings?.autoExploreFilter && typeof settings.autoExploreFilter === "object") {
    autoExploreSettings.setFilter(snapshot.autoExploreFilter);
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
  const explorationSettingsChanged =
    previous.board.aiExplorationRatio !== next.board.aiExplorationRatio ||
    previous.board.aiSimilarityMax !== next.board.aiSimilarityMax ||
    previous.board.explorationDiversityStrength !== next.board.explorationDiversityStrength;
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

  if (explorationSettingsChanged) {
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
  const saved = settingsSnapshotStore.read();
  if (!saved) return;
  const activePreset = saved.activePresetName
    ? settingsPresetStore?.get(saved.activePresetName)
    : null;
  if (activePreset) {
    state.selectedPresetName = activePreset.name;
    applySettingsSnapshotValues(activePreset.settings, { restoreAutoExploreState: true });
    return;
  }
  applySettingsSnapshotValues(saved);
}

function saveSettings() {
  if (!settingsSnapshotStore.write(getSettingsSnapshot({ includeActivePreset: true }))) {
    console.warn("Failed to save Bird View settings");
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
    saveSettings();
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
  saveSettings();
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
  saveSettings();
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
  saveSettings();
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
  if (!canUseParentBoardActions()) return;
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
  state.aiExplorationRatio = DEFAULT_SETTINGS_SNAPSHOT.board.aiExplorationRatio;
  state.aiSimilarityMax = DEFAULT_SETTINGS_SNAPSHOT.board.aiSimilarityMax;
  state.explorationDiversityStrength =
    DEFAULT_SETTINGS_SNAPSHOT.board.explorationDiversityStrength;
  rowLoadCoordinator.invalidate("exploration");
  state.explorationSource?.clear();
  updateBoardSettingsUI();
  saveSettings();
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

function getConfiguredAiExplorationItems() {
  return getAiExplorationItemLimit(state.maxExplorationItems, state.aiExplorationRatio);
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
  if (!canUseParentBoardActions()) return;
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
  elements.autoExploreToggle.disabled = !canUseParentBoardActions() || !state.unratedSource;
  if (elements.autoExploreSettingsButton) {
    elements.autoExploreSettingsButton.disabled = !canUseParentBoardActions();
  }
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
    !canUseParentBoardActions() ||
    state.explorationLoading ||
    !state.explorationSource ||
    !state.selectedNode;
  elements.exploreButton.textContent = state.explorationLoading
    ? "探索中…"
    : "探索";
  for (const button of elements.selectionStatus?.querySelectorAll(
    ".selection-explore-target, .selection-tag-overflow-button",
  ) || []) {
    button.disabled = state.explorationLoading;
  }
  for (const button of elements.labels?.querySelectorAll(".media-metadata-target") || []) {
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
  if (isPdfItem(node?.item)) {
    void openPdfBoard(node);
    return;
  }
  if (isPdfPageNode(node)) return;
  if (!isPlayableNode(node)) return;
  if (node.togglePlayback) {
    node.togglePlayback();
  } else {
    node.startPlayback?.();
  }
}

async function setSelectedVideoThumbnail() {
  const node = state.selectedNode;
  if (!node?.isVideo) {
    showToast("請先選取影片。", true);
    return;
  }
  if (!node.videoElement) {
    showToast("請先播放影片，再按 Ctrl+Home 設定目前畫面為縮圖。", true);
    return;
  }
  if (node.videoThumbnailSaving) return;

  node.videoThumbnailSaving = true;
  try {
    const item = await getEagleItemForThumbnail(node);
    if (!item) {
      showToast("目前 Eagle 版本不支援設定影片縮圖。", true);
      return;
    }
    const result = await videoThumbnailService?.setFromVideo({
      video: node.videoElement,
      item,
    });
    if (result?.status === "saved") {
      showToast("已將目前影片畫面設為 Eagle 縮圖。", false);
      return;
    }
    if (result?.reason === "video-not-ready") {
      showToast("影片目前尚未載入畫面，請稍後再試。", true);
      return;
    }
    if (!result) {
      showToast("影片縮圖服務尚未準備完成，請重新開啟外掛。", true);
      return;
    }
    if (result.reason === "runtime-unavailable") {
      const missing = Array.isArray(result.missing)
        ? result.missing
          .map((capability) =>
            VIDEO_THUMBNAIL_RUNTIME_CAPABILITY_LABELS[capability] || capability)
          .filter(Boolean)
        : [];
      console.error("Video thumbnail runtime is missing capabilities", result.missing || []);
      const detail = missing.length ? `缺少：${missing.join("、")}。` : "請查看主控台錯誤。";
      showToast(`無法建立影片縮圖：${detail}`, true);
      return;
    }
    const reason =
      VIDEO_THUMBNAIL_UNAVAILABLE_MESSAGES[result.reason] ||
      "目前環境無法建立影片縮圖，請查看主控台錯誤。";
    showToast(`無法建立影片縮圖：${reason}`, true);
  } catch (error) {
    console.error("Failed to set Eagle video thumbnail", error);
    showToast(`無法設定影片縮圖：${error.message || error}`, true);
  } finally {
    node.videoThumbnailSaving = false;
  }
}

async function getEagleItemForThumbnail(node) {
  if (typeof node.item?.setCustomThumbnail === "function") return node.item;
  if (typeof eagle === "undefined" || typeof eagle.item?.getById !== "function") {
    return null;
  }
  return eagle.item.getById(node.item.id);
}

function createVideoThumbnailRuntime() {
  const fs = loadNodeModule("fs");
  const path = loadNodeModule("path");
  const writeFile = fs?.promises?.writeFile
    ? (filePath, bytes) => fs.promises.writeFile(filePath, bytes)
    : fs?.writeFile
      ? (filePath, bytes) =>
        new Promise((resolve, reject) => fs.writeFile(filePath, bytes, (error) => {
          if (error) reject(error);
          else resolve();
        }))
      : null;
  const removeFile = fs?.promises?.unlink
    ? (filePath) => fs.promises.unlink(filePath)
    : fs?.unlink
      ? (filePath) =>
        new Promise((resolve, reject) => fs.unlink(filePath, (error) => {
          if (error) reject(error);
          else resolve();
        }))
      : null;

  const getTempDirectory = async () => {
    if (typeof eagle === "undefined") return null;

    if (typeof eagle.app?.getPath === "function") {
      try {
        const directory = await eagle.app.getPath("temp");
        if (directory) return directory;
      } catch (error) {
        console.warn("Failed to read Eagle temp path", error);
      }
    }

    if (typeof eagle.os?.tmpdir === "function") {
      try {
        const directory = await eagle.os.tmpdir();
        if (directory) return directory;
      } catch (error) {
        console.warn("Failed to read operating system temp path", error);
      }
    }

    const environment = eagle.app?.env || {};
    return environment.TEMP || environment.TMP || environment.TMPDIR || null;
  };

  return {
    document: typeof document === "undefined" ? null : document,
    getTempDirectory,
    joinPath: path?.join,
    writeFile,
    removeFile,
  };
}

function readPdfFile(item) {
  const fs = loadNodeModule("fs");
  if (!fs) return null;
  const source = String(item?.filePath || item?.fileURL || "").trim();
  if (!source) return null;
  const url = loadNodeModule("url");
  let filePath = source;
  if (source.startsWith("file://") && typeof url?.fileURLToPath === "function") {
    filePath = url.fileURLToPath(source);
  }
  if (fs.promises?.readFile) return fs.promises.readFile(filePath);
  if (typeof fs.readFile !== "function") return null;
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
}

function loadNodeModule(name) {
  const nodeRequire =
    typeof require === "function"
      ? require
      : typeof globalThis?.require === "function"
        ? globalThis.require
        : typeof module === "object" && typeof module.require === "function"
          ? module.require.bind(module)
          : null;
  const candidates = [name];
  if (!String(name).startsWith("node:")) candidates.push(`node:${name}`);
  if (nodeRequire) {
    for (const candidate of candidates) {
      try {
        return nodeRequire(candidate);
      } catch {
        // Some Electron/Eagle runtimes expose native modules only through node: specifiers.
      }
    }
  }

  const getBuiltinModule = globalThis?.process?.getBuiltinModule;
  if (typeof getBuiltinModule === "function") {
    for (const candidate of candidates) {
      try {
        return getBuiltinModule(candidate.replace(/^node:/, ""));
      } catch {
        // Newer Node runtimes can expose built-ins without exposing require globally.
      }
    }
  }
  return null;
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
  const displayHeight = node.mediaHeight + (isPlayableNode(node) ? getVideoControlsHeight() : 0);

  state.camera.scale = scale;
  state.camera.x = viewportWidth / 2 - (node.x + node.width / 2) * scale;
  state.camera.y = viewportHeight / 2 - (node.y + displayHeight / 2) * scale;
  viewportMedia.noteMotion("pan");
  updateCamera();
  selectionNavigation.selectNodeAtViewportCenter();
  viewportMedia.cameraChanged();
}

function clearBoard({ recordHistory = false } = {}) {
  if (recordHistory) recordBoardHistory();
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
  elements.itemCount.textContent = isPdfBoardActive() ? `${count} 個 PDF 頁面` : `${count} 個素材`;
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
    for (const node of state.mountedLabelNodes) refreshMediaMetadata(node);
    updateSelectionStatus();
  } catch (error) {
    console.warn("Failed to load Eagle folder names", error);
  }
}

function getSelectedNodeList() {
  const selectedNodes = [...(state.selectedNodes || [])];
  if (selectedNodes.length && state.selectedNode) {
    return [
      state.selectedNode,
      ...selectedNodes.filter((node) => node !== state.selectedNode),
    ];
  }
  if (selectedNodes.length) return selectedNodes;
  return state.selectedNode ? [state.selectedNode] : [];
}

function getCommonMetadataValues(nodes, property) {
  if (!nodes.length) return [];
  const common = new Set(normalizeTags(nodes[0].item[property]));
  for (const node of nodes.slice(1)) {
    const values = new Set(normalizeTags(node.item[property]));
    for (const value of common) {
      if (!values.has(value)) common.delete(value);
    }
  }
  return normalizeTags([...common]);
}

function updateSelectionStatus() {
  if (!elements.selectionStatus) return;
  const selectedNodes = getSelectedNodeList();
  const item = state.selectedNode?.item;
  const hasSelection = Boolean(item);
  const isMultiple = selectedNodes.length > 1;
  elements.selectionEmpty.hidden = hasSelection;
  elements.selectionDetails.hidden = !hasSelection;
  if (!item) {
    elements.selectionDetails.classList.remove("has-selection-tags");
    elements.selectionRating.hidden = false;
    elements.selectionTags.hidden = false;
    elements.selectionTagsDivider.hidden = false;
    renderSelectionTags([]);
    elements.selectionFolders.replaceChildren();
    elements.selectionFolders.hidden = true;
    elements.selectionFoldersDivider.hidden = true;
    elements.selectionAddTag.hidden = true;
    elements.selectionAddFolder.hidden = true;
    return;
  }

  if (isPdfBoardActive() || isPdfPageNode(state.selectedNode)) {
    const name = isMultiple ? `${selectedNodes.length} 個 PDF 頁面` : item.name || "PDF 頁面";
    const dimensions = isMultiple ? "" : formatItemDimensions(item);
    elements.selectionName.textContent = name;
    elements.selectionName.title = name;
    elements.selectionDimensions.hidden = !dimensions;
    elements.selectionDimensionsDivider.hidden = !dimensions;
    elements.selectionDimensions.textContent = dimensions;
    elements.selectionRating.replaceChildren();
    elements.selectionRating.hidden = true;
    elements.selectionTags.replaceChildren();
    elements.selectionTags.hidden = true;
    elements.selectionTagsDivider.hidden = true;
    elements.selectionAddTag.hidden = true;
    elements.selectionFolders.replaceChildren();
    elements.selectionFolders.hidden = true;
    elements.selectionFoldersDivider.hidden = true;
    elements.selectionAddFolder.hidden = true;
    elements.selectionDetails.classList.remove("has-selection-tags");
    return;
  }

  const name = isMultiple ? `${selectedNodes.length} 個素材` : item.name || "未命名";
  const dimensions = isMultiple ? "" : formatItemDimensions(item);
  const rating = getItemRating(item);
  const tags = isMultiple
    ? getCommonMetadataValues(selectedNodes, "tags")
    : normalizeTags(item.tags);
  elements.selectionDetails.classList.toggle("has-selection-tags", tags.length > 0);
  const folders = isMultiple
    ? getCommonMetadataValues(selectedNodes, "folders").map((value) => ({
        value,
        label: state.folderNames.get(value) || value,
      }))
    : getFolderMetadataEntries(item);

  elements.selectionName.textContent = name;
  elements.selectionName.title = name;
  elements.selectionDimensions.hidden = !dimensions;
  elements.selectionDimensionsDivider.hidden = !dimensions;
  elements.selectionDimensions.textContent = dimensions;
  elements.selectionRating.replaceChildren();
  elements.selectionRating.hidden = false;
  if (isMultiple) createBulkRatingControls(elements.selectionRating, selectedNodes);
  else createRatingControls(elements.selectionRating, state.selectedNode);
  elements.selectionRating.title = isMultiple
    ? `批次評分 ${selectedNodes.length} 個素材`
    : `評分 ${rating} / 5`;
  renderSelectionTags(tags);
  elements.selectionAddTag.hidden = false;
  elements.selectionAddTag.disabled = selectedNodes.some((node) => node.isSaving);
  elements.selectionFolders.hidden = folders.length === 0;
  elements.selectionFoldersDivider.hidden = folders.length === 0;
  elements.selectionAddFolder.hidden = false;
  elements.selectionAddFolder.disabled = selectedNodes.some((node) => node.isSaving);
  elements.selectionFolders.replaceChildren(
    ...folders.map(({ value, label }) =>
      createSelectionExploreButton({ type: "folder", value, label }),
    ),
  );
  elements.selectionFolders.title = folders.map(({ label }) => label).join(" / ");
}

function updateCamera() {
  if (state.cameraFrame !== null) return;
  state.cameraFrame = requestAnimationFrame(renderCamera);
}

function handleResize() {
  tagEditor.close();
  folderPicker.close();
  selectionTagOverflow.close();
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
  fitSelectionTags();
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
  if (state.isPanning) return;
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
  viewportMedia.cameraChanged();
}

function runSettledViewportWork() {
  updateLabels();
  selectionNavigation.selectNodeAtViewportCenter();
  if (canUseParentBoardActions()) maybeLoadNextUnratedRow();
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
      (isPlayableNode(board.nodes[0]) ? getVideoControlsHeight() : 0)
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
