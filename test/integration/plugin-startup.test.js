"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginHarness } = require("../../test-support/plugin-harness.js");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Starts the plugin with an empty Eagle selection, which is the state the board
// lands in when nothing is selected.
async function startEmptyPlugin() {
  const plugin = createPluginHarness({ selectedItems: [] });
  plugin.start();
  await flush();
  return plugin;
}

function pressKey(plugin, key, { repeat = false } = {}) {
  let prevented = false;
  plugin.keyDown({
    key,
    repeat,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}

function statusOf(plugin, selector) {
  return plugin.elements.get(selector).textContent;
}

function imageItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`,
    name: `image-${index}.jpg`,
    ext: "jpg",
    width: 1600,
    height: 1000,
    fileURL: `file:///image-${index}.jpg`,
    thumbnailURL: `file:///image-${index}-thumb.jpg`,
  }));
}

function videoItem() {
  return {
    id: "video-0",
    name: "video-0.mp4",
    ext: "mp4",
    width: 1600,
    height: 900,
    fileURL: "file:///video-0.mp4",
    thumbnailURL: "file:///video-0-thumb.jpg",
  };
}

test("the board asks Eagle for the selection and leaves auto exploration off", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(plugin.selectedRequests, 1);
  assert.equal(plugin.unratedRequests, 0);
  assert.equal(statusOf(plugin, "#auto-explore-status"), "關");
  assert.equal(plugin.elements.get("#video-autoplay-toggle").checked, false);
});

test("AI exploration is controlled by the per-row item limit", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    aiSearch: { searchByItemId: async () => ({ results: [] }) },
  });
  plugin.start();
  await flush();

  const maxItems = plugin.elements.get("#ai-exploration-max-items");
  assert.equal(maxItems.disabled, false);
  assert.equal(maxItems.value, "0");

  maxItems.value = "5";
  maxItems.emit("input");

  assert.equal(maxItems.value, "5");
  assert.equal(plugin.elements.get("#ai-exploration-max-items-value").textContent, "5 個");

  maxItems.value = "0";
  maxItems.emit("input");
  assert.equal(plugin.elements.get("#ai-exploration-max-items-value").textContent, "關閉");
});

test("smooth pan and zoom speeds accept the expanded upper limits", async () => {
  const plugin = await startEmptyPlugin();
  const panSpeed = plugin.elements.get("#smooth-pan-speed");
  const speed = plugin.elements.get("#smooth-zoom-speed");

  panSpeed.value = "6000";
  panSpeed.emit("input");
  assert.equal(panSpeed.value, "6000");

  speed.value = "60";
  speed.emit("input");

  assert.equal(speed.value, "60");
  assert.equal(plugin.elements.get("#smooth-zoom-speed-value").textContent, "60.00×/秒");
});

test("smooth zoom can request original quality before motion settles", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(1),
    runAnimationFrames: true,
    smoothZoomProbe: true,
    storage: {
      getItem(key) {
        return key === "bird-view-settings"
          ? JSON.stringify({ board: { smoothZoomEnabled: true } })
          : null;
      },
      setItem() {},
    },
  });
  plugin.elements.get("#viewport").clientHeight = 200;

  plugin.start();
  await flush();
  plugin.flushTimers();

  assert.equal(plugin.createdElementsOfTag("img").length, 1);

  plugin.keyDown({
    key: "PageUp",
    ctrlKey: true,
    target: null,
    preventDefault() {},
  });
  plugin.flushTimers();

  const thumbnailImage = plugin.createdElementsOfTag("img")[0];
  thumbnailImage.emit("load");
  await flush();

  assert.equal(plugin.createdElementsOfTag("img").length, 2);
});

test("the selected image preloads original quality below the display threshold", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(1),
    runAnimationFrames: true,
    navigationProbe: true,
  });
  plugin.elements.get("#viewport").clientHeight = 200;

  plugin.start();
  await flush();
  plugin.fireTimer(0);

  const thumbnailImage = plugin.createdElementsOfTag("img")[0];
  assert.ok(thumbnailImage);
  thumbnailImage.emit("load");
  await flush();

  assert.equal(plugin.createdElementsOfTag("img").length, 2);
});

test("keyboard acceleration can be changed and is persisted", async () => {
  const stored = [];
  const plugin = createPluginHarness({
    selectedItems: [],
    storage: {
      getItem() {
        return null;
      },
      setItem(key, value) {
        stored.push([key, JSON.parse(value)]);
      },
    },
  });
  plugin.start();
  await flush();

  const acceleration = plugin.elements.get("#keyboard-acceleration");
  assert.equal(acceleration.value, "16");

  acceleration.value = "24";
  acceleration.emit("change");

  assert.equal(acceleration.value, "24");
  assert.equal(stored.at(-1)[1].board.keyboardAcceleration, 24);
});

