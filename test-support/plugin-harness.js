"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewCore = require("../bird-view-core.js");

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
  "#selection-folders-divider",
  "#selection-folders",
  "#auto-explore-toggle",
  "#auto-explore-status",
  "#seamless-mode-toggle",
  "#seamless-mode-status",
  "#auto-explore-settings-button",
  "#auto-explore-settings-panel",
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
  "#focus-media-size",
  "#focus-media-size-value",
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
  "#toast",
];

function createElementStub() {
  const handlers = new Map();
  const element = {
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
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) {
      handlers.set(type, callback);
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = element;
        node.isConnected = true;
        element.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      element.children.length = 0;
      element.append(...nodes);
    },
    remove() {
      if (!element.parentNode) return;
      const index = element.parentNode.children.indexOf(element);
      if (index !== -1) element.parentNode.children.splice(index, 1);
      element.parentNode = null;
      element.isConnected = false;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    setAttribute() {},
    click() {
      handlers.get("click")?.({ target: element, stopPropagation() {} });
    },
  };
  return element;
}

function createPluginHarness() {
  let domReady;
  let pluginCreate;
  let libraryChanged;
  let pluginRun;
  let keyDown;
  let selectedRequests = 0;
  let unratedRequests = 0;
  let folderLoadRequests = 0;
  let folderSourceResult = { folders: [], items: [] };
  let fullScreen = false;
  let fullScreenCalls = 0;
  const selectedResolvers = [];
  const folderResolvers = [];
  const folderRequests = [];
  const elements = new Map(SELECTORS.map((selector) => [selector, createElementStub()]));

  class MediaLoadQueue {
    snapshot() { return null; }
    register() {}
    dispose() {}
  }
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
    close() {}
    closeForNode() {}
    refresh() {}
  }
  class FolderPicker {
    close() {}
    closeForNode() {}
  }

  const context = {
    BirdViewCore,
    BirdViewMedia: { MediaLoadQueue, waitForImageDecode() {} },
    BirdViewExploration: { RelatedItemSource, UnratedItemSource },
    BirdViewFolder: {
      FolderItemSource: class {
        async loadSelected() {
          folderLoadRequests += 1;
          return folderSourceResult;
        }
        async hydrate(items) {
          return items;
        }
      },
    },
    BirdViewVideo: { startVideoPlayer() {} },
    BirdViewTagEditor: { TagEditor },
    BirdViewFolderPicker: { FolderPicker },
    BirdViewCamera: {
      createCameraNavigation() {
        return {
          animateCameraTo() {},
          cancelCameraFocus() {},
          fitSelectedRowInViewport() {},
          focusSelectedNodeAtRowScale() {},
          getKeyboardPanStep() { return 240; },
          handleKeyUp() {},
          handleWindowBlur() {},
          panBy() {},
          panOneViewport() {},
          startSmoothKeyboardPan() {},
          startSmoothKeyboardZoom() {},
          stopSmoothKeyboardPan() {},
          stopSmoothKeyboardZoom() {},
          zoomAtPoint() {},
        };
      },
    },
    BirdViewSelection: {
      createSelectionNavigation() {
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
      },
      querySelector(selector) {
        return elements.get(selector);
      },
      createElement() {
        return createElementStub();
      },
    },
    eagle: {
      item: {
        getSelected() {
          selectedRequests += 1;
          return new Promise((resolve) => selectedResolvers.push(resolve));
        },
      },
      folder: {
        async getSelected() {
          return [];
        },
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
        if (type === "keydown") keyDown = callback;
      },
      clearTimeout() {},
      setTimeout() { return 1; },
    },
    requestAnimationFrame() { return 1; },
    performance: { now: () => 0 },
    console,
  };

  vm.runInNewContext(PLUGIN_SOURCE, context);

  return {
    elements,
    folderRequests,
    get folderLoadRequests() { return folderLoadRequests; },
    get fullScreen() { return fullScreen; },
    get fullScreenCalls() { return fullScreenCalls; },
    get keyDown() { return keyDown; },
    get selectedRequests() { return selectedRequests; },
    get unratedRequests() { return unratedRequests; },
    changeLibrary() {
      libraryChanged();
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

module.exports = { createPluginHarness };
