"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewBoard = require("../board-state.js");
const BirdViewBoardHistory = require("../board-history.js");
const BirdViewCore = require("../bird-view-core.js");
const BirdViewMedia = require("../media-load-queue.js");
const BirdViewMaterializer = require("../media-materializer.js");
const BirdViewViewportWork = require("../viewport-work-scheduler.js");
const BirdViewViewportMedia = require("../viewport-media-controller.js");
const BirdViewExploration = require("../exploration-source.js");
const BirdViewAutoExploreSettings = require("../auto-explore-settings.js");
const BirdViewSettingsPresets = require("../settings-presets.js");
const BirdViewSettingsSnapshot = require("../settings-snapshot.js");
const BirdViewRowLoad = require("../row-load-coordinator.js");
const BirdViewSelectionTags = require("../selection-tag-overflow.js");
const BirdViewFolder = require("../folder-item-source.js");
const BirdViewFolderBrowser = require("../folder-browser.js");
const BirdViewFolderContent = require("../folder-content-intake.js");
const BirdViewLibraryContent = require("../library-content-target.js");
const BirdViewVideoThumbnail = require("../video-thumbnail.js");
const BirdViewSelection = require("../selection-navigation.js");
const BirdViewMetadata = require("../metadata-committer.js");
const BirdViewPdfRuntime = require("../pdf-runtime.js");
const BirdViewPdfBoard = require("../pdf-board.js");

const PLUGIN_SOURCE = fs.readFileSync(path.resolve(__dirname, "../plugin.js"), "utf8");
const SELECTORS = [
  ".app",
  "#viewport",
  "#world",
  "#grid",
  "#labels",
  "#empty-state",
  "#item-count",
  "#zoom-label",
  "#selection-status",
  "#selection-empty",
  "#selection-details",
  "#selection-name",
  "#selection-dimensions-divider",
  "#selection-dimensions",
  "#selection-rating",
  "#selection-tags-divider",
  "#selection-tags",
  "#selection-add-tag",
  "#selection-folders-divider",
  "#selection-folders",
  "#selection-add-folder",
  "#auto-explore-toggle",
  "#auto-explore-status",
  "#seamless-mode-toggle",
  "#seamless-mode-status",
  "#toolbar-preset-select",
  "#auto-explore-settings-button",
  "#auto-explore-settings-panel",
  "#auto-explore-min-rating",
  "#auto-explore-max-rating",
  "#auto-explore-folder-match",
  "#auto-explore-include-subfolders",
  "#auto-explore-folder-search",
  "#auto-explore-folder-options",
  "#auto-explore-selected-folders",
  "#auto-explore-folder-summary",
  "#auto-explore-filter-summary",
  "#auto-explore-tag-group-match",
  "#auto-explore-tag-groups",
  "#auto-explore-add-tag-group",
  "#settings-preset-select",
  "#settings-preset-name",
  "#settings-preset-save",
  "#settings-preset-update",
  "#settings-preset-delete",
  "#settings-preset-status",
  "#ai-exploration-ratio",
  "#ai-exploration-ratio-value",
  "#ai-similarity-max",
  "#ai-similarity-max-value",
  "#exploration-diversity-strength",
  "#exploration-diversity-strength-value",
  "#board-layout-direction",
  "#board-layout-width",
  "#board-layout-width-value",
  "#board-exploration-max-items",
  "#board-exploration-max-items-value",
  "#smooth-pan-toggle",
  "#smooth-pan-speed",
  "#smooth-pan-speed-value",
  "#smooth-zoom-toggle",
  "#smooth-zoom-speed",
  "#smooth-zoom-speed-value",
  "#keyboard-acceleration",
  "#focus-media-size",
  "#focus-media-size-value",
  "#video-autoplay-toggle",
  "#auto-explore-file-type-image",
  "#auto-explore-file-type-video",
  "#auto-explore-file-type-audio",
  "#auto-explore-rating",
  "#auto-explore-tag-match",
  "#auto-explore-max-tag-count",
  "#auto-explore-tag-search",
  "#auto-explore-tag-options",
  "#auto-explore-selected-tags",
  "#auto-explore-excluded-tag-search",
  "#auto-explore-excluded-tag-options",
  "#auto-explore-selected-excluded-tags",
  ".auto-explore-controls",
  "#auto-explore-settings-reset",
  "#explore-button",
  "#folder-load-more-button",
  "#board-history-back-button",
  "#board-history-forward-button",
  "#pdf-board-back-button",
  "#pdf-board-breadcrumb",
  "#folder-browser",
  "#folder-browser-toggle",
  "#folder-browser-tab-folder",
  "#folder-browser-tab-tag",
  "#folder-browser-tab-extension",
  "#folder-browser-panel-folder",
  "#folder-browser-panel-tag",
  "#folder-browser-panel-extension",
  "#folder-browser-search",
  "#folder-browser-include-subfolders",
  "#folder-browser-status",
  "#folder-browser-tree",
  "#folder-browser-tag-search",
  "#folder-browser-tag-sort",
  "#folder-browser-tag-list",
  "#folder-browser-extension-list",
  "#toast",
];

