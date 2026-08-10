"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getNodeScreenCenter } = require("../../bird-view-core.js");
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

function audioItem() {
  return {
    id: "audio-0",
    name: "audio-0.mp3",
    ext: "mp3",
    width: 1200,
    height: 800,
    fileURL: "file:///audio-0.mp3",
  };
}

test("the board asks Eagle for the selection and leaves auto exploration off", async () => {
  const plugin = await startEmptyPlugin();

  assert.equal(plugin.selectedRequests, 1);
  assert.equal(plugin.unratedRequests, 0);
  assert.equal(statusOf(plugin, "#auto-explore-status"), "關");
  assert.equal(plugin.elements.get("#video-autoplay-toggle").checked, false);
});

test("AI exploration is controlled by ratio and similarity settings", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    aiSearch: { searchByItemId: async () => ({ results: [] }) },
  });
  plugin.start();
  await flush();

  const ratio = plugin.elements.get("#ai-exploration-ratio");
  const similarity = plugin.elements.get("#ai-similarity-max");
  const diversity = plugin.elements.get("#exploration-diversity-strength");
  assert.equal(ratio.disabled, false);
  assert.equal(ratio.value, "0");
  assert.equal(similarity.value, "100");
  assert.equal(diversity.value, "0");

  ratio.value = "50";
  ratio.emit("input");
  similarity.value = "80";
  similarity.emit("input");
  diversity.value = "75";
  diversity.emit("input");

  assert.equal(ratio.value, "50");
  assert.equal(plugin.elements.get("#ai-exploration-ratio-value").textContent, "50%");
  assert.equal(plugin.elements.get("#ai-similarity-max-value").textContent, "80%");
  assert.equal(plugin.elements.get("#exploration-diversity-strength-value").textContent, "75%");

  ratio.value = "0";
  ratio.emit("input");
  assert.equal(plugin.elements.get("#ai-exploration-ratio-value").textContent, "關閉");
});

test("legacy AI item limits migrate to a staged ratio", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    aiSearch: { searchByItemId: async () => ({ results: [] }) },
    storage: {
      getItem(key) {
        return key === "bird-view-settings"
          ? JSON.stringify({
              board: {
                maxExplorationItems: 12,
                aiExplorationEnabled: true,
                maxAiExplorationItems: 5,
              },
            })
          : null;
      },
      setItem() {},
    },
  });
  plugin.start();
  await flush();

  assert.equal(plugin.elements.get("#ai-exploration-ratio").value, "50");
  assert.equal(plugin.elements.get("#ai-similarity-max").value, "100");
});

