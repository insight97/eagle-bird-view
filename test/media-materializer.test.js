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
  const released = [];
  let rasterCount = 0;
  const makeBitmap = (size) => {
    rasterCount += 1;
    return {
      id: `raster-${rasterCount}`,
      width: size.width,
      height: size.height,
      closed: false,
    };
  };
  const imageDownscaler = {
    isSupported: () => true,
    canRenderFromURL: () => true,
    async renderFromURL(url, size) {
      downscaleCalls.push({ source: "file", url, ...size });
      return makeBitmap(size);
    },
    async renderFromImage(image, size) {
      downscaleCalls.push({ source: "element", image, ...size });
      return makeBitmap(size);
    },
    release(bitmap) {
      if (bitmap) released.push(bitmap.id);
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
    released,
    world,
    images: () => createdElements.filter(({ tagName }) => tagName === "IMG"),
    canvases: () => createdElements.filter(({ tagName }) => tagName === "CANVAS"),
    liveCanvases: () =>
      createdElements.filter(({ tagName, width }) => tagName === "CANVAS" && width > 0),
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

// The raster is decoded from the file and transferred into a canvas, so nothing
// waits on an element load: settling is just a few microtask turns.
async function settle(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) await flush();
}

async function loadOriginal(harness, node) {
  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();
  return harness.canvases().at(-1);
}

test("a card paints its raster into a canvas, never decoding the master", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();

  const canvas = await loadOriginal(harness, node);

  assert.deepEqual(harness.downscaleCalls, [
    { source: "file", url: "file:///painting.png", budget: 512, width: 363, height: 512 },
  ]);
  // The bitmap is transferred straight in: no encode, no second decode, and the
  // 40 MP master is never built.
  assert.equal(canvas.transferred.id, "raster-1");
  assert.equal(canvas.width, 363);
  assert.equal(canvas.height, 512);
  assert.equal(harness.images().length, 1, "only the thumbnail should be an <img>");
  assert.equal(node.previewImage, canvas);
  assert.equal(node.mediaElement, canvas);
  assert.equal(canvas.style.visibility, "visible");
  assert.equal(node.element.dataset.mediaQuality, "original");
  assert.equal(harness.mediaLoadQueue.snapshot(node).readyQuality, "original");
});

test("the raster stays on screen during camera motion", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const canvas = await loadOriginal(harness, node);
  const thumbnail = harness.images()[0];

  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
  });

  assert.equal(canvas.style.visibility, "visible");
  assert.equal(thumbnail.style.visibility, "hidden");
  assert.equal(node.mediaElement, canvas);
});

test("a master already within budget is painted untouched", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  node.item.width = 320;
  node.item.height = 451;

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();
  const originalImage = harness.images().at(-1);
  assert.equal(originalImage.src, "file:///painting.png");
  originalImage.emit("load");
  await settle();

  assert.deepEqual(harness.downscaleCalls, []);
  assert.deepEqual(harness.canvases(), []);
  assert.equal(node.previewImage, originalImage);
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("a file the platform cannot read falls back to bounding the loaded element", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = async () => null;
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();

  // With no file access the element has to load the master itself.
  const originalImage = harness.images().at(-1);
  assert.equal(originalImage.src, "file:///painting.png");
  originalImage.emit("load");
  await settle();

  assert.deepEqual(harness.downscaleCalls, [
    { source: "element", image: originalImage, budget: 512, width: 363, height: 512 },
  ]);
  const canvas = harness.canvases().at(-1);
  assert.equal(canvas.transferred.id, "raster-1");
  assert.equal(node.previewImage, canvas);
  assert.equal(originalImage.isConnected, false, "the master element is torn down");
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("zooming past the rastered size re-renders the master sharper", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const first = await loadOriginal(harness, node);

  harness.setScreenLongEdge(1500);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  assert.equal(node.element.dataset.mediaQuality, "loading-original");
  assert.equal(node.previewImage, first, "the card keeps what it has meanwhile");

  await settle();

  assert.deepEqual(
    harness.downscaleCalls.map(({ budget }) => budget),
    [512, 1536],
  );
  const sharper = harness.canvases().at(-1);
  assert.notEqual(sharper, first);
  assert.equal(sharper.width, 1088);
  assert.equal(sharper.height, 1536);
  assert.equal(node.previewImage, sharper);
  assert.equal(first.isConnected, false, "the superseded canvas leaves the DOM");
  assert.equal(first.width, 0, "and gives its pixels back");
});

test("zooming back out hands the oversized raster back", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  const zoomed = await loadOriginal(harness, node);
  assert.equal(harness.downscaleCalls[0].budget, 1536);

  harness.setScreenLongEdge(400);
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
  });
  await settle();

  assert.equal(harness.downscaleCalls.at(-1).budget, 512);
  assert.notEqual(node.previewImage, zoomed);
  assert.equal(zoomed.width, 0, "the oversized canvas gives its pixels back");
});

// A budget that only grows leaves a zoomed-out board painting 4096px rasters
// into 180px cards, which is the thrash that bounding was meant to remove.
test("dropping below the original threshold gives the raster back", async () => {
  const harness = createRasterHarness({ screenLongEdge: 1500 });
  const node = createMasterNode();
  const canvas = await loadOriginal(harness, node);
  const thumbnail = harness.images()[0];

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
  assert.equal(canvas.isConnected, false);
  assert.equal(canvas.width, 0);
  assert.equal(node.element.dataset.mediaQuality, "thumbnail");
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
  await settle();

  assert.equal(harness.downscaleCalls.at(-1).budget, 512);
  assert.equal(node.previewImage, harness.canvases().at(-1));
  assert.equal(node.element.dataset.mediaQuality, "original");
});

