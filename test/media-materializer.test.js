"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createElementStub } = require("../test-support/plugin-harness.js");
const { createMediaMaterializer } = require("../media-materializer.js");
const { MediaLoadQueue } = require("../media-load-queue.js");

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

// Eagle serves full-resolution masters, so a card that paints one directly makes
// the compositor re-decode tens of megapixels every time it rasters. These cover
// the bounded raster that replaces the master before it reaches the screen.
function createRasterHarness({ screenLongEdge = 400 } = {}) {
  const createdElements = [];
  const world = createElementStub("div");
  const document = {
    createElement(tag) {
      const element = createElementStub(tag);
      createdElements.push(element);
      return element;
    },
  };
  const downscaleCalls = [];
  const revoked = [];
  let rasterCount = 0;
  const imageDownscaler = {
    isSupported: () => true,
    canRenderFromURL: () => true,
    async renderFromURL(url, size) {
      downscaleCalls.push({ source: "file", url, ...size });
      rasterCount += 1;
      return `blob:raster-${rasterCount}`;
    },
    async renderFromImage(image, size) {
      downscaleCalls.push({ source: "element", image, ...size });
      rasterCount += 1;
      return `blob:raster-${rasterCount}`;
    },
    revoke(url) {
      if (url) revoked.push(url);
    },
  };
  let longEdge = screenLongEdge;
  const timers = new Map();
  let timerId = 0;
  const mediaLoadQueue = new MediaLoadQueue({ maxConcurrent: 4 });
  const materializer = createMediaMaterializer({
    document,
    window: {
      setTimeout(callback) {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    world,
    mediaLoadQueue,
    imageDownscaler,
    getNodeScreenLongEdge: () => longEdge,
    onPositionNode() {},
    onClickNode() {},
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
  return {
    createdElements,
    downscaleCalls,
    imageDownscaler,
    materializer,
    mediaLoadQueue,
    revoked,
    world,
    images: () => createdElements.filter(({ tagName }) => tagName === "IMG"),
    setScreenLongEdge(value) {
      longEdge = value;
    },
    firePendingTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

function createMasterNode() {
  return {
    item: {
      id: "painting",
      name: "painting.png",
      ext: "png",
      // The 40 MP master from the profiled board.
      width: 5374,
      height: 7589,
      fileURL: "file:///painting.png",
      thumbnailURL: "file:///painting-thumb.png",
    },
    width: 121,
    mediaHeight: 171,
    height: 171,
    rotation: 0,
    isVideo: false,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The raster is rendered from the file before any element loads it, so settling
// takes a few microtask turns: thumbnail completion, then the render, then the
// swap. Emitting load on whatever image is pending drives the card forward.
async function settle(harness, turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) await flush();
  return harness.images().at(-1);
}

async function loadOriginal(harness, node) {
  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  const originalImage = await settle(harness);
  originalImage.emit("load");
  await settle(harness);
  return originalImage;
}

test("a card renders its raster from the file, never decoding the master", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();

  const originalImage = await loadOriginal(harness, node);

  assert.deepEqual(harness.downscaleCalls, [
    { source: "file", url: "file:///painting.png", budget: 512, width: 363, height: 512 },
  ]);
  // The element only ever holds the bounded raster, so the 40 MP master is
  // never decoded into a bitmap.
  assert.equal(originalImage.src, "blob:raster-1");
  assert.equal(node.element.dataset.mediaQuality, "original");
  assert.equal(node.previewImage, originalImage);
  assert.equal(originalImage.style.visibility, "visible");
  assert.equal(harness.mediaLoadQueue.snapshot(node).readyQuality, "original");
});

test("the original stays on screen during camera motion", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const originalImage = await loadOriginal(harness, node);
  const thumbnail = harness.images()[0];

  // Bounded rasters are cheap enough to keep painting while the camera moves,
  // so nothing downgrades to the 320px thumbnail any more.
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
  });

  assert.equal(originalImage.style.visibility, "visible");
  assert.equal(thumbnail.style.visibility, "hidden");
  assert.equal(node.mediaElement, originalImage);
});

test("a master already within budget is painted without a bounded raster", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  node.item.width = 320;
  node.item.height = 451;

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  const originalImage = await settle(harness);
  originalImage.emit("load");
  await settle(harness);

  assert.deepEqual(harness.downscaleCalls, []);
  assert.equal(originalImage.src, "file:///painting.png");
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("a file the platform cannot read falls back to bounding the loaded element", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = async () => null;
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  const originalImage = await settle(harness);

  // With no file access the element has to load the master itself.
  assert.equal(originalImage.src, "file:///painting.png");
  originalImage.emit("load");
  await settle(harness);

  assert.deepEqual(harness.downscaleCalls, [
    { source: "element", image: originalImage, budget: 512, width: 363, height: 512 },
  ]);
  assert.equal(originalImage.src, "blob:raster-1");

  originalImage.emit("load");
  await settle(harness);
  assert.equal(node.element.dataset.mediaQuality, "original");
  assert.equal(originalImage.style.visibility, "visible");
});

test("zooming past the rastered size re-renders the master sharper", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const firstOriginal = await loadOriginal(harness, node);

  harness.setScreenLongEdge(1500);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });

  const reloaded = await settle(harness);
  assert.notEqual(reloaded, firstOriginal);
  // The card keeps showing the raster it already has while the reload runs.
  assert.equal(node.previewImage, firstOriginal);
  assert.equal(node.element.dataset.mediaQuality, "loading-original");

  reloaded.emit("load");
  await settle(harness);

  assert.deepEqual(
    harness.downscaleCalls.map(({ width, height }) => ({ width, height })),
    [
      { width: 363, height: 512 },
      { width: 1088, height: 1536 },
    ],
  );
  assert.equal(reloaded.src, "blob:raster-2");
  assert.equal(node.previewImage, reloaded);
  assert.equal(node.element.dataset.mediaQuality, "original");
  assert.deepEqual(harness.revoked, ["blob:raster-1"], "the superseded raster is released");
  assert.equal(firstOriginal.isConnected, false, "the superseded original leaves the DOM");
});

