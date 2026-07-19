"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BirdViewCore = require("../bird-view-core.js");

test("a library change invalidates and restarts selected item loading", () => {
  let domReady;
  let pluginCreate;
  let libraryChanged;
  let selectedRequests = 0;
  const elements = new Map();
  const createElementStub = () => ({
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() {},
    style: { setProperty() {} },
    clientWidth: 1200,
    clientHeight: 800,
  });
  for (const id of [
    "#viewport",
    "#world",
    "#grid",
    "#labels",
    "#empty-state",
    "#item-count",
    "#zoom-label",
    "#explore-button",
    "#toast",
  ]) {
    elements.set(id, createElementStub());
  }

  class MediaLoadQueue {}
  class RelatedItemSource {
    clear() {}
  }
  class TagEditor {
    close() {}
  }
  const context = {
    BirdViewCore,
    BirdViewMedia: { MediaLoadQueue, waitForImageDecode() {} },
    BirdViewExploration: { RelatedItemSource },
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
          return new Promise(() => {});
        },
      },
      onPluginCreate(callback) {
        pluginCreate = callback;
      },
      onLibraryChanged(callback) {
        libraryChanged = callback;
      },
    },
    window: {
      addEventListener() {},
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

  libraryChanged();
  assert.equal(selectedRequests, 2);
});
