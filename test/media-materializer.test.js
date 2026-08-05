"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createElementStub } = require("../test-support/plugin-harness.js");
const { createMediaMaterializer } = require("../media-materializer.js");

function createQueueProbe() {
  const states = new Map();
  const requests = [];
  const disposed = [];
  return {
    disposed,
    requests,
    register(node) {
      states.set(node, {
        loading: false,
        queued: false,
        pendingQuality: null,
        readyQuality: null,
      });
    },
    request(node, quality) {
      const state = states.get(node);
      if (!state) return false;
      requests.push({ node, quality });
      state.loading = true;
      state.loadingQuality = quality;
      return true;
    },
    retry(node, quality) {
      return this.request(node, quality);
    },
    snapshot(node) {
      return states.get(node) || null;
    },
    cancel() {},
    dispose(node) {
      disposed.push(node);
      states.delete(node);
    },
  };
}

function createHarness() {
  const createdElements = [];
  const world = createElementStub("div");
  const document = {
    createElement(tag) {
      const element = createElementStub(tag);
      createdElements.push(element);
      return element;
    },
  };
  const queue = createQueueProbe();
  const clicks = [];
  const materializer = createMediaMaterializer({
    document,
    window: {
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    world,
    mediaLoadQueue: queue,
    onPositionNode() {},
    onClickNode(node, modifiers) {
      clicks.push({ node, modifiers });
    },
    onSelectNode() {},
    onOpenContextMenu() {},
    onLayoutChange() {},
    getVideoControlsHeight: () => 8,
    getVideoVolume: () => 1,
    onVolumeChange() {},
    showToast() {},
    debugLog() {},
    startVideoPlayer() {},
  });
  return { clicks, createdElements, materializer, queue, world };
}

function createNode(id = "item-1") {
  return {
    item: {
      id,
      name: `${id}.jpg`,
      ext: "jpg",
      fileURL: `file:///${id}.jpg`,
      thumbnailURL: `file:///${id}-thumb.jpg`,
    },
    width: 200,
    mediaHeight: 120,
    height: 120,
    rotation: 0,
    isVideo: false,
  };
}

test("media materializer owns card mounting, loading, and release", () => {
  const harness = createHarness();
  const node = createNode();

  harness.materializer.mount(node);
  harness.materializer.preloadSelected(node);

  assert.equal(harness.world.children.length, 1);
  assert.equal(node.element.className, "media-card");
  assert.deepEqual(harness.queue.requests.map(({ quality }) => quality), ["original"]);

  harness.materializer.sync({
    visibleNodes: [],
    retainedNodes: [],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });

  assert.equal(harness.world.children.length, 0);
  assert.equal(node.element, null);
  assert.deepEqual(harness.queue.disposed, [node]);
});

test("quality sync requests a better source without remounting the card", () => {
  const harness = createHarness();
  const node = createNode();

  harness.materializer.mount(node);
  const card = node.element;
  harness.queue.requests.length = 0;

  harness.materializer.syncQuality({
    loadNodes: [node],
    getQuality: () => "original",
  });

  assert.equal(node.element, card);
  assert.equal(harness.world.children.length, 1);
  assert.deepEqual(harness.queue.requests, [{ node, quality: "original" }]);
  assert.deepEqual(harness.queue.disposed, []);
});

test("media card click forwards selection modifiers", () => {
  const harness = createHarness();
  const node = createNode();
  harness.materializer.mount(node);

  node.element.emit("click", { ctrlKey: true, metaKey: false, shiftKey: true });

  assert.deepEqual(harness.clicks, [{
    node,
    modifiers: { ctrlKey: true, metaKey: false, shiftKey: true },
  }]);
});