test("AI ratio and similarity settings are persisted", async () => {
  const saved = [];
  const plugin = createPluginHarness({
    selectedItems: [],
    aiSearch: { searchByItemId: async () => ({ results: [] }) },
    storage: {
      getItem() {
        return null;
      },
      setItem(key, value) {
        if (key === "bird-view-settings") saved.push(JSON.parse(value));
      },
    },
  });
  plugin.start();
  await flush();

  plugin.elements.get("#ai-exploration-ratio").value = "75";
  plugin.elements.get("#ai-exploration-ratio").emit("input");
  plugin.elements.get("#ai-similarity-max").value = "85";
  plugin.elements.get("#ai-similarity-max").emit("input");
  plugin.elements.get("#exploration-diversity-strength").value = "50";
  plugin.elements.get("#exploration-diversity-strength").emit("input");

  const boardSettings = saved.at(-1).board;
  assert.equal(boardSettings.aiExplorationRatio, 75);
  assert.equal(boardSettings.aiSimilarityMax, 85);
  assert.equal(boardSettings.explorationDiversityStrength, 50);
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

test("smooth zoom defers a blocking element fallback until motion settles", async () => {
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

  assert.equal(plugin.createdElementsOfTag("img").length, 1);

  plugin.windowEmit("keyup", { key: "PageUp" });
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

  assert.equal(plugin.createdElementsOfTag("img").length, 1);

  plugin.advanceClock(180);
  plugin.flushTimersUnder(1000);
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

test("Tab toggles the folder browser and ignores auto-repeat", async () => {
  const plugin = await startEmptyPlugin();
  const folderBrowser = plugin.elements.get("#folder-browser");

  assert.equal(folderBrowser.classList.contains("is-open"), false);
  assert.equal(pressKey(plugin, "Tab"), true);
  assert.equal(folderBrowser.classList.contains("is-open"), true);

  assert.equal(pressKey(plugin, "Tab", { repeat: true }), true);
  assert.equal(folderBrowser.classList.contains("is-open"), true);

  assert.equal(pressKey(plugin, "Tab"), true);
  assert.equal(folderBrowser.classList.contains("is-open"), false);
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

test("switching layout modes keeps the selected item at its screen position", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(8),
    navigationProbe: true,
    runAnimationFrames: true,
  });
  plugin.start();
  await flush();

  assert.ok(plugin.selectedNode);
  plugin.camera.x = -240;
  plugin.camera.y = -110;
  plugin.camera.scale = 1.3;
  const before = getNodeScreenCenter(plugin.selectedNode, plugin.camera);

  plugin.elements.get("#seamless-mode-toggle").click();

  const after = getNodeScreenCenter(plugin.selectedNode, plugin.camera);
  assert.ok(Math.abs(after.x - before.x) < 0.001);
  assert.ok(Math.abs(after.y - before.y) < 0.001);
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

test("folder browser replaces the board with the selected folder contents", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    folderTree: [
      { id: "root", name: "Design", children: [{ id: "icons", name: "Icons" }] },
    ],
  });
  plugin.setFolderSourceResult({
    folders: [{ id: "icons", name: "Icons" }],
    items: [
      {
        id: "folder-item",
        name: "icon.jpg",
        ext: "jpg",
        width: 100,
        height: 100,
        fileURL: "file:///icon.jpg",
        thumbnailURL: "file:///icon-thumb.jpg",
      },
    ],
  });

  plugin.start();
  await flush();

  const includeSubfolders = plugin.elements.get("#folder-browser-include-subfolders");
  includeSubfolders.checked = false;
  const folderTree = plugin.elements.get("#folder-browser-tree");
  folderTree.querySelectorAll(".folder-browser-disclosure")[0].click();
  const folderButtons = folderTree.querySelectorAll(".folder-browser-item");
  folderButtons[1].click();
  await flush();

  assert.equal(plugin.folderSelectionRequests, 1);
  assert.equal(plugin.folderSelectionOptions[0].folders[0].id, "icons");
  assert.equal(plugin.folderSelectionOptions[0].options.includeSubfolders, false);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
  assert.equal(plugin.elements.get("#toast").textContent.includes("已載入資料夾"), false);
});

test("the previous-board action restores the prior stage and camera state", async () => {
  const initialItem = {
    id: "initial-item",
    name: "initial.jpg",
    ext: "jpg",
    width: 100,
    height: 100,
    fileURL: "file:///initial.jpg",
    thumbnailURL: "file:///initial-thumb.jpg",
  };
  const replacementItem = {
    id: "replacement-item",
    name: "replacement.jpg",
    ext: "jpg",
    width: 160,
    height: 100,
    fileURL: "file:///replacement.jpg",
    thumbnailURL: "file:///replacement-thumb.jpg",
  };
  const plugin = createPluginHarness({
    selectedItems: [initialItem],
    folderTree: [{ id: "replacement-folder", name: "Replacement" }],
    navigationProbe: true,
    runAnimationFrames: true,
  });
  plugin.setFolderSourceResult({ folders: [], items: [replacementItem] });

  plugin.start();
  await flush();
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, true);
  const initialCamera = { ...plugin.camera };

  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await flush();
  assert.equal(plugin.selectedNodeId, "replacement-item");
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, false);
  const replacementCamera = { ...plugin.camera };

  let prevented = false;
  plugin.keyDown({
    key: "z",
    ctrlKey: true,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  await flush();

  assert.equal(prevented, true);
  assert.equal(plugin.selectedNodeId, "initial-item");
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, true);
  assert.equal(plugin.elements.get("#board-history-forward-button").disabled, false);
  assert.equal(plugin.camera.x, initialCamera.x);
  assert.equal(plugin.camera.y, initialCamera.y);
  assert.equal(plugin.camera.scale, initialCamera.scale);

  plugin.elements.get("#board-history-forward-button").click();
  assert.equal(plugin.selectedNodeId, "replacement-item");
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, false);
  assert.equal(plugin.elements.get("#board-history-forward-button").disabled, true);
  assert.equal(plugin.camera.x, replacementCamera.x);
  assert.equal(plugin.camera.y, replacementCamera.y);
  assert.equal(plugin.camera.scale, replacementCamera.scale);

  plugin.keyDown({ key: "z", ctrlKey: true, target: null, preventDefault() {} });
  plugin.keyDown({
    key: "z",
    ctrlKey: true,
    shiftKey: true,
    target: null,
    preventDefault() {},
  });
  assert.equal(plugin.selectedNodeId, "replacement-item");
});