function toDataAttributeName(key) {
  return `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

// Supports the selector shapes plugin.js actually uses: tag names, ".class",
// "#id", "[attribute]", "[attribute='value']" and comma separated groups.
function matchesSelector(element, selector) {
  return selector
    .split(",")
    .some((candidate) => matchesSimpleSelector(element, candidate.trim()));
}

function matchesSimpleSelector(element, selector) {
  if (!selector) return false;
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith("[")) {
    const match = /^\[([^=\]]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/.exec(selector);
    if (!match) return false;
    const value = element.getAttribute(match[1]);
    return match[2] === undefined ? value !== null : value === match[2];
  }
  return element.tagName === selector.toUpperCase();
}

function collectDescendants(element, found = []) {
  for (const child of element.children) {
    found.push(child);
    collectDescendants(child, found);
  }
  return found;
}

function createElementStub(tag = "div") {
  const listeners = new Map();
  const attributes = new Map();
  const classNames = new Set();
  const style = {
    setProperty(name, value) {
      style[name] = value;
    },
    removeProperty(name) {
      delete style[name];
    },
  };
  const element = {
    tagName: String(tag).toUpperCase(),
    id: "",
    children: [],
    parentNode: null,
    isConnected: false,
    hidden: false,
    textContent: "",
    value: "",
    title: "",
    checked: false,
    disabled: false,
    clientWidth: 1200,
    clientHeight: 800,
    style,
    dataset: new Proxy(
      {},
      {
        get: (_, key) => attributes.get(toDataAttributeName(key)),
        set: (_, key, value) => {
          attributes.set(toDataAttributeName(key), String(value));
          return true;
        },
        has: (_, key) => attributes.has(toDataAttributeName(key)),
        deleteProperty: (_, key) => attributes.delete(toDataAttributeName(key)),
      },
    ),
    classList: {
      add(...names) {
        for (const name of names) classNames.add(name);
      },
      remove(...names) {
        for (const name of names) classNames.delete(name);
      },
      toggle(name, force) {
        const shouldAdd = force ?? !classNames.has(name);
        if (shouldAdd) classNames.add(name);
        else classNames.delete(name);
        return shouldAdd;
      },
      contains(name) {
        return classNames.has(name);
      },
    },
    get className() {
      return [...classNames].join(" ");
    },
    set className(value) {
      classNames.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean)) classNames.add(name);
    },
    get childElementCount() {
      return element.children.length;
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    emit(type, eventLike = {}) {
      const event = {
        type,
        target: element,
        preventDefault() {},
        stopPropagation() {},
        ...eventLike,
      };
      for (const callback of [...(listeners.get(type) || [])]) callback(event);
      return event;
    },
    click() {
      element.emit("click");
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = element;
        node.isConnected = true;
        element.children.push(node);
      }
    },
    remove() {
      if (!element.parentNode) return;
      const index = element.parentNode.children.indexOf(element);
      if (index !== -1) element.parentNode.children.splice(index, 1);
      element.parentNode = null;
      element.isConnected = false;
    },
    replaceWith(...nodes) {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(element);
      if (index === -1) return;
      parent.children.splice(index, 1, ...nodes);
      for (const node of nodes) {
        node.parentNode = parent;
        node.isConnected = true;
      }
      element.parentNode = null;
      element.isConnected = false;
    },
    replaceChildren(...nodes) {
      element.children.length = 0;
      element.append(...nodes);
    },
    querySelector(selector) {
      return (
        collectDescendants(element).find((child) => matchesSelector(child, selector)) || null
      );
    },
    querySelectorAll(selector) {
      return collectDescendants(element).filter((child) => matchesSelector(child, selector));
    },
    closest(selector) {
      for (let current = element; current; current = current.parentNode) {
        if (matchesSelector(current, selector)) return current;
      }
      return null;
    },
    contains(other) {
      return other === element || collectDescendants(element).includes(other);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: element.clientWidth, height: element.clientHeight };
    },
    scrollIntoView() {},
    focus() {},
    // Canvas support, so cards can paint bounded rasters. `transferred` records
    // the bitmap handed over, which is what tests assert on.
    width: 0,
    height: 0,
    transferred: null,
    getContext(kind) {
      if (element.tagName !== "CANVAS") return null;
      if (kind === "bitmaprenderer") {
        return {
          transferFromImageBitmap(bitmap) {
            element.transferred = bitmap;
          },
        };
      }
      if (kind === "2d") {
        return {
          drawImage(bitmap) {
            element.transferred = bitmap;
          },
        };
      }
      return null;
    },
  };
  return element;
}

function createPluginHarness({
  selectedItems = null,
  aiSearch = null,
  pdfjsLib = null,
  storage = null,
  folderTree = [],
  tags = [],
  tagGroups = null,
  libraryItems = null,
  tagSourceResult = [],
  extensionSourceResult = [],
  folderSelectionApi = true,
  folderSourceImplementation = null,
  videoThumbnailImplementation = null,
  runAnimationFrames = false,
  navigationProbe = false,
  smoothZoomProbe = false,
  // Tests that exercise plugin.js error paths can mute the expected logging so
  // a passing run does not look like a failing one.
  quiet = false,
} = {}) {
  let domReady;
  let pluginCreate;
  let libraryChanged;
  let pluginRun;
  let selectedRequests = 0;
  let unratedRequests = 0;
  let folderLoadRequests = 0;
  let folderSelectionRequests = 0;
  let folderSelectionOptions = [];
  let folderSourceResult = { folders: [], items: [] };
  let currentTagSourceResult = tagSourceResult;
  let tagLoadRequests = 0;
  let extensionLoadRequests = 0;
  let fullScreen = false;
  let fullScreenCalls = 0;
  let selectedNodeId = null;
  let focusedNodeId = null;
  let videoStartRequests = 0;
  let videoPlayCalls = 0;
  let videoPauseCalls = 0;
  let tagEditorOpenCalls = 0;
  let folderPickerOpenCalls = 0;
  let navigationState = null;
  let cameraUpdate = null;
  let nextTimerId = 1;
  const timers = [];
  // Firing a timer means that much time passed. The plugin reads the clock to
  // decide whether the camera has stopped moving, so a frozen clock would leave
  // it looking permanently in motion.
  let clock = 0;
  const createdElements = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const selectedResolvers = [];
  const folderResolvers = [];
  const folderRequests = [];
  const elements = new Map(SELECTORS.map((selector) => [selector, createElementStub()]));
  elements.get("#folder-browser-include-subfolders").checked = true;

  class RelatedItemSource {
    clear() {}
  }
  class UnratedItemSource {
    clear() {}
    async findNextRow() {
      unratedRequests += 1;
      return [];
    }
  }
  class TagEditor {
    open() { tagEditorOpenCalls += 1; }
    close() {}
    closeForNode() {}
    refresh() {}
  }
  class FolderPicker {
    open() { folderPickerOpenCalls += 1; }
    close() {}
    closeForNode() {}
  }

  const DefaultFolderItemSource = class {
    constructor(itemApi) {
      this.summarySource = new BirdViewFolder.FolderItemSource(itemApi, null);
    }
    async loadLibrarySummary(folders) {
      return this.summarySource.loadLibrarySummary(folders);
    }
    async getSelectedFolders() {
      folderLoadRequests += 1;
      return [];
    }
    async loadSelected() {
      folderLoadRequests += 1;
      return folderSourceResult;
    }
    async loadFolders(folders, options) {
      folderSelectionRequests += 1;
      folderSelectionOptions.push({ folders, options });
      return folderSourceResult;
    }
    async hydrate(items) {
      return items;
    }
  };
  const context = {
    BirdViewBoard,
    BirdViewBoardHistory,
    BirdViewCore,
    BirdViewMedia,
    BirdViewMaterializer,
    BirdViewViewportWork,
    BirdViewViewportMedia,
    BirdViewAutoExploreSettings,
    BirdViewSettingsPresets,
    BirdViewSettingsSnapshot,
    BirdViewRowLoad,
    BirdViewMetadata,
    BirdViewPdfRuntime,
    BirdViewPdfBoard,
    BirdViewSelectionTags,
    BirdViewFolderBrowser,
    BirdViewFolderContent,
    BirdViewLibraryContent,
    BirdViewVideoThumbnail: {
      ...BirdViewVideoThumbnail,
      createVideoThumbnailService() {
        return videoThumbnailImplementation || {
          async setFromVideo() {
            return { status: "unavailable", reason: "runtime-unavailable" };
          },
        };
      },
    },
    // Real filter helpers, stubbed item sources.
    BirdViewExploration: { ...BirdViewExploration, RelatedItemSource, UnratedItemSource },
    BirdViewFolder: {
      FolderItemSource: folderSourceImplementation || DefaultFolderItemSource,
    },
    BirdViewVideo: {
      startVideoPlayer({ node }) {
        videoStartRequests += 1;
        node.videoElement = {
          paused: false,
          play() {
            videoPlayCalls += 1;
            this.paused = false;
            return Promise.resolve();
          },
          pause() {
            videoPauseCalls += 1;
            this.paused = true;
          },
          load() {},
          removeAttribute() {},
        };
        node.playPlayback = () => node.videoElement.play();
        node.pausePlayback = () => node.videoElement.pause();
        node.togglePlayback = () => {
          if (node.videoElement.paused) node.playPlayback();
          else node.pausePlayback();
        };
      },
    },
    pdfjsLib,
    BirdViewTagEditor: { TagEditor },
    BirdViewFolderPicker: { FolderPicker },
    BirdViewCamera: {
      createCameraNavigation(options) {
        navigationState = options.state;
        cameraUpdate = options.updateCamera;
        let smoothPanActive = false;
        let smoothZoomActive = false;
        const finishSmoothPan = () => {
          if (!smoothPanActive) return;
          smoothPanActive = false;
          options.state.smoothPanFrame = null;
          options.onSmoothPanEnd?.();
        };
        const finishSmoothZoom = () => {
          if (!smoothZoomActive) return;
          smoothZoomActive = false;
          options.onSmoothZoomEnd?.();
        };
        return {
          animateCameraTo() {},
          cancelCameraFocus() {},
          fitSelectedRowInViewport() {},
          focusSelectedNodeAtRowScale(node) {
            if (navigationProbe) focusedNodeId = node?.item?.id || null;
          },
          getKeyboardPanStep() { return 240; },
          handleKeyUp() {
            finishSmoothPan();
            if (smoothZoomProbe) finishSmoothZoom();
          },
          handleWindowBlur() {
            finishSmoothPan();
            finishSmoothZoom();
          },
          panBy() {},
          panOneViewport() {},
          startSmoothKeyboardPan() {
            if (smoothPanActive) return;
            smoothPanActive = true;
            options.state.smoothPanFrame = 1;
            options.onSmoothPanStart?.();
          },
          startSmoothKeyboardZoom() {
            if (!smoothZoomActive) {
              smoothZoomActive = true;
              options.onSmoothZoomStart?.();
            }
            if (!smoothZoomProbe) return;
            options.state.camera.scale = 2;
            options.updateCamera?.();
          },
          stopSmoothKeyboardPan() {
            finishSmoothPan();
          },
          stopSmoothKeyboardZoom() {
            finishSmoothZoom();
          },
          zoomAtPoint() {},
        };
      },
    },
    BirdViewSelection: {
      createSelectionNavigation(options) {
        if (navigationProbe) {
          return BirdViewSelection.createSelectionNavigation({
            ...options,
            onSelectNode(node, details) {
              selectedNodeId = node.item.id;
              options.onSelectNode?.(node, details);
            },
            onClearSelection(node, details) {
              selectedNodeId = null;
              options.onClearSelection?.(node, details);
            },
          });
        }
        return {
          clearSelection() {},
          moveSelection() { return null; },
          getSelectedNodes() { return new Set(); },
          isMultipleSelection() { return false; },
          selectNode() {},
          selectNodeAtViewportCenter() {},
          setSelectedNode() {},
        };
      },
    },
    document: {
      addEventListener(type, callback) {
        if (type === "DOMContentLoaded") domReady = callback;
        else documentListeners.set(type, callback);
      },
      removeEventListener(type) {
        documentListeners.delete(type);
      },
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, createElementStub());
        return elements.get(selector);
      },
      createElement(tag) {
        const element = createElementStub(tag);
        createdElements.push(element);
        return element;
      },
    },
    eagle: {
      extraModule: aiSearch ? { aiSearch } : undefined,
      item: {
        getSelected() {
          selectedRequests += 1;
          if (selectedItems) return Promise.resolve(selectedItems);
          return new Promise((resolve) => selectedResolvers.push(resolve));
        },
        async get(options = {}) {
          if (
            options.fields?.includes("folders") &&
            !options.folders?.length &&
            !options.ids?.length
          ) {
            const items = Array.isArray(libraryItems)
              ? libraryItems
              : [...currentTagSourceResult, ...extensionSourceResult];
            return [...new Map(items.map((item) => [item.id, item])).values()];
          }
          if (options.tags?.length) {
            tagLoadRequests += 1;
            return currentTagSourceResult;
          }
          if (options.ext) {
            extensionLoadRequests += 1;
            return extensionSourceResult;
          }
          return [];
        },
        async open() {},
      },
      tag: {
        async get() {
          return tags;
        },
      },
      ...(Array.isArray(tagGroups)
        ? {
            tagGroup: {
              async get() {
                return tagGroups;
              },
            },
          }
        : {}),
      folder: {
        async getAll() {
          return folderTree;
        },
        ...(folderSelectionApi
          ? {
              async getSelected() {
                return [];
              },
            }
          : {}),
        getByIds(ids) {
          folderRequests.push(ids);
          return new Promise((resolve) => folderResolvers.push(resolve));
        },
      },
      onPluginCreate(callback) {
        pluginCreate = callback;
      },
      onPluginRun(callback) {
        pluginRun = callback;
      },
      onLibraryChanged(callback) {
        libraryChanged = callback;
      },
      window: {
        async isFullScreen() {
          return fullScreen;
        },
        async setFullScreen(nextValue) {
          fullScreen = nextValue;
          fullScreenCalls += 1;
        },
      },
    },
    window: {
      addEventListener(type, callback) {
        windowListeners.set(type, callback);
      },
      removeEventListener(type) {
        windowListeners.delete(type);
      },
      setTimeout(callback, delay) {
        const id = nextTimerId++;
        timers.push({ id, callback, delay });
        return id;
      },
      clearTimeout(id) {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      },
    },
    requestAnimationFrame(callback) {
      if (runAnimationFrames) callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    performance: { now: () => clock },
    localStorage: storage || undefined,
    console: quiet ? { ...console, error() {}, warn() {} } : console,
  };

  vm.runInNewContext(PLUGIN_SOURCE, context);

  return {
    createdElements,
    elements,
    folderRequests,
    get folderLoadRequests() { return folderLoadRequests; },
    get folderSelectionRequests() { return folderSelectionRequests; },
    get folderSelectionOptions() { return folderSelectionOptions; },
    get tagLoadRequests() { return tagLoadRequests; },
    get extensionLoadRequests() { return extensionLoadRequests; },
    get fullScreen() { return fullScreen; },
    get fullScreenCalls() { return fullScreenCalls; },
    get camera() { return navigationState?.camera || null; },
    get focusedNodeId() { return focusedNodeId; },
    get selectedNode() { return navigationState?.selectedNode || null; },
    get state() { return navigationState; },
    updateCamera() { cameraUpdate?.(); },
    get videoStartRequests() { return videoStartRequests; },
    get videoPlayCalls() { return videoPlayCalls; },
    get videoPauseCalls() { return videoPauseCalls; },
    get tagEditorOpenCalls() { return tagEditorOpenCalls; },
    get folderPickerOpenCalls() { return folderPickerOpenCalls; },
    get keyDown() { return windowListeners.get("keydown"); },
    get selectedRequests() { return selectedRequests; },
    get selectedNodeId() { return selectedNodeId; },
    get unratedRequests() { return unratedRequests; },
    storage,
    changeLibrary() {
      libraryChanged();
    },
    createdElementsOfTag(tag) {
      const tagName = String(tag).toUpperCase();
      return createdElements.filter((element) => element.tagName === tagName);
    },
    resolvePendingImageLoads() {
      const resolved = new Set();
      for (let attempt = 0; attempt <= createdElements.length; attempt += 1) {
        const pendingImages = createdElements.filter(
          (element) =>
            element.tagName === "IMG" &&
            element.style.visibility === "hidden" &&
            !resolved.has(element),
        );
        if (!pendingImages.length) return;
        for (const image of pendingImages) {
          resolved.add(image);
          image.emit("load");
        }
      }
    },
    fireTimer(delay) {
      const index = timers.findIndex((timer) => timer.delay === delay);
      if (index === -1) throw new Error(`no timer scheduled with delay ${delay}`);
      const [timer] = timers.splice(index, 1);
      clock += timer.delay || 0;
      timer.callback();
    },
    // Runs the timers scheduled so far, which is what drives the deferred
    // viewport work that mounts media cards and labels.
    flushTimers() {
      for (const timer of timers.splice(0, timers.length)) {
        clock += timer.delay || 0;
        timer.callback();
      }
    },
    advanceClock(ms) {
      clock += ms;
    },
    // Runs only the short-interval timers, which is what drives viewport work.
    // A blanket flush would also fire the original-load watchdog and fail loads
    // that are legitimately still in flight.
    flushTimersUnder(maxDelay) {
      const due = timers.filter((timer) => (timer.delay || 0) < maxDelay);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
        clock += timer.delay || 0;
        timer.callback();
      }
    },
    windowEmit(type, eventLike = {}) {
      const callback = windowListeners.get(type);
      if (!callback) return null;
      const event = {
        type,
        target: elements.get("#viewport"),
        preventDefault() {},
        stopPropagation() {},
        ...eventLike,
      };
      callback(event);
      return event;
    },
    pluginRun() {
      pluginRun();
    },
    resolveFolder(index, folders) {
      folderResolvers[index](folders);
    },
    resolveSelected(index, items) {
      selectedResolvers[index](items);
    },
    setFolderSourceResult(result) {
      folderSourceResult = result;
    },
    setTagSourceResult(result) {
      currentTagSourceResult = result;
    },
    start() {
      domReady();
      pluginCreate();
    },
  };
}

module.exports = { createElementStub, createPluginHarness };