// Sweeping across a board crosses hundreds of cards for a moment each, and every
// original costs a decode of the master to build its raster.
test("a moving camera leaves new cards on the thumbnail", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
    deferOriginals: true,
  });
  harness.images()[0].emit("load");
  await settle();

  assert.deepEqual(harness.downscaleCalls, [], "no master should be decoded mid-gesture");
  assert.deepEqual(harness.canvases(), []);
  assert.equal(node.element.dataset.mediaQuality, "thumbnail");
});

// Deferring a load is not the same as taking back a raster the card already has.
// Downgrading loaded cards during motion blurred the whole board while zooming.
test("a moving camera keeps rasters that cards already have", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const canvas = await loadOriginal(harness, node);

  harness.materializer.sync({
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
    deferOriginals: true,
  });
  await settle();

  assert.equal(node.previewImage, canvas);
  assert.equal(canvas.style.visibility, "visible");
  assert.equal(canvas.width, 363, "the canvas keeps its pixels");
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("the original is picked up once the camera stops", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const plan = {
    visibleNodes: [node],
    retainedNodes: [node],
    loadNodes: [node],
    selectedNode: null,
    getQuality: () => "original",
  };

  harness.materializer.mount(node);
  harness.materializer.sync({ ...plan, deferOriginals: true });
  harness.images()[0].emit("load");
  await settle();
  assert.deepEqual(harness.downscaleCalls, []);

  harness.materializer.sync({ ...plan, deferOriginals: false });
  await settle();

  assert.equal(harness.downscaleCalls.length, 1);
  assert.equal(node.previewImage, harness.canvases().at(-1));
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
  await settle();

  assert.equal(harness.downscaleCalls.length, renderCount);
});

test("zooming within the rastered budget does not re-render anything", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  await loadOriginal(harness, node);
  const canvasCount = harness.canvases().length;

  harness.setScreenLongEdge(512);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  await settle();

  assert.equal(harness.canvases().length, canvasCount);
  assert.equal(harness.downscaleCalls.length, 1);
});

test("releasing a card gives its canvas pixels back", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  const canvas = await loadOriginal(harness, node);
  assert.equal(canvas.width, 363);

  harness.materializer.sync({
    visibleNodes: [],
    retainedNodes: [],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });

  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

// Painting a master that cannot be bounded is only safe when it is close to
// what the card displays. Doing it unconditionally put 40 MP masters into 130px
// cards at over 1000x oversample and took tile-worker decode back to 282ms/s.
test("a master far past its budget is left on the thumbnail", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = async () => null;
  harness.imageDownscaler.renderFromImage = async () => null;
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  const thumbnail = harness.images()[0];
  thumbnail.emit("load");
  await settle();
  const originalImage = harness.images().at(-1);
  originalImage.emit("load");
  await settle();

  // 5374x7589 against a 512 budget: painting it is the thrash, not the fix.
  assert.deepEqual(harness.canvases(), []);
  assert.equal(originalImage.isConnected, false, "the master must not be painted");
  assert.equal(node.previewImage, thumbnail);
  assert.equal(node.element.dataset.mediaQuality, "thumbnail");
  // Marked failed so the card stops asking for an original it cannot use.
  assert.equal(harness.mediaLoadQueue.snapshot(node).originalFailed, true);
});

test("a master close to its budget is painted when it cannot be bounded", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = async () => null;
  harness.imageDownscaler.renderFromImage = async () => null;
  const node = createMasterNode();
  // Just over the 512 budget, so painting it costs almost nothing.
  node.item.width = 600;
  node.item.height = 800;

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();
  const originalImage = harness.images().at(-1);
  originalImage.emit("load");
  await settle();

  assert.deepEqual(harness.canvases(), []);
  assert.equal(originalImage.src, "file:///painting.png");
  assert.equal(originalImage.style.visibility, "visible");
  assert.equal(node.element.dataset.mediaQuality, "original");
});

test("a stalled raster still times out so the load slot is freed", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  harness.imageDownscaler.renderFromURL = () => new Promise(() => {});
  const node = createMasterNode();

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();

  assert.equal(node.element.dataset.mediaQuality, "loading-original");
  assert.equal(harness.mediaLoadQueue.activeCount, 1);

  harness.firePendingTimers();

  assert.equal(node.element.dataset.mediaQuality, "original-failed");
  assert.equal(harness.mediaLoadQueue.activeCount, 0);
  assert.equal(harness.mediaLoadQueue.snapshot(node).originalFailed, true);
});

test("a bitmap that lands after the card was released is closed", async () => {
  const harness = createRasterHarness({ screenLongEdge: 400 });
  const node = createMasterNode();
  let finishRender = null;
  harness.imageDownscaler.renderFromURL = () =>
    new Promise((resolve) => {
      finishRender = resolve;
    });

  harness.materializer.mount(node);
  harness.materializer.syncQuality({ loadNodes: [node], getQuality: () => "original" });
  harness.images()[0].emit("load");
  await settle();
  assert.equal(typeof finishRender, "function", "the render should be in flight");

  harness.materializer.sync({
    visibleNodes: [],
    retainedNodes: [],
    selectedNode: null,
    getQuality: () => "thumbnail",
  });
  // The decode finishes after the card is gone: nothing owns the bitmap now, so
  // it has to be closed rather than left for the GC.
  finishRender({ id: "late-raster", width: 363, height: 512 });
  await settle();

  assert.deepEqual(harness.released, ["late-raster"]);
  assert.equal(node.element, null);
  assert.deepEqual(harness.canvases(), [], "and never reached a canvas");
});