test("folder browser renders the first progressive batch before descendant loading finishes", async () => {
  let releaseRemaining;
  const remainingDone = new Promise((resolve) => {
    releaseRemaining = resolve;
  });
  class ProgressiveFolderItemSource {
    async loadSelected() {
      return { folders: [], items: [] };
    }
    async loadFolders(folders, options) {
      await options.onItems?.([
        {
          id: "first-folder-item",
          name: "first.jpg",
          ext: "jpg",
          width: 100,
          height: 100,
        },
        ...Array.from({ length: 119 }, (_, index) => ({
          id: `initial-folder-item-${index}`,
          name: `initial-${index}.jpg`,
          ext: "jpg",
          width: 100,
          height: 100,
        })),
      ]);
      await options.onItems?.([
        {
          id: "second-folder-item",
          name: "second.jpg",
          ext: "jpg",
          width: 100,
          height: 100,
        },
      ]);
      await remainingDone;
      return {
        folders,
        items: [
          {
            id: "first-folder-item",
            name: "first.jpg",
            ext: "jpg",
            width: 100,
            height: 100,
          },
          {
            id: "second-folder-item",
            name: "second.jpg",
            ext: "jpg",
            width: 100,
            height: 100,
          },
        ],
      };
    }
    async hydrate(items) {
      return items;
    }
  }
  const plugin = createPluginHarness({
    selectedItems: [],
    folderTree: [{ id: "root", name: "Design" }],
    folderSourceImplementation: ProgressiveFolderItemSource,
  });

  plugin.start();
  await flush();
  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await flush();

  assert.equal(plugin.elements.get("#item-count").textContent, "120 個素材");
  releaseRemaining();
  await flush();
  assert.equal(plugin.state.folderContentIntake.snapshot().itemCount, 121);
});