test("legacy smooth zoom acceleration settings restore into keyboard acceleration", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    storage: {
      getItem(key) {
        return key === "bird-view-settings"
          ? JSON.stringify({ board: { smoothZoomAcceleration: 24 } })
          : null;
      },
      setItem() {},
    },
  });
  plugin.start();
  await flush();

  assert.equal(plugin.elements.get("#keyboard-acceleration").value, "24");
});

test("F11 toggles Eagle fullscreen and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "F11"), true);
  await flush();
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  pressKey(plugin, "F11", { repeat: true });
  await flush();
  assert.equal(plugin.fullScreen, true);
  assert.equal(plugin.fullScreenCalls, 1);

  pressKey(plugin, "F11");
  await flush();
  assert.equal(plugin.fullScreen, false);
  assert.equal(plugin.fullScreenCalls, 2);
});

test("Insert toggles auto exploration and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "Insert"), true);
  await flush();
  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);

  pressKey(plugin, "Insert", { repeat: true });
  await flush();
  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);

  pressKey(plugin, "Insert");
  assert.equal(statusOf(plugin, "#auto-explore-status"), "關");
});

test("Delete toggles seamless mode and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(pressKey(plugin, "Delete"), true);
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "開");

  pressKey(plugin, "Delete", { repeat: true });
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "開");

  pressKey(plugin, "Delete");
  assert.equal(statusOf(plugin, "#seamless-mode-status"), "關");
});

test("the auto explore toggle button loads a row when switched on", async () => {
  const plugin = await startEmptyPlugin();

  plugin.elements.get("#auto-explore-toggle").click();
  await flush();

  assert.equal(statusOf(plugin, "#auto-explore-status"), "開");
  assert.equal(plugin.unratedRequests, 1);
});

test("reopening with a selection appends items instead of loading the selected folder", async () => {
  const plugin = createPluginHarness();
  plugin.start();
  plugin.resolveSelected(0, []);
  await flush();
  // The empty selection already consulted the folder source once.
  assert.equal(plugin.folderLoadRequests, 1);

  plugin.setFolderSourceResult({
    folders: [{ id: "selected-folder", name: "Folder" }],
    items: [{ id: "folder-item" }],
  });
  plugin.pluginRun();
  assert.equal(plugin.selectedRequests, 2);

  plugin.resolveSelected(1, [
    {
      id: "selected-item",
      name: "selected.jpg",
      ext: "jpg",
      width: 100,
      height: 100,
      fileURL: "file:///selected.jpg",
      thumbnailURL: "file:///selected-thumb.jpg",
    },
  ]);
  await flush();

  assert.equal(plugin.folderLoadRequests, 1, "selected items win over a selected folder");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("switching Eagle library reloads the selection", async () => {
  const plugin = await startEmptyPlugin();

  plugin.changeLibrary();

  assert.equal(plugin.selectedRequests, 2);
});

test("loading selected items selects the item at the viewport center", async () => {
  const plugin = createPluginHarness({
    runAnimationFrames: true,
    navigationProbe: true,
    selectedItems: [
      {
        id: "center-item",
        name: "center.jpg",
        ext: "jpg",
        width: 100,
        height: 100,
        fileURL: "file:///center.jpg",
        thumbnailURL: "file:///center-thumb.jpg",
      },
    ],
  });

  plugin.start();
  await flush();

  assert.equal(plugin.selectedNodeId, "center-item");
});

test("selected videos autoplay only while the video is large enough", async () => {
  const plugin = createPluginHarness({
    selectedItems: [videoItem()],
    navigationProbe: true,
    runAnimationFrames: true,
    storage: {
      getItem(key) {
        return key === "bird-view-settings"
          ? JSON.stringify({ board: { videoAutoplayEnabled: true } })
          : null;
      },
      setItem() {},
    },
  });

  plugin.start();
  await flush();

  assert.equal(plugin.elements.get("#video-autoplay-toggle").checked, true);
  assert.equal(plugin.videoStartRequests, 1);

  plugin.changeLibrary();
  assert.ok(plugin.videoPauseCalls >= 1, "leaving the selection pauses the video");
});

test("dragging defers viewport maintenance until the pointer is released", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(48),
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  plugin.flushTimers();

  const viewport = plugin.elements.get("#viewport");
  const world = plugin.elements.get("#world");
  const cardsBeforePan = world.children.length;

  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  plugin.windowEmit("pointermove", { clientX: 0, clientY: -1000 });
  plugin.flushTimers();

  assert.equal(world.children.length, cardsBeforePan);

  plugin.windowEmit("pointerup");
  assert.ok(world.children.length > cardsBeforePan);
});