// A budget that only ever grows leaves a zoomed-out board painting 4096px
// rasters into 180px cards — the same decode cache thrash bounding removes.
test("zooming back out hands the oversized raster back", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  const zoomedOriginal = await loadOriginal(harness, node);
  assert.equal(harness.downscaleCalls[0].budget, 1536);

  harness.setScreenLongEdge(400);
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
  });

  const shrunk = await settle(harness);
  assert.notEqual(shrunk, zoomedOriginal);
  shrunk.emit("load");
  await settle(harness);

  assert.equal(harness.downscaleCalls.at(-1).budget, 512);
  assert.equal(node.previewImage, shrunk);
  assert.deepEqual(harness.revoked, ["blob:raster-1"]);
});

// Observed in a trace: cards that had grown to a 4096px raster kept painting it
// into 180px boxes long after zooming out, because they no longer asked for an
// original and so were never revisited. Their decodes then blocked commit.
test("dropping below the original threshold gives the raster back", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  const zoomedOriginal = await loadOriginal(harness, node);
  const thumbnail = harness.images()[0];
  assert.equal(harness.downscaleCalls[0].budget, 1536);
  assert.equal(node.previewImage, zoomedOriginal);

  // Zoomed out far enough that the thumbnail is enough again.
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });

  assert.equal(node.previewImage, thumbnail);
  assert.equal(node.mediaElement, thumbnail);
  assert.equal(thumbnail.style.visibility, "visible");
  assert.equal(zoomedOriginal.isConnected, false);
  assert.equal(node.element.dataset.mediaQuality, "thumbnail");
  assert.deepEqual(harness.revoked, ["blob:raster-1"]);
  assert.equal(harness.mediaLoadQueue.snapshot(node).readyQuality, "thumbnail");
});

test("zooming back in after a drop reloads the original", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  await loadOriginal(harness, node);
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });

  harness.setScreenLongEdge(400);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  const reloaded = await settle(harness);
  reloaded.emit("load");
  await settle(harness);

  assert.equal(harness.downscaleCalls.at(-1).budget, 512);
  assert.equal(node.previewImage, reloaded);
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("a zoom gesture only grows the budget, never shrinking mid-gesture", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  await loadOriginal(harness, node);
  const renderCount = harness.downscaleCalls.length;

  // syncQuality() runs several times a second while zooming; shrinking there
  // would re-render on every step of the gesture.
  harness.setScreenLongEdge(400);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  await settle(harness);

  assert.equal(harness.downscaleCalls.length, renderCount);
  assert.deepEqual(harness.revoked, []);
});

test("zooming within the rastered budget does not re-render anything", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  await loadOriginal(harness, node);
  const imageCount = harness.images().length;

  harness.setScreenLongEdge(512);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  await settle(harness);

  assert.equal(harness.images().length, imageCount);
  assert.equal(harness.downscaleCalls.length, 1);
  assert.deepEqual(harness.revoked, []);
});

test("releasing a card releases its bounded raster", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  await loadOriginal(harness, node);

  harness.materializer.sync({
    visibleNodes: [],
    retainedNodes: [],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });

  assert.deepEqual(harness.revoked, ["blob:raster-1"]);
});

test("a platform without any downscaling still paints the master", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = async () => null;
  harness.imageDownscaler.renderFromImage = async () => null;
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  const originalImage = await settle(harness);
  originalImage.emit("load");
  await settle(harness);

  assert.equal(originalImage.src, "file:///painting.png");
  assert.equal(node.element.dataset.mediaQuality, "original");
  assert.equal(originalImage.style.visibility, "visible");
});

test("a stalled raster still times out so the load slot is freed", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = () => new Promise(() => {});
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle(harness);

  assert.equal(node.element.dataset.mediaQuality, "loading-original");
  assert.equal(harness.mediaLoadQueue.activeCount, 1);

  harness.firePendingTimers();

  assert.equal(node.element.dataset.mediaQuality, "original-failed");
  assert.equal(harness.mediaLoadQueue.activeCount, 0);
  assert.equal(harness.mediaLoadQueue.snapshot(node).originalFailed, true);
});

test("a raster that lands after the card was released is thrown away", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await flush();

  harness.materializer.sync({
    visibleNodes: [],
    retainedNodes: [],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });
  await settle(harness);

  assert.deepEqual(harness.revoked, ["blob:raster-1"]);
  assert.equal(node.element, null);
});