test("folder browser reveals a small folder without viewport interaction", async () => {
  class SmallFolderItemSource {
    async loadSelected() {
      return { folders: [], items: [] };
    }
    async loadFolders(folders) {
      return {
        folders,
        items: [
          {
            id: "small-folder-item",
            name: "small.jpg",
            ext: "jpg",
            width: 100,
            height: 100,
            fileURL: "file:///small.jpg",
            thumbnailURL: "file:///small-thumb.jpg",
          },
        ],
      };
    }
    async hydrate(items) {
      return items;
    }
  }
  const plugin = createPluginHarness({
    selectedItems: [],
    folderTree: [{ id: "root", name: "Small" }],
    folderSourceImplementation: SmallFolderItemSource,
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await flush();
  // Mounting the folder moves the camera, and originals wait for it to stop.
  plugin.advanceClock(200);
  plugin.flushTimers();
  await flush();

  const world = plugin.elements.get("#world");
  const card = world.children[0];
  const thumbnail = card.querySelector("img");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
  assert.equal(world.children.length, 1);
  assert.equal(thumbnail.style.visibility, "hidden");

  plugin.resolvePendingImageLoads();
  await flush();

  const visibleImages = card
    .querySelectorAll("img")
    .filter(({ style }) => style.visibility === "visible");
  assert.equal(visibleImages.length, 1, "exactly one image should be showing");
  assert.equal(card.dataset.mediaQuality, "original");
});

test("folder browser keeps completed items and retries a failed folder query", async () => {
  let attempts = 0;
  class PartialFolderItemSource {
    async loadSelected() {
      return { folders: [], items: [] };
    }
    async loadFolders(folders, options) {
      attempts += 1;
      await options.onItems?.([
        {
          id: "partial-folder-item",
          name: "partial.jpg",
          ext: "jpg",
          width: 100,
          height: 100,
          fileURL: "file:///partial.jpg",
          thumbnailURL: "file:///partial-thumb.jpg",
        },
      ]);
      return {
        folders,
        items: [
          {
            id: "partial-folder-item",
            name: "partial.jpg",
            ext: "jpg",
            width: 100,
            height: 100,
          },
        ],
        failures: attempts === 1 ? [{ folderId: "child", error: new Error("child unavailable") }] : [],
      };
    }
    async hydrate(items) {
      return items;
    }
  }
  const plugin = createPluginHarness({
    selectedItems: [],
    folderTree: [{ id: "root", name: "Design" }],
    folderSourceImplementation: PartialFolderItemSource,
  });

  plugin.start();
  await flush();
  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await flush();

  const loadMore = plugin.elements.get("#folder-load-more-button");
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
  assert.equal(loadMore.textContent, "重試載入");
  assert.match(plugin.elements.get("#folder-browser-status").textContent, /部分資料夾載入失敗/);

  loadMore.click();
  await flush();

  assert.equal(attempts, 2);
  assert.equal(loadMore.hidden, true);
  assert.match(plugin.elements.get("#folder-browser-status").textContent, /已完成載入/);
});

test("folder browser works when Eagle only exposes getAll for folders", async () => {
  const plugin = createPluginHarness({
    selectedItems: [],
    folderSelectionApi: false,
    folderTree: [{ id: "root", name: "Design" }],
  });
  plugin.setFolderSourceResult({
    folders: [{ id: "root", name: "Design" }],
    items: [{ id: "folder-item", name: "design.jpg", ext: "jpg", width: 100, height: 100 }],
  });

  plugin.start();
  await flush();
  plugin.elements.get("#folder-browser-tree").querySelectorAll(".folder-browser-item")[0].click();
  await flush();

  assert.equal(plugin.folderSelectionRequests, 1);
  assert.equal(plugin.elements.get("#item-count").textContent, "1 個素材");
});

test("switching Eagle library reloads the selection", async () => {
  const plugin = await startEmptyPlugin();

  plugin.changeLibrary();

  assert.equal(plugin.selectedRequests, 2);
  assert.equal(plugin.elements.get("#board-history-back-button").disabled, true);
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

test("selected MP3 files can start playback with Enter", async () => {
  const plugin = createPluginHarness({
    selectedItems: [audioItem()],
    navigationProbe: true,
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();

  assert.equal(plugin.state.selectedNode.isAudio, true);
  plugin.keyDown({ key: "Enter", target: null, preventDefault() {} });

  assert.equal(plugin.videoStartRequests, 1);
});

test("Ctrl+Home sets the selected video's current frame as its Eagle thumbnail", async () => {
  const item = videoItem();
  const calls = [];
  item.setCustomThumbnail = async () => true;
  const plugin = createPluginHarness({
    selectedItems: [item],
    navigationProbe: true,
    runAnimationFrames: true,
    videoThumbnailImplementation: {
      async setFromVideo(args) {
        calls.push(args);
        return { status: "saved" };
      },
    },
  });

  plugin.start();
  await flush();
  plugin.keyDown({ key: "Enter", target: null, preventDefault() {} });
  assert.equal(plugin.videoStartRequests, 1);

  let prevented = false;
  plugin.keyDown({
    key: "Home",
    ctrlKey: true,
    target: null,
    preventDefault() {
      prevented = true;
    },
  });
  await flush();

  assert.equal(prevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].item, item);
  assert.equal(calls[0].video, plugin.state.selectedNode.videoElement);
  assert.equal(plugin.elements.get("#toast").textContent, "已將目前影片畫面設為 Eagle 縮圖。");
});

test("Ctrl+Home explains why the video thumbnail runtime is unavailable", async () => {
  const item = videoItem();
  item.setCustomThumbnail = async () => true;
  const plugin = createPluginHarness({
    selectedItems: [item],
    navigationProbe: true,
    runAnimationFrames: true,
    videoThumbnailImplementation: {
      async setFromVideo() {
        return { status: "unavailable", reason: "temp-directory-unavailable" };
      },
    },
  });

  plugin.start();
  await flush();
  plugin.keyDown({ key: "Enter", target: null, preventDefault() {} });
  plugin.keyDown({ key: "Home", ctrlKey: true, target: null, preventDefault() {} });
  await flush();

  assert.equal(
    plugin.elements.get("#toast").textContent,
    "無法建立影片縮圖：無法取得 Eagle 暫存資料夾。",
  );
});

test("Ctrl+Home names the missing video thumbnail runtime capability", async () => {
  const item = videoItem();
  item.setCustomThumbnail = async () => true;
  const plugin = createPluginHarness({
    selectedItems: [item],
    navigationProbe: true,
    runAnimationFrames: true,
    videoThumbnailImplementation: {
      async setFromVideo() {
        return {
          status: "unavailable",
          reason: "runtime-unavailable",
          missing: ["fs.writeFile"],
        };
      },
    },
  });
  plugin.start();
  await flush();
  plugin.keyDown({ key: "Enter", target: null, preventDefault() {} });
  plugin.keyDown({ key: "Home", ctrlKey: true, target: null, preventDefault() {} });
  await flush();

  assert.equal(plugin.elements.get("#toast").textContent, "無法建立影片縮圖：缺少：檔案寫入 API。");
});

// Media mounting has to keep up with the gesture: deferring it for the whole
// drag means the pan arrives somewhere with nothing loaded and only then starts
// fetching. Labels and centre selection stay deferred — those are main-thread
// work the gesture does not need.
test("dragging keeps media loading but defers labels and selection", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(48),
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  plugin.flushTimers();

  const viewport = plugin.elements.get("#viewport");
  const world = plugin.elements.get("#world");
  const labels = plugin.elements.get("#labels");
  const cardsBeforePan = world.children.length;
  const selectedBeforePan = plugin.state.selectedNode;
  labels.style.transform = "labels-sentinel";

  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  plugin.windowEmit("pointermove", { clientX: 0, clientY: -1000 });
  plugin.flushTimers();

  assert.ok(
    world.children.length > cardsBeforePan,
    "cards along the pan should mount while the pointer is still down",
  );
  assert.equal(labels.style.transform, "labels-sentinel");
  assert.equal(plugin.state.selectedNode, selectedBeforePan);

  plugin.windowEmit("pointerup");
  assert.notEqual(labels.style.transform, "labels-sentinel");
});

test("dragging keeps camera frames on the world transform until release", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(12),
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  plugin.flushTimers();

  const viewport = plugin.elements.get("#viewport");
  const world = plugin.elements.get("#world");
  const grid = plugin.elements.get("#grid");
  const labels = plugin.elements.get("#labels");
  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });
  grid.style.transform = "grid-sentinel";
  labels.style.transform = "labels-sentinel";

  plugin.windowEmit("pointermove", { clientX: 0, clientY: -100 });

  assert.match(world.style.transform, /translate\(/);
  assert.equal(world.classList.contains("is-moving"), false);
  assert.equal(grid.style.transform, "grid-sentinel");
  assert.equal(labels.style.transform, "labels-sentinel");

  // The harness invokes requestAnimationFrame synchronously; clear its
  // simulated pending frame before exercising the pointer-up refresh.
  plugin.state.cameraFrame = null;
  plugin.windowEmit("pointerup");

  assert.equal(world.classList.contains("is-moving"), false);
  assert.notEqual(grid.style.transform, "grid-sentinel");
  assert.notEqual(labels.style.transform, "labels-sentinel");
});

// The lead only helps if coverage is reconsidered repeatedly: a single pass at
// the start of a drag is stale by the time the camera has travelled a viewport.
test("a sustained drag keeps reconsidering media coverage", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(96),
    runAnimationFrames: true,
  });

  plugin.start();
  await flush();
  plugin.flushTimers();

  const viewport = plugin.elements.get("#viewport");
  const world = plugin.elements.get("#world");
  viewport.emit("pointerdown", { button: 1, clientX: 0, clientY: 0 });

  const counts = [];
  for (let step = 1; step <= 4; step += 1) {
    plugin.windowEmit("pointermove", { clientX: 0, clientY: -400 * step });
    plugin.flushTimers();
    counts.push(world.children.length);
  }

  assert.ok(
    counts.at(-1) > counts[0],
    `coverage should keep growing through the drag, saw ${counts.join(", ")}`,
  );
  plugin.windowEmit("pointerup");
});

