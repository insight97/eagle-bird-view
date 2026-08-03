"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewBoard = require("../board-state.js");
const BirdViewCore = require("../bird-view-core.js");
const BirdViewMedia = require("../media-load-queue.js");
const BirdViewMaterializer = require("../media-materializer.js");
const BirdViewExploration = require("../exploration-source.js");
const BirdViewAutoExploreSettings = require("../auto-explore-settings.js");
const BirdViewSettingsPresets = require("../settings-presets.js");
const BirdViewRowLoad = require("../row-load-coordinator.js");
const BirdViewSelectionTags = require("../selection-tag-overflow.js");
const BirdViewFolderBrowser = require("../folder-browser.js");

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
  "#folder-browser",
  "#folder-browser-toggle",
  "#folder-browser-search",
  "#folder-browser-include-subfolders",
  "#folder-browser-status",
  "#folder-browser-tree",
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
  };
  return element;
}

function createPluginHarness({
  selectedItems = null,
  aiSearch = null,
  storage = null,
  folderTree = [],
  folderSelectionApi = true,
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

  const context = {
    BirdViewBoard,
    BirdViewCore,
    BirdViewMedia,
    BirdViewMaterializer,
    BirdViewAutoExploreSettings,
    BirdViewSettingsPresets,
    BirdViewRowLoad,
    BirdViewSelectionTags,
    BirdViewFolderBrowser,
    // Real filter helpers, stubbed item sources.
    BirdViewExploration: { ...BirdViewExploration, RelatedItemSource, UnratedItemSource },
    BirdViewFolder: {
      FolderItemSource: class {
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
      },
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
    BirdViewTagEditor: { TagEditor },
    BirdViewFolderPicker: { FolderPicker },
    BirdViewCamera: {
      createCameraNavigation(options) {
        navigationState = options.state;
        cameraUpdate = options.updateCamera;
        return {
          animateCameraTo() {},
          cancelCameraFocus() {},
          fitSelectedRowInViewport() {},
          focusSelectedNodeAtRowScale(node) {
            if (navigationProbe) focusedNodeId = node?.item?.id || null;
          },
          getKeyboardPanStep() { return 240; },
          handleKeyUp() {
            if (smoothZoomProbe) options.onSmoothZoomEnd?.();
          },
          handleWindowBlur() {},
          panBy() {},
          panOneViewport() {},
          startSmoothKeyboardPan() {},
          startSmoothKeyboardZoom() {
            options.onSmoothZoomStart?.();
            if (!smoothZoomProbe) return;
            options.state.camera.scale = 2;
            options.updateCamera?.();
          },
          stopSmoothKeyboardPan() {},
          stopSmoothKeyboardZoom() {
            options.onSmoothZoomEnd?.();
          },
          zoomAtPoint() {},
        };
      },
    },
    BirdViewSelection: {
      createSelectionNavigation(options) {
        if (navigationProbe) {
          const readRows = options.getRows || (() => options.state.rows);

          function setSelectedNode(node) {
            if (!node) return;
            const previousNode = options.state.selectedNode;
            options.state.selectedNode = node;
            selectedNodeId = node.item.id;
            options.onSelectNode?.(node, {
              changed: node !== previousNode,
              previousNode,
              preserveVerticalNavigation: false,
            });
          }

          return {
            clearSelection() {
              const previousNode = options.state.selectedNode;
              options.state.selectedNode = null;
              selectedNodeId = null;
              options.onClearSelection?.(previousNode);
            },
            moveSelection(direction) {
              if (!options.state.selectedNode) return null;
              const node = BirdViewCore.findDirectionalNeighbor(
                readRows(),
                options.state.selectedNode,
                direction,
                { wrapRows: true, layoutDirection: options.state.layoutDirection },
              );
              if (node) setSelectedNode(node);
              return node || null;
            },
            selectNodeAtViewportCenter() {
              const center = BirdViewCore.getViewportWorldCenter(options.state.camera, {
                width: options.elements.viewport.clientWidth,
                height: options.elements.viewport.clientHeight,
              });
              const node = BirdViewCore.findNearestNodeInRows(readRows(), center);
              if (node) setSelectedNode(node);
            },
            setSelectedNode,
          };
        }
        return {
          clearSelection() {},
          moveSelection() { return null; },
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
        async get() {
          return [];
        },
        async open() {},
      },
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
    performance: { now: () => 0 },
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
    fireTimer(delay) {
      const index = timers.findIndex((timer) => timer.delay === delay);
      if (index === -1) throw new Error(`no timer scheduled with delay ${delay}`);
      const [timer] = timers.splice(index, 1);
      timer.callback();
    },
    // Runs the timers scheduled so far, which is what drives the deferred
    // viewport work that mounts media cards and labels.
    flushTimers() {
      for (const timer of timers.splice(0, timers.length)) timer.callback();
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
    start() {
      domReady();
      pluginCreate();
    },
  };
}

module.exports = { createElementStub, createPluginHarness };
