"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewCore = require("../bird-view-core.js");

test("auto exploration defaults off and a library change restarts selected item loading", async () => {
  let domReady;
  let pluginCreate;
  let libraryChanged;
  let selectedRequests = 0;
  let unratedRequests = 0;
  const selectedResolvers = [];
  let keyDown;
  let fullScreen = false;
  let fullScreenCalls = 0;
  const elements = new Map();
  const createElementStub = () => {
    const handlers = new Map();
    return {
      addEventListener(type, callback) { handlers.set(type, callback); },
      classList: { add() {}, remove() {}, toggle() {} },
      replaceChildren() {},
      setAttribute() {},
      style: { setProperty() {} },
      clientWidth: 1200,
      clientHeight: 800,
      click() { handlers.get("click")?.(); },
    };
  };
  for (const id of [
    "#viewport",
    "#world",
    "#grid",
    "#labels",
    "#empty-state",
    "#item-count",
    "#zoom-label",
    "#seamless-mode-toggle",
    "#seamless-mode-status",
    "#auto-explore-toggle",
    "#auto-explore-status",
    "#explore-button",
    "#toast",
  ]) {
    elements.set(id, createElementStub());
  }

  class MediaLoadQueue {}
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
  }
  const context = {
    BirdViewCore,
    BirdViewMedia: { MediaLoadQueue, waitForImageDecode() {} },
    BirdViewExploration: { RelatedItemSource, UnratedItemSource },
    BirdViewVideo: { startVideoPlayer() {} },
    BirdViewTagEditor: { TagEditor },
    document: {
      addEventListener(type, callback) {
        if (type === "DOMContentLoaded") domReady = callback;
      },
      querySelector(selector) {
        return elements.get(selector);
      },
    },
    eagle: {
      item: {
        getSelected() {
          selectedRequests += 1;
          return new Promise((resolve) => selectedResolvers.push(resolve));
        },
      },
      onPluginCreate(callback) {
        pluginCreate = callback;
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
    Set,
    Map,
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../plugin.js"), "utf8");
  vm.runInNewContext(source, context);

  domReady();
  pluginCreate();
  assert.equal(selectedRequests, 1);
  selectedResolvers[0]([]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(unratedRequests, 0);
  assert.equal(elements.get("#auto-explore-status").textContent, "關");

  let prevented = false;
  keyDown({
    key: "F11",
    repeat: false,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(fullScreen, true);
  assert.equal(fullScreenCalls, 1);

  keyDown({ key: "F11", repeat: true, target: null, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullScreen, true);
  assert.equal(fullScreenCalls, 1);

  keyDown({ key: "F11", repeat: false, target: null, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullScreen, false);
  assert.equal(fullScreenCalls, 2);

  let insertPrevented = false;
  keyDown({
    key: "Insert",
    repeat: false,
    target: null,
    preventDefault() {
      insertPrevented = true;
    },
  });
  await Promise.resolve();
  assert.equal(insertPrevented, true);
  assert.equal(unratedRequests, 1);
  assert.equal(elements.get("#auto-explore-status").textContent, "開");

  keyDown({ key: "Insert", repeat: true, target: null, preventDefault() {} });
  await Promise.resolve();
  assert.equal(elements.get("#auto-explore-status").textContent, "開");

  keyDown({ key: "Insert", repeat: false, target: null, preventDefault() {} });
  assert.equal(elements.get("#auto-explore-status").textContent, "關");

  let deletePrevented = false;
  keyDown({
    key: "Delete",
    repeat: false,
    target: null,
    preventDefault() {
      deletePrevented = true;
    },
  });
  assert.equal(deletePrevented, true);
  assert.equal(elements.get("#seamless-mode-status").textContent, "開");

  keyDown({ key: "Delete", repeat: true, target: null, preventDefault() {} });
  assert.equal(elements.get("#seamless-mode-status").textContent, "開");

  keyDown({ key: "Delete", repeat: false, target: null, preventDefault() {} });
  assert.equal(elements.get("#seamless-mode-status").textContent, "關");

  elements.get("#auto-explore-toggle").click();
  await Promise.resolve();
  assert.equal(unratedRequests, 2);
  assert.equal(elements.get("#auto-explore-status").textContent, "開");

  libraryChanged();
  assert.equal(selectedRequests, 2);
});