// Keyboard smooth panning must report the same semantic motion as a pointer
// drag. Otherwise a flight across the board fetches an original for every card
// it sweeps past, each costing a full decode of the master.
test("a camera moving without a pointer still defers originals", async () => {
  const plugin = createPluginHarness({
    selectedItems: imageItems(24),
    runAnimationFrames: true,
  });
  plugin.start();
  await flush();

  plugin.state.smoothPanEnabled = true;
  plugin.keyDown({
    key: "ArrowRight",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    target: null,
    preventDefault() {},
  });
  plugin.advanceClock(200);
  plugin.flushTimersUnder(1000);
  await flush();

  const card = plugin.elements.get("#world").children[0];
  const thumbnail = card.querySelector("img");
  assert.equal(thumbnail.src, "file:///image-0-thumb.jpg");

  thumbnail.emit("load");
  await flush();
  plugin.flushTimersUnder(1000);
  await flush();

  assert.equal(plugin.state.isPanning, false, "no pointer drag should be in play");
  assert.equal(
    card.querySelectorAll("img").length,
    1,
    "no original element should be created while the camera is flying",
  );
  assert.equal(card.dataset.mediaQuality, "thumbnail");

  // Stopping brings it back.
  plugin.windowEmit("keyup", { key: "ArrowRight" });
  plugin.flushTimersUnder(1000);
  await flush();

  assert.equal(card.querySelectorAll("img").length, 2, "the original should follow");
  assert.equal(card.dataset.mediaQuality, "loading-original");
});
